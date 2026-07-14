// ─────────────────────────────────────────────────────────────────────────────
// commit-core-days.js — SERVER-AUTHORITATIVE commit logic for the `days` aggregate
// (Option B). Sibling of commit-core.js (lecturers). Pure + deterministic: takes the
// current authoritative day aggregate + a typed op and returns the next aggregate (or
// a CONFLICT). Runs INSIDE an RTDB transaction() in the Cloud Function; unit-tested in
// Node. NO browser ever runs this. It REPLACES the client _mergeKey, whose whole-record
// replace silently rolled back day approvals and dropped concurrent row edits.
//
// Why days needed its own core: a v1 day is nested (groups→rows) and, critically, v1
// groups were identified by `name` and rows had NO id — so the 07-09 merge could not
// merge by identity and fell to replacing the WHOLE day with a stale copy (approval
// rollback, sibling-row loss). Here EVERY group and EVERY row gets a stable id + a
// version, and `dayApproval` is its own versioned field, so:
//   • approving a day and editing a row COMMUTE (approval never rolls back),
//   • editing row A and row B COMMUTE,
//   • a stale removal cannot silently erase a fresh edit (it CONFLICTs, loudly).
//
// Aggregate shape (RTDB node /entities/days/{id}):
//   { id, entityVersion, deleted, deletedVer,
//     fields:  { <name>: { v, ver, by, at }, ... },   // date,dow,track,irregular,
//                                                       // dayApproval,payApproval,
//                                                       // principalNote,overQuota,enteredBy
//     groups:  { <gid>: { id, name, ver, deleted,
//                         rows: { <rid>: { id, ver, deleted, lectId, start, end,
//                                          payHrs, courseName, note } } } },
//     _ops:   { <opId>: {...} },   _audit: { <eventId>: {...} } }
//
// Op shape (created by the client, DECIDED here):
//   CREATE_DAY          { opId, entityId, patch:{field:val}, groups?:[{id,name,rows:[{id,...}]}] }
//   UPDATE_DAY_FIELDS   { opId, entityId, patch:{field:val}, baseFieldVersions:{field:ver} }
//   UPDATE_DAY_ROW      { opId, entityId, groupId, rowId, patch:{field:val}, baseRowVersion }
//   ADD_ROW             { opId, entityId, groupId, groupName, rowId, row:{field:val} }
//   REMOVE_ROW          { opId, entityId, groupId, rowId, baseRowVersion }
//   APPROVE_DAY         { opId, entityId, patch?:{principalNote}, baseApprovalVersion }
//   RETURN_DAY          { opId, entityId, patch:{principalNote}, baseApprovalVersion }
//   DELETE_DAY          { opId, entityId, baseEntityVersion }
//   (+ actor:{uid,role}, at — injected by the Function/ctx)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const OP_KEEP = 50;      // bounded idempotency ledger per aggregate
const AUDIT_KEEP = 50;   // bounded in-transaction audit tail per aggregate
const APPROVAL_FIELD = 'dayApproval';
const ROW_FIELDS = ['lectId', 'start', 'end', 'payHrs', 'pay', 'courseName', 'note', 'ord']; // whitelist for row patches

function _prune(map, keep) {
  const keys = Object.keys(map || {});
  if (keys.length <= keep) return map;
  keys.sort();
  const drop = keys.slice(0, keys.length - keep);
  for (const k of drop) delete map[k];
  return map;
}
function _now(ctx) { var n = ctx && ctx.now; return (typeof n === 'function' ? n() : n) || 0; } // number (Function wrapper) OR fn (tests); never Date.now() in the pure core
function _clone(x) { return JSON.parse(JSON.stringify(x)); }
function _auditId(at, opId) { return 'a' + String(at).padStart(15, '0') + '_' + opId; }

// Result kinds (identical contract to commit-core.js):
//   {kind:'commit', entity[, conflict]}  -> write entity; if entity._ops[opId].status==='conflict' the Function ACKs conflict
//   {kind:'idempotent', result}          -> op already applied; ACK stored result, no write
//   {kind:'conflict', code, server}      -> do NOT mutate; ACK conflict
//   {kind:'error', code}                 -> reject (validation)
function applyDayOperation(entity, op, ctx) {
  ctx = ctx || {};
  if (!op || !op.opId || !op.type || !op.entityId) return { kind: 'error', code: 'MALFORMED_OP' };

  // idempotency: dedupe is INSIDE the same atomic unit as the mutation
  if (entity && entity._ops && entity._ops[op.opId]) {
    return { kind: 'idempotent', result: entity._ops[op.opId] };
  }

  const at = _now(ctx);
  const auditId = _auditId(at, op.opId);
  const by = op.actor && op.actor.uid, role = op.actor && op.actor.role;

  switch (op.type) {
    case 'CREATE_DAY': {
      if (entity && !entity.deleted) return { kind: 'conflict', code: 'ALREADY_EXISTS', server: entity };
      const fields = {};
      for (const f of Object.keys(op.patch || {})) fields[f] = { v: op.patch[f], ver: 1, by, at };
      if (!fields[APPROVAL_FIELD]) fields[APPROVAL_FIELD] = { v: 'pending', ver: 1, by, at };
      const groups = {};
      (op.groups || []).forEach(grp => {
        if (!grp || !grp.id) return;
        const rows = {};
        (grp.rows || []).forEach(r => { if (!r || !r.id) return; const { id: rid, ...rest } = r; rows[rid] = { id: rid, ver: 1, deleted: false, ...rest }; });
        groups[grp.id] = { id: grp.id, name: grp.name, ver: 1, deleted: false, rows };
      });
      const next = {
        id: op.entityId, entityVersion: 1, deleted: false, fields, groups,
        _ops: { [op.opId]: { status: 'committed', resultVersion: 1, at } },
        _audit: { [auditId]: { op: op.opId, type: op.type, entityId: op.entityId, by, role, at, version: 1 } },
      };
      return { kind: 'commit', entity: next };
    }

    case 'UPDATE_DAY_FIELDS': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const patch = op.patch || {}, base = op.baseFieldVersions || {};
      const conflicted = [];
      for (const f of Object.keys(patch)) {
        const cur = (entity.fields && entity.fields[f]) || { ver: 0 };
        if (cur.ver !== base[f]) conflicted.push(f);
      }
      if (conflicted.length) return _recordFieldConflict(entity, op, conflicted, at, auditId, by);
      const next = _clone(entity);
      for (const f of Object.keys(patch)) {
        const curVer = (next.fields[f] && next.fields[f].ver) || 0;
        next.fields[f] = { v: patch[f], ver: curVer + 1, by, at };
      }
      return _commitBump(next, op, at, auditId, by, role, { patch: Object.keys(patch) });
    }

    case 'APPROVE_DAY':
    case 'RETURN_DAY':
    case 'UNAPPROVE_DAY': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const curVer = (entity.fields[APPROVAL_FIELD] && entity.fields[APPROVAL_FIELD].ver) || 0;
      // CAS on the approval field ONLY. A concurrent row edit does not touch this
      // version, so approve/return/unapprove and row edits commute — approval never
      // rolls back on a field edit. UNAPPROVE_DAY is the approved→pending path
      // (v1 unapproveDay:3348) that APPROVE/RETURN alone could not express.
      if (op.baseApprovalVersion !== undefined && op.baseApprovalVersion !== curVer) {
        return _recordFieldConflict(entity, op, [APPROVAL_FIELD], at, auditId, by);
      }
      const next = _clone(entity);
      const target = op.type === 'APPROVE_DAY' ? 'approved' : (op.type === 'RETURN_DAY' ? 'returned' : 'pending');
      next.fields[APPROVAL_FIELD] = { v: target, ver: curVer + 1, by, at };
      // UNAPPROVE clears the principal note (v1 behavior); APPROVE/RETURN set it if provided.
      if (op.type === 'UNAPPROVE_DAY') {
        const pv = (next.fields.principalNote && next.fields.principalNote.ver) || 0;
        next.fields.principalNote = { v: '', ver: pv + 1, by, at };
      } else if (op.patch && op.patch.principalNote !== undefined) {
        const pv = (next.fields.principalNote && next.fields.principalNote.ver) || 0;
        next.fields.principalNote = { v: op.patch.principalNote, ver: pv + 1, by, at };
      }
      return _commitBump(next, op, at, auditId, by, role, { approval: target });
    }

    case 'UPDATE_DAY_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const grp = entity.groups && entity.groups[op.groupId];
      const row = grp && !grp.deleted && grp.rows && grp.rows[op.rowId];
      if (!row || row.deleted) return { kind: 'conflict', code: 'REMOVE_VS_UPDATE', server: entity };
      if (op.baseRowVersion !== undefined && row.ver !== op.baseRowVersion) {
        return _recordRowConflict(entity, op, at, auditId, by, { curRow: row });
      }
      const next = _clone(entity);
      const nr = next.groups[op.groupId].rows[op.rowId];
      for (const f of Object.keys(op.patch || {})) { if (ROW_FIELDS.includes(f)) nr[f] = op.patch[f]; }
      nr.ver = row.ver + 1; nr.by = by; nr.at = at;
      return _commitBump(next, op, at, auditId, by, role, { row: op.rowId, group: op.groupId });
    }

    case 'ADD_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      if (!op.rowId) return { kind: 'error', code: 'MALFORMED_OP' };
      const existing = entity.groups && entity.groups[op.groupId] && entity.groups[op.groupId].rows && entity.groups[op.groupId].rows[op.rowId];
      if (existing && !existing.deleted) {
        // same rowId already present → treat as idempotent add (client retried)
        return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      }
      const next = _clone(entity);
      next.groups = next.groups || {};
      if (!next.groups[op.groupId]) next.groups[op.groupId] = { id: op.groupId, name: op.groupName, ver: 1, deleted: false, rows: {} };
      const g = next.groups[op.groupId];
      g.deleted = false; g.rows = g.rows || {};
      const rowData = {}; for (const f of Object.keys(op.row || {})) { if (ROW_FIELDS.includes(f)) rowData[f] = op.row[f]; }
      g.rows[op.rowId] = { id: op.rowId, ver: 1, deleted: false, by, at, ...rowData };
      return _commitBump(next, op, at, auditId, by, role, { addRow: op.rowId, group: op.groupId });
    }

    case 'REMOVE_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const grp = entity.groups && entity.groups[op.groupId];
      const row = grp && grp.rows && grp.rows[op.rowId];
      if (!row || row.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity ? entity.entityVersion : 0, note: 'already-absent' } };
      // A stale removal (someone edited the row since you read it) must NOT silently
      // erase that edit — surface a loud conflict instead (INV: no silent loss).
      if (op.baseRowVersion !== undefined && row.ver !== op.baseRowVersion) {
        return _recordRowConflict(entity, op, at, auditId, by, { curRow: row, code: 'REMOVE_VS_UPDATE' });
      }
      const next = _clone(entity);
      const nr = next.groups[op.groupId].rows[op.rowId];
      nr.deleted = true; nr.ver = row.ver + 1; nr.by = by; nr.at = at;
      return _commitBump(next, op, at, auditId, by, role, { removeRow: op.rowId, group: op.groupId });
    }

    case 'DELETE_DAY': {
      if (!entity) return { kind: 'idempotent', result: { status: 'committed', resultVersion: 0, note: 'already-absent' } };
      if (entity.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      if (op.baseEntityVersion !== entity.entityVersion) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity };
      const next = _clone(entity);
      next.deleted = true; next.deletedVer = next.entityVersion + 1; next.entityVersion += 1;
      next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
      next._audit = next._audit || {}; next._audit[auditId] = { op: op.opId, type: 'DELETE', entityId: op.entityId, by, at, version: next.entityVersion };
      _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
      return { kind: 'commit', entity: next };
    }

    default:
      return { kind: 'error', code: 'UNKNOWN_OP_TYPE' };
  }
}

// ── shared commit tail: bump entityVersion, record idempotency ledger + audit ──
function _commitBump(next, op, at, auditId, by, role, auditExtra) {
  next.entityVersion = (next.entityVersion || 0) + 1;
  next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
  next._audit = next._audit || {}; next._audit[auditId] = Object.assign({ op: op.opId, type: op.type, entityId: op.entityId, by, role, at, version: next.entityVersion }, auditExtra || {});
  _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
  return { kind: 'commit', entity: next };
}

// ── field-level conflict: record it (so a replay returns the SAME conflict) but do
//    NOT touch the field values; the user must resolve explicitly (INV-2). ──
function _recordFieldConflict(entity, op, conflicted, at, auditId, by) {
  const server = {};
  for (const f of conflicted) server[f] = entity.fields[f];
  entity._ops = entity._ops || {};
  entity._ops[op.opId] = { status: 'conflict', code: 'SAME_FIELD_CONFLICT', conflictedFields: conflicted, serverValues: server, resultVersion: entity.entityVersion, at };
  entity._audit = entity._audit || {};
  entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'SAME_FIELD_CONFLICT', entityId: op.entityId, fields: conflicted, by, at, version: entity.entityVersion };
  _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
  return { kind: 'commit', entity, conflict: { code: 'SAME_FIELD_CONFLICT', fields: conflicted, server } };
}

// ── row-level conflict: same principle, keyed by the row identity ──
function _recordRowConflict(entity, op, at, auditId, by, extra) {
  const code = (extra && extra.code) || 'SAME_ROW_CONFLICT';
  entity._ops = entity._ops || {};
  entity._ops[op.opId] = { status: 'conflict', code, groupId: op.groupId, rowId: op.rowId, serverRow: (extra && extra.curRow) || null, resultVersion: entity.entityVersion, at };
  entity._audit = entity._audit || {};
  entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code, entityId: op.entityId, groupId: op.groupId, rowId: op.rowId, by, at, version: entity.entityVersion };
  _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
  return { kind: 'commit', entity, conflict: { code, groupId: op.groupId, rowId: op.rowId } };
}

// Projection: authoritative aggregate -> the plain day object the UI renders.
// groups/rows come back as ARRAYS (v1 shape), ordered by their stable id (ids are
// time-sortable, so insertion order is preserved). Deleted rows/groups are dropped.
function projectDay(entity) {
  if (!entity || entity.deleted) return null;
  const out = { id: entity.id, _entityVersion: entity.entityVersion, _fieldVersions: {} };
  for (const f of Object.keys(entity.fields || {})) { out[f] = entity.fields[f].v; out._fieldVersions[f] = entity.fields[f].ver; }
  const groups = [];
  const gids = Object.keys(entity.groups || {}).sort();
  for (const gid of gids) {
    const g = entity.groups[gid];
    if (g.deleted) continue;
    const rows = [];
    const rids = Object.keys(g.rows || {}).sort();
    for (const rid of rids) {
      const r = g.rows[rid];
      if (r.deleted) continue;
      const { ver, deleted, ...rest } = r;
      rows.push(Object.assign({}, rest, { _ver: ver }));
    }
    groups.push({ id: g.id, name: g.name, _ver: g.ver, rows });
  }
  out.groups = groups;
  return out;
}

module.exports = { applyDayOperation, projectDay, OP_KEEP, AUDIT_KEEP };
