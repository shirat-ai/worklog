// ─────────────────────────────────────────────────────────────────────────────
// commit-core-schedule.js — SERVER-AUTHORITATIVE commit logic for `scheduleSets`
// and the INV-15 fix (schedule = projection, single source of truth).
//
// v1 stored TWO persisted copies of the same data: `DB.schedule` (a map
// <dayKey> → { groups:[{name, rows:[{lectId,start,end,payHrs}]}] }) AND
// `DB.scheduleSets[i].data` (the same map per semester). `switchScheduleSet`
// (index.html:3368) did `cur.data = DB.schedule; DB.schedule = s.data` — an ALIAS
// swap. Two persisted sources of truth can DIVERGE, and a stale `DB.schedule` write
// can silently overwrite a whole semester (INV-15 violation). Groups were keyed by
// `name` and rows had no id → the same 07-09 whole-record-replace hazard as days.
//
// This core makes `entities/scheduleSets/{setId}` the SOLE source of truth, with
// stable group/row ids + per-row version CAS. `schedule` becomes a pure PROJECTION
// of the active set (projectSchedule) — it is NEVER persisted or client-written, so
// there is no second copy to diverge and no alias write to clobber a semester.
//
// Aggregate shape (/entities/scheduleSets/{setId}):
//   { id, entityVersion, deleted,
//     fields: { name:{v,ver,by,at} },
//     slots:  { <dayKey>: { groups: { <gid>:{ id,name,ver,deleted,
//                                             rows:{ <rid>:{id,ver,deleted,lectId,start,end,payHrs} } } } } },
//     _ops, _audit }
// The active-set pointer is a separate tiny record (scheduleMeta.activeSetId) handled
// by the generic collection core — switching active is a pointer update that NEVER
// copies slot data.
//
// Ops:
//   CREATE_SET        { setId(entityId), patch:{name}, slots? }
//   UPDATE_SET_FIELDS { entityId, patch:{name}, baseFieldVersions }
//   UPDATE_SLOT_ROW   { entityId, dayKey, groupId, rowId, patch, baseRowVersion }
//   ADD_SLOT_ROW      { entityId, dayKey, groupId, groupName, rowId, row }
//   REMOVE_SLOT_ROW   { entityId, dayKey, groupId, rowId, baseRowVersion }
//   DELETE_SET        { entityId, baseEntityVersion }
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const OP_KEEP = 50, AUDIT_KEEP = 50;
const ROW_FIELDS = ['lectId', 'start', 'end', 'payHrs', 'pay', 'courseName', 'note', 'ord']; // courseName: v1 schedule rows carry it (parity)

function _prune(map, keep) { const ks = Object.keys(map || {}); if (ks.length <= keep) return map; ks.sort(); for (const k of ks.slice(0, ks.length - keep)) delete map[k]; return map; }
function _now(ctx) { var n = ctx && ctx.now; return (typeof n === 'function' ? n() : n) || 0; } // accepts number (Function wrapper) OR fn (tests)
function _clone(x) { return JSON.parse(JSON.stringify(x)); }
function _auditId(at, opId) { return 'a' + String(at).padStart(15, '0') + '_' + opId; }

function applyScheduleOperation(entity, op, ctx) {
  ctx = ctx || {};
  if (!op || !op.opId || !op.type || !op.entityId) return { kind: 'error', code: 'MALFORMED_OP' };
  if (entity && entity._ops && entity._ops[op.opId]) return { kind: 'idempotent', result: entity._ops[op.opId] };
  const at = _now(ctx), auditId = _auditId(at, op.opId);
  const by = op.actor && op.actor.uid, role = op.actor && op.actor.role;

  switch (op.type) {
    case 'CREATE_SET': {
      if (entity && !entity.deleted) return { kind: 'conflict', code: 'ALREADY_EXISTS', server: entity };
      const fields = {};
      for (const f of Object.keys(op.patch || {})) fields[f] = { v: op.patch[f], ver: 1, by, at };
      const slots = _buildSlots(op.slots);
      const next = { id: op.entityId, entityVersion: 1, deleted: false, fields, slots,
        _ops: { [op.opId]: { status: 'committed', resultVersion: 1, at } },
        _audit: { [auditId]: { op: op.opId, type: op.type, entityId: op.entityId, by, role, at, version: 1 } } };
      return { kind: 'commit', entity: next };
    }
    case 'UPDATE_SET_FIELDS': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const patch = op.patch || {}, base = op.baseFieldVersions || {}, conflicted = [];
      for (const f of Object.keys(patch)) { const cur = (entity.fields && entity.fields[f]) || { ver: 0 }; if (cur.ver !== base[f]) conflicted.push(f); }
      if (conflicted.length) return _fieldConflict(entity, op, conflicted, at, auditId, by);
      const next = _clone(entity);
      for (const f of Object.keys(patch)) { const cv = (next.fields[f] && next.fields[f].ver) || 0; next.fields[f] = { v: patch[f], ver: cv + 1, by, at }; }
      return _bump(next, op, at, auditId, by, role, { patch: Object.keys(patch) });
    }
    case 'UPDATE_SLOT_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const row = _row(entity, op.dayKey, op.groupId, op.rowId);
      if (!row || row.deleted) return { kind: 'conflict', code: 'REMOVE_VS_UPDATE', server: entity };
      if (op.baseRowVersion !== undefined && row.ver !== op.baseRowVersion) return _rowConflict(entity, op, at, auditId, by, row);
      const next = _clone(entity);
      const nr = next.slots[op.dayKey].groups[op.groupId].rows[op.rowId];
      for (const f of Object.keys(op.patch || {})) if (ROW_FIELDS.includes(f)) nr[f] = op.patch[f];
      nr.ver = row.ver + 1; nr.by = by; nr.at = at;
      return _bump(next, op, at, auditId, by, role, { dayKey: op.dayKey, row: op.rowId });
    }
    case 'ADD_SLOT_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      if (!op.rowId || !op.dayKey || !op.groupId) return { kind: 'error', code: 'MALFORMED_OP' };
      const ex = _row(entity, op.dayKey, op.groupId, op.rowId);
      if (ex && !ex.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      const next = _clone(entity);
      next.slots = next.slots || {};
      next.slots[op.dayKey] = next.slots[op.dayKey] || { groups: {} };
      const groups = next.slots[op.dayKey].groups;
      if (!groups[op.groupId]) groups[op.groupId] = { id: op.groupId, name: op.groupName, ver: 1, deleted: false, rows: {} };
      groups[op.groupId].deleted = false; groups[op.groupId].rows = groups[op.groupId].rows || {};
      const rd = {}; for (const f of Object.keys(op.row || {})) if (ROW_FIELDS.includes(f)) rd[f] = op.row[f];
      groups[op.groupId].rows[op.rowId] = { id: op.rowId, ver: 1, deleted: false, by, at, ...rd };
      return _bump(next, op, at, auditId, by, role, { dayKey: op.dayKey, addRow: op.rowId });
    }
    case 'REMOVE_SLOT_ROW': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const row = _row(entity, op.dayKey, op.groupId, op.rowId);
      if (!row || row.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion, note: 'already-absent' } };
      if (op.baseRowVersion !== undefined && row.ver !== op.baseRowVersion) return _rowConflict(entity, op, at, auditId, by, row, 'REMOVE_VS_UPDATE');
      const next = _clone(entity);
      const nr = next.slots[op.dayKey].groups[op.groupId].rows[op.rowId];
      nr.deleted = true; nr.ver = row.ver + 1; nr.by = by; nr.at = at;
      return _bump(next, op, at, auditId, by, role, { dayKey: op.dayKey, removeRow: op.rowId });
    }
    case 'DELETE_SET': {
      if (!entity) return { kind: 'idempotent', result: { status: 'committed', resultVersion: 0, note: 'already-absent' } };
      if (entity.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      if (op.baseEntityVersion !== undefined && op.baseEntityVersion !== entity.entityVersion) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity };
      const next = _clone(entity);
      next.deleted = true; next.deletedVer = next.entityVersion + 1; next.entityVersion += 1;
      next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
      next._audit = next._audit || {}; next._audit[auditId] = { op: op.opId, type: 'DELETE_SET', entityId: op.entityId, by, at, version: next.entityVersion };
      _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
      return { kind: 'commit', entity: next };
    }
    default: return { kind: 'error', code: 'UNKNOWN_OP_TYPE' };
  }
}

function _buildSlots(slotsInput) {
  const slots = {};
  for (const dayKey of Object.keys(slotsInput || {})) {
    const groups = {};
    (slotsInput[dayKey].groups || []).forEach(grp => {
      if (!grp || !grp.id) return;
      const rows = {};
      (grp.rows || []).forEach(r => { if (!r || !r.id) return; const { id: rid, ...rest } = r; rows[rid] = { id: rid, ver: 1, deleted: false, ...rest }; });
      groups[grp.id] = { id: grp.id, name: grp.name, ver: 1, deleted: false, rows };
    });
    slots[dayKey] = { groups };
  }
  return slots;
}
function _row(entity, dayKey, groupId, rowId) {
  const slot = entity.slots && entity.slots[dayKey];
  const grp = slot && slot.groups && slot.groups[groupId];
  return grp && !grp.deleted && grp.rows && grp.rows[rowId];
}
function _bump(next, op, at, auditId, by, role, extra) {
  next.entityVersion = (next.entityVersion || 0) + 1;
  next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
  next._audit = next._audit || {}; next._audit[auditId] = Object.assign({ op: op.opId, type: op.type, entityId: op.entityId, by, role, at, version: next.entityVersion }, extra || {});
  _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
  return { kind: 'commit', entity: next };
}
function _fieldConflict(entity, op, conflicted, at, auditId, by) {
  const server = {}; for (const f of conflicted) server[f] = entity.fields[f];
  entity._ops = entity._ops || {}; entity._audit = entity._audit || {};
  entity._ops[op.opId] = { status: 'conflict', code: 'SAME_FIELD_CONFLICT', conflictedFields: conflicted, resultVersion: entity.entityVersion, at };
  entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'SAME_FIELD_CONFLICT', entityId: op.entityId, fields: conflicted, by, at, version: entity.entityVersion };
  _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
  return { kind: 'commit', entity, conflict: { code: 'SAME_FIELD_CONFLICT', fields: conflicted, server } };
}
function _rowConflict(entity, op, at, auditId, by, row, code) {
  code = code || 'SAME_ROW_CONFLICT';
  entity._ops = entity._ops || {}; entity._audit = entity._audit || {};
  entity._ops[op.opId] = { status: 'conflict', code, dayKey: op.dayKey, groupId: op.groupId, rowId: op.rowId, resultVersion: entity.entityVersion, at };
  entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code, entityId: op.entityId, dayKey: op.dayKey, rowId: op.rowId, by, at, version: entity.entityVersion };
  _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
  return { kind: 'commit', entity, conflict: { code, dayKey: op.dayKey, rowId: op.rowId } };
}

// INV-15 PROJECTION: derive the v1 `DB.schedule` shape from a set aggregate. This is
// the ONLY way the UI gets `schedule` — it is computed, never stored/written back.
function projectSchedule(entity) {
  if (!entity || entity.deleted) return null;
  const out = {};
  const dayKeys = Object.keys(entity.slots || {}).sort();
  for (const dk of dayKeys) {
    const groups = [];
    const gids = Object.keys(entity.slots[dk].groups || {}).sort();
    for (const gid of gids) {
      const g = entity.slots[dk].groups[gid];
      if (g.deleted) continue;
      const rows = [];
      const rids = Object.keys(g.rows || {}).sort();
      for (const rid of rids) { const r = g.rows[rid]; if (r.deleted) continue; const { ver, deleted, id, by, at, ...rest } = r; rows.push(rest); }
      groups.push({ name: g.name, rows });
    }
    out[dk] = { groups };
  }
  return out;
}
// Full projected set (with ids/versions, for building ops)
function projectSet(entity) {
  if (!entity || entity.deleted) return null;
  const out = { id: entity.id, _entityVersion: entity.entityVersion, _fieldVersions: {}, slots: {} };
  for (const f of Object.keys(entity.fields || {})) { out[f] = entity.fields[f].v; out._fieldVersions[f] = entity.fields[f].ver; }
  for (const dk of Object.keys(entity.slots || {})) {
    const groups = [];
    for (const gid of Object.keys(entity.slots[dk].groups || {}).sort()) {
      const g = entity.slots[dk].groups[gid]; if (g.deleted) continue;
      const rows = [];
      for (const rid of Object.keys(g.rows || {}).sort()) { const r = g.rows[rid]; if (r.deleted) continue; const { ver, deleted, ...rest } = r; rows.push(Object.assign({}, rest, { _ver: ver })); }
      groups.push({ id: g.id, name: g.name, _ver: g.ver, rows });
    }
    out.slots[dk] = { groups };
  }
  return out;
}

module.exports = { applyScheduleOperation, projectSchedule, projectSet, OP_KEEP, AUDIT_KEEP };
