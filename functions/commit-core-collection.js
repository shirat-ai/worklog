// ─────────────────────────────────────────────────────────────────────────────
// commit-core-collection.js — GENERIC SERVER-AUTHORITATIVE commit logic for any
// FLAT collection of records (Option B). One aggregate PER RECORD at
// /entities/<collection>/<recordId>, with per-field version CAS — the exact
// lecturers pattern, generalised so the flat-collection victims reuse it without a
// bespoke core each:
//   • privateLessons  (records with a `privApproval` flag)
//   • miscPayments / manualPayments
//   • adminStaff / students / manualPayees
//
// WHY THIS STRUCTURALLY CLOSES THE COLLECTION WIPE:
//   v1 lost whole collections two ways — (a) the 07-09 _mergeKey empty-array branch
//   `return myVal` wrote an empty local array over the server (regression_mergeKey_
//   0709_empty_array_wipes_collection), and (b) a stale full-object write replaced
//   the whole collection child. Here the CLIENT NEVER WRITES THE COLLECTION. A record
//   is created/edited/deleted only via a typed, CAS-guarded op on that ONE record.
//   "My local collection is empty" therefore produces NO write at all — there is no
//   array-level path to wipe, and a concurrently-added record cannot be clobbered.
//
// Aggregate shape (/entities/<collection>/<recordId>):
//   { id, entityVersion, deleted, deletedVer,
//     fields: { <name>: { v, ver, by, at } },
//     _ops, _audit }
//
// Ops (record-scoped; `approvalField` lets a collection have an independent
// approval flag that never rolls back on a field edit — e.g. privApproval):
//   CREATE_RECORD        { opId, entityId, patch:{field:val} }
//   UPDATE_RECORD_FIELDS { opId, entityId, patch, baseFieldVersions }
//   SET_APPROVAL         { opId, entityId, approvalField, value, baseApprovalVersion }
//   DELETE_RECORD        { opId, entityId, baseEntityVersion }
//   (+ actor:{uid,role}, at)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const OP_KEEP = 50;
const AUDIT_KEEP = 50;

function _prune(map, keep) {
  const keys = Object.keys(map || {});
  if (keys.length <= keep) return map;
  keys.sort(); const drop = keys.slice(0, keys.length - keep);
  for (const k of drop) delete map[k];
  return map;
}
function _now(ctx) { return (ctx && ctx.now && ctx.now()) || 0; }
function _clone(x) { return JSON.parse(JSON.stringify(x)); }
function _auditId(at, opId) { return 'a' + String(at).padStart(15, '0') + '_' + opId; }

function applyRecordOperation(entity, op, ctx) {
  ctx = ctx || {};
  if (!op || !op.opId || !op.type || !op.entityId) return { kind: 'error', code: 'MALFORMED_OP' };
  if (entity && entity._ops && entity._ops[op.opId]) return { kind: 'idempotent', result: entity._ops[op.opId] };

  const at = _now(ctx);
  const auditId = _auditId(at, op.opId);
  const by = op.actor && op.actor.uid, role = op.actor && op.actor.role;

  switch (op.type) {
    case 'CREATE_RECORD': {
      if (entity && !entity.deleted) return { kind: 'conflict', code: 'ALREADY_EXISTS', server: entity };
      const fields = {};
      for (const f of Object.keys(op.patch || {})) fields[f] = { v: op.patch[f], ver: 1, by, at };
      const next = {
        id: op.entityId, entityVersion: 1, deleted: false, fields,
        _ops: { [op.opId]: { status: 'committed', resultVersion: 1, at } },
        _audit: { [auditId]: { op: op.opId, type: op.type, entityId: op.entityId, by, role, at, fieldsAfter: Object.keys(fields), version: 1 } },
      };
      return { kind: 'commit', entity: next };
    }

    case 'UPDATE_RECORD_FIELDS': {
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
        // A patch value of null means CLEAR-to-default: tombstone the field so the
        // projection omits it (projected as `undefined`, not `null`). This preserves
        // v1 "delete-on-zero" semantics (e.g. payOverrides.supplement, and reverting
        // any override to the computed default which calcLect reads via `!==undefined`).
        // A value of 0 is a real force-zero override and is KEPT as {v:0} (not cleared).
        if (patch[f] === null) next.fields[f] = { v: null, ver: curVer + 1, deleted: true, by, at };
        else next.fields[f] = { v: patch[f], ver: curVer + 1, by, at };
      }
      return _commitBump(next, op, at, auditId, by, role, { patch: Object.keys(patch) });
    }

    case 'SET_APPROVAL': {
      // An independent approval flag (e.g. privApproval) as its OWN versioned field →
      // a concurrent field edit never touches its version, so they commute (no rollback).
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const af = op.approvalField; if (!af) return { kind: 'error', code: 'MALFORMED_OP' };
      const curVer = (entity.fields[af] && entity.fields[af].ver) || 0;
      if (op.baseApprovalVersion !== undefined && op.baseApprovalVersion !== curVer) {
        return _recordFieldConflict(entity, op, [af], at, auditId, by);
      }
      const next = _clone(entity);
      next.fields[af] = { v: op.value, ver: curVer + 1, by, at };
      return _commitBump(next, op, at, auditId, by, role, { approval: af, value: op.value });
    }

    case 'DELETE_RECORD': {
      if (!entity) return { kind: 'idempotent', result: { status: 'committed', resultVersion: 0, note: 'already-absent' } };
      if (entity.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      if (op.baseEntityVersion !== undefined && op.baseEntityVersion !== entity.entityVersion) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity };
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

function _commitBump(next, op, at, auditId, by, role, auditExtra) {
  next.entityVersion = (next.entityVersion || 0) + 1;
  next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
  next._audit = next._audit || {}; next._audit[auditId] = Object.assign({ op: op.opId, type: op.type, entityId: op.entityId, by, role, at, version: next.entityVersion }, auditExtra || {});
  _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
  return { kind: 'commit', entity: next };
}

function _recordFieldConflict(entity, op, conflicted, at, auditId, by) {
  const server = {};
  for (const f of conflicted) server[f] = entity.fields[f];
  entity._ops = entity._ops || {}; entity._audit = entity._audit || {};
  entity._ops[op.opId] = { status: 'conflict', code: 'SAME_FIELD_CONFLICT', conflictedFields: conflicted, serverValues: server, resultVersion: entity.entityVersion, at };
  entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'SAME_FIELD_CONFLICT', entityId: op.entityId, fields: conflicted, by, at, version: entity.entityVersion };
  _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
  return { kind: 'commit', entity, conflict: { code: 'SAME_FIELD_CONFLICT', fields: conflicted, server } };
}

// Projection of ONE record -> plain object the UI renders (null if deleted).
function projectRecord(entity) {
  if (!entity || entity.deleted) return null;
  const out = { id: entity.id, _entityVersion: entity.entityVersion, _fieldVersions: {} };
  for (const f of Object.keys(entity.fields || {})) {
    const cell = entity.fields[f];
    out._fieldVersions[f] = cell.ver;       // keep the version even for a cleared field (so a base read still CAS-guards)
    if (cell.deleted) continue;             // cleared-to-default: omit the value (projected as undefined, not null) — a force-zero {v:0} is NOT deleted and is kept
    out[f] = cell.v;
  }
  return out;
}

// Projection of a whole collection sub-tree -> the array the UI renders. Deleted
// records drop out. This is a PROJECTION; the collection array is never persisted or
// client-written, so it can never be pushed back to wipe the server.
function projectCollection(collectionNode) {
  const out = [];
  const ids = Object.keys(collectionNode || {}).sort();
  for (const id of ids) { const r = projectRecord(collectionNode[id]); if (r) out.push(r); }
  return out;
}

module.exports = { applyRecordOperation, projectRecord, projectCollection, OP_KEEP, AUDIT_KEEP };
