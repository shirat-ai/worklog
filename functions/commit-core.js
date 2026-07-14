// ─────────────────────────────────────────────────────────────────────────────
// commit-core.js — the SERVER-AUTHORITATIVE commit logic (Option B).
// This is the ONLY place a mutation is decided. It replaces the client _mergeKey.
// Pure + deterministic: it takes the current authoritative aggregate + a typed op
// and returns the next aggregate (or a CONFLICT). It runs INSIDE an RTDB
// transaction() in the Cloud Function, and is unit-tested in Node against a
// modeled transaction. NO browser ever runs this.
//
// Aggregate shape (RTDB node /entities/lecturers/{id}):
//   { id, entityVersion, deleted, deletedVer,
//     fields: { <name>: { v:<value>, ver:<int>, by:<uid>, at:<ms> }, ... },
//     _ops:   { <opId>: { status, resultVersion, at } },   // idempotency ledger (bounded)
//     _audit: { <eventId>: { immutable event } } }          // in-txn audit tail (bounded)
//
// Op shape (created by the client, decided here):
//   { opId, type:'CREATE_LECTURER'|'UPDATE_LECTURER_FIELDS'|'DELETE_LECTURER',
//     entityId, patch:{field:value,...}, baseFieldVersions:{field:ver,...},
//     baseEntityVersion, actor:{uid,role}, at }
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const OP_KEEP = 50;      // bounded idempotency ledger per aggregate
const AUDIT_KEEP = 50;   // bounded in-transaction audit tail per aggregate

function _prune(map, keep) {
  const keys = Object.keys(map || {});
  if (keys.length <= keep) return map;
  keys.sort();                 // opId/eventId are time-sortable (uuid-v7-ish / ts-prefixed)
  const drop = keys.slice(0, keys.length - keep);
  for (const k of drop) delete map[k];
  return map;
}

function _now(ctx) { var n = ctx && ctx.now; return (typeof n === 'function' ? n() : n) || 0; } // number (Function wrapper) OR fn (tests); never Date.now() in the pure core

// Result kinds returned to the Function wrapper:
//   {kind:'commit', entity}         -> write `entity` back atomically, ACK committed
//   {kind:'idempotent', result}     -> op already applied; ACK the stored result, no write
//   {kind:'conflict', code, server} -> do NOT mutate the field/entity; record conflict; ACK conflict
//   {kind:'error', code}            -> reject
function applyOperation(entity, op, ctx) {
  ctx = ctx || {};
  if (!op || !op.opId || !op.type || !op.entityId) return { kind: 'error', code: 'MALFORMED_OP' };

  // ── idempotency: dedupe is INSIDE the same atomic unit as the mutation ──
  if (entity && entity._ops && entity._ops[op.opId]) {
    return { kind: 'idempotent', result: entity._ops[op.opId] };
  }

  const at = _now(ctx);
  const auditId = 'a' + String(at).padStart(15, '0') + '_' + op.opId;

  switch (op.type) {
    case 'CREATE_LECTURER': {
      if (entity && !entity.deleted) return { kind: 'conflict', code: 'ALREADY_EXISTS', server: entity };
      const fields = {};
      for (const f of Object.keys(op.patch || {})) fields[f] = { v: op.patch[f], ver: 1, by: op.actor && op.actor.uid, at };
      const next = {
        id: op.entityId, entityVersion: 1, deleted: false, fields,
        _ops: { [op.opId]: { status: 'committed', resultVersion: 1, at } },
        _audit: { [auditId]: { op: op.opId, type: op.type, entityId: op.entityId, by: op.actor && op.actor.uid, role: op.actor && op.actor.role, at, fieldsAfter: Object.keys(fields), version: 1 } },
      };
      return { kind: 'commit', entity: next };
    }

    case 'UPDATE_LECTURER_FIELDS': {
      if (!entity || entity.deleted) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity || null };
      const patch = op.patch || {}, base = op.baseFieldVersions || {};
      const conflicted = [];
      for (const f of Object.keys(patch)) {
        const cur = (entity.fields && entity.fields[f]) || { ver: 0 };
        if (cur.ver !== base[f]) conflicted.push(f); // that specific field moved since the client read it
      }
      if (conflicted.length) {
        // Record the conflict in the idempotency ledger so a replay returns the SAME conflict,
        // but DO NOT touch the field values. The user must resolve explicitly (INV-2).
        const server = {};
        for (const f of conflicted) server[f] = entity.fields[f];
        entity._ops = entity._ops || {};
        entity._ops[op.opId] = { status: 'conflict', code: 'SAME_FIELD_CONFLICT', conflictedFields: conflicted, serverValues: server, resultVersion: entity.entityVersion, at };
        entity._audit = entity._audit || {};
        entity._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'SAME_FIELD_CONFLICT', entityId: op.entityId, fields: conflicted, by: op.actor && op.actor.uid, at, version: entity.entityVersion };
        _prune(entity._ops, OP_KEEP); _prune(entity._audit, AUDIT_KEEP);
        return { kind: 'commit', entity, conflict: { code: 'SAME_FIELD_CONFLICT', fields: conflicted, server } };
      }
      // apply ONLY the named fields (INV-1: siblings untouched, read from authoritative entity)
      const next = JSON.parse(JSON.stringify(entity));
      for (const f of Object.keys(patch)) {
        const curVer = (next.fields[f] && next.fields[f].ver) || 0;
        next.fields[f] = { v: patch[f], ver: curVer + 1, by: op.actor && op.actor.uid, at };
      }
      next.entityVersion = entity.entityVersion + 1;
      next._ops = next._ops || {};
      next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
      next._audit = next._audit || {};
      next._audit[auditId] = { op: op.opId, type: op.type, entityId: op.entityId, patch: Object.keys(patch), by: op.actor && op.actor.uid, role: op.actor && op.actor.role, at, version: next.entityVersion };
      _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
      return { kind: 'commit', entity: next };
    }

    case 'DELETE_LECTURER': {
      if (!entity) return { kind: 'idempotent', result: { status: 'committed', resultVersion: 0, note: 'already-absent' } };
      if (entity.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      if (op.baseEntityVersion !== entity.entityVersion) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity };
      const next = JSON.parse(JSON.stringify(entity));
      next.deleted = true; next.deletedVer = next.entityVersion + 1; next.entityVersion += 1;
      next._ops = next._ops || {};
      next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
      next._audit = next._audit || {};
      next._audit[auditId] = { op: op.opId, type: 'DELETE', entityId: op.entityId, by: op.actor && op.actor.uid, at, version: next.entityVersion };
      _prune(next._ops, OP_KEEP); _prune(next._audit, AUDIT_KEEP);
      return { kind: 'commit', entity: next };
    }

    default:
      return { kind: 'error', code: 'UNKNOWN_OP_TYPE' };
  }
}

// Projection: authoritative aggregate -> the plain lecturer object the UI renders.
function projectLecturer(entity) {
  if (!entity || entity.deleted) return null;
  const out = { id: entity.id, _entityVersion: entity.entityVersion, _fieldVersions: {} };
  for (const f of Object.keys(entity.fields || {})) { out[f] = entity.fields[f].v; out._fieldVersions[f] = entity.fields[f].ver; }
  return out;
}

module.exports = { applyOperation, projectLecturer, OP_KEEP, AUDIT_KEEP };
