// ─────────────────────────────────────────────────────────────────────────────
// commit-core-adminHours.js — SERVER-AUTHORITATIVE commit logic for the
// `adminHours` aggregate (Option B). Sibling of commit-core.js / commit-core-days.js.
//
// v1 stored adminHours as ONE plain map `<month>_<staffId>` → { <dayKey>: value },
// with a parallel `adminHoursStatus` approval flag. Two proven loss vectors killed it:
//   1. AI/Excel import did `DB.adminHours[key] = parsed.days` (index.html:1209) — a
//      WHOLE-MONTH REPLACE that silently destroys every day not in the sheet
//      (single-user, single-action loss).
//   2. The 07-09 _mergeKey object shallow-merge overwrote the whole month object on a
//      concurrent edit, dropping the other day (regression_admin_hours_month_replace_
//      loses_other_day).
// Here EACH DAY is a versioned cell and `status` is a versioned field, so day edits
// commute, approval never rolls back, import defaults to SAFE MERGE (never touches a
// day it didn't bring), and the only destructive whole-month REPLACE is PRIVILEGED +
// AUDITED and preceded by a preview/diff.
//
// Aggregate shape (RTDB node /entities/adminHours/{month_staff}):
//   { id, entityVersion, deleted,
//     status: { v:'pending'|'approved', ver, by, at },
//     days:   { <dayKey>: { v:<slots|number>, ver, by, at } },
//     _ops, _audit }
//
// Ops:
//   SET_DAY_HOURS   { entityId, dayKey, value, baseDayVersion }     — per-day CAS
//   REMOVE_DAY      { entityId, dayKey, baseDayVersion }            — per-day CAS clear
//   APPROVE_MONTH   { entityId, baseStatusVersion }                 — status field CAS
//   UNAPPROVE_MONTH { entityId, baseStatusVersion }
//   IMPORT_APPLY    { entityId, importedDays:{dayKey:value}, mode:'merge' }  — SAFE default
//   REPLACE_MONTH   { entityId, importedDays }                      — DESTRUCTIVE, manager-only (authZ in Function)
//   (+ actor:{uid,role}, at)
//
// Preview (pure, no write): diffImport(entity, importedDays) → {added,changed,unchanged,removed}
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
function _now(ctx) { var n = ctx && ctx.now; return (typeof n === 'function' ? n() : n) || 0; } // accepts number (Function wrapper) OR fn (tests)
function _clone(x) { return JSON.parse(JSON.stringify(x)); }
function _auditId(at, opId) { return 'a' + String(at).padStart(15, '0') + '_' + opId; }
function _eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function applyAdminHoursOperation(entity, op, ctx) {
  ctx = ctx || {};
  if (!op || !op.opId || !op.type || !op.entityId) return { kind: 'error', code: 'MALFORMED_OP' };
  if (entity && entity._ops && entity._ops[op.opId]) return { kind: 'idempotent', result: entity._ops[op.opId] };

  const at = _now(ctx);
  const auditId = _auditId(at, op.opId);
  const by = op.actor && op.actor.uid, role = op.actor && op.actor.role;
  const ensure = (e) => { const n = e ? _clone(e) : { id: op.entityId, entityVersion: 0, deleted: false, status: { v: 'pending', ver: 0, at }, days: {}, meta: {}, _ops: {}, _audit: {} }; n.days = n.days || {}; n.meta = n.meta || {}; n.status = n.status || { v: 'pending', ver: 0, at }; return n; };

  switch (op.type) {
    case 'SET_DAY_HOURS': {
      if (!op.dayKey) return { kind: 'error', code: 'MALFORMED_OP' };
      const cur = (entity && entity.days && entity.days[op.dayKey]) || { ver: 0 };
      if (op.baseDayVersion !== undefined && cur.ver !== op.baseDayVersion) {
        return _recordDayConflict(entity || ensure(null), op, at, auditId, by, cur);
      }
      const next = ensure(entity);
      next.days[op.dayKey] = { v: op.value, ver: (cur.ver || 0) + 1, by, at };
      return _commitBump(next, op, at, auditId, by, role, { setDay: op.dayKey });
    }

    case 'REMOVE_DAY': {
      const cur = entity && entity.days && entity.days[op.dayKey];
      if (!cur) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity ? entity.entityVersion : 0, note: 'already-absent' } };
      if (op.baseDayVersion !== undefined && cur.ver !== op.baseDayVersion) {
        return _recordDayConflict(entity, op, at, auditId, by, cur);
      }
      const next = _clone(entity);
      delete next.days[op.dayKey];
      return _commitBump(next, op, at, auditId, by, role, { removeDay: op.dayKey });
    }

    case 'APPROVE_MONTH':
    case 'UNAPPROVE_MONTH': {
      const curVer = (entity && entity.status && entity.status.ver) || 0;
      // CAS on the status field ONLY → a concurrent day edit never touches it, so
      // approve/unapprove and day edits commute (no approval rollback).
      if (op.baseStatusVersion !== undefined && op.baseStatusVersion !== curVer) {
        return _recordStatusConflict(entity || ensure(null), op, at, auditId, by);
      }
      const next = ensure(entity);
      next.status = { v: op.type === 'APPROVE_MONTH' ? 'approved' : 'pending', ver: curVer + 1, by, at };
      return _commitBump(next, op, at, auditId, by, role, { status: next.status.v });
    }

    case 'SET_META_FIELD': {
      // Month-level + per-day META (mode, totalOverride, globalAmount, override_<day>,
      // travel_<day>, note_<day>) — per-key version CAS, independent of the hours cells
      // and of `status`, so a meta edit commutes with a day-hours edit (no false loss).
      // A total-affecting money field (globalAmount/override) lives here and is never
      // silently dropped on migration (the parity gap this closes).
      if (!op.metaKey) return { kind: 'error', code: 'MALFORMED_OP' };
      const cur = (entity && entity.meta && entity.meta[op.metaKey]) || { ver: 0 };
      if (op.baseMetaVersion !== undefined && cur.ver !== op.baseMetaVersion) {
        const e = entity || ensure(null);
        e._ops = e._ops || {}; e._audit = e._audit || {};
        e._ops[op.opId] = { status: 'conflict', code: 'META_CONFLICT', metaKey: op.metaKey, serverValue: cur.v, resultVersion: e.entityVersion, at };
        e._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'META_CONFLICT', entityId: op.entityId, metaKey: op.metaKey, by, at, version: e.entityVersion };
        _prune(e._ops, OP_KEEP); _prune(e._audit, AUDIT_KEEP);
        return { kind: 'commit', entity: e, conflict: { code: 'META_CONFLICT', metaKey: op.metaKey } };
      }
      const next = ensure(entity);
      if (op.value === null || op.value === undefined) {
        // clear-to-default: tombstone the meta key (bump ver so a stale writer conflicts)
        next.meta[op.metaKey] = { v: null, ver: (cur.ver || 0) + 1, deleted: true, by, at };
      } else {
        next.meta[op.metaKey] = { v: op.value, ver: (cur.ver || 0) + 1, by, at };
      }
      return _commitBump(next, op, at, auditId, by, role, { setMeta: op.metaKey });
    }

    case 'IMPORT_APPLY': {
      // SAFE MERGE default: set ONLY the imported days; every other day is preserved.
      const mode = op.mode || 'merge';
      if (mode !== 'merge') return { kind: 'error', code: 'IMPORT_MODE_NOT_MERGE' }; // replace must use REPLACE_MONTH
      const next = ensure(entity);
      const imported = op.importedDays || {};
      let changed = 0;
      for (const k of Object.keys(imported)) {
        const cur = next.days[k] || { ver: 0 };
        if (_eq(cur.v, imported[k])) continue; // no-op day
        next.days[k] = { v: imported[k], ver: (cur.ver || 0) + 1, by, at }; changed++;
      }
      // imports also carry per-day/month meta (travelDays/notes/overrides/mode) — merge
      // them the same safe way (set the named meta keys; leave the rest untouched).
      const importedMeta = op.meta || {};
      for (const mk of Object.keys(importedMeta)) {
        const cur = next.meta[mk] || { ver: 0 };
        if (_eq(cur.v, importedMeta[mk])) continue;
        next.meta[mk] = { v: importedMeta[mk], ver: (cur.ver || 0) + 1, by, at };
      }
      return _commitBump(next, op, at, auditId, by, role, { importMerge: Object.keys(imported).length, changedDays: changed, importMeta: Object.keys(importedMeta).length });
    }

    case 'REPLACE_MONTH': {
      // DESTRUCTIVE whole-month replace. AuthZ (manager-only) is enforced in the
      // Function; here we execute it and AUDIT how many days it removes.
      const before = (entity && entity.days) ? Object.keys(entity.days) : [];
      const imported = op.importedDays || {};
      const removed = before.filter(k => !(k in imported));
      const next = ensure(entity);
      const newDays = {};
      for (const k of Object.keys(imported)) {
        const cur = (entity && entity.days && entity.days[k]) || { ver: 0 };
        newDays[k] = { v: imported[k], ver: (cur.ver || 0) + 1, by, at };
      }
      next.days = newDays;
      return _commitBump(next, op, at, auditId, by, role, { type: 'REPLACE_MONTH', importedDays: Object.keys(imported).length, removedDays: removed.length, removedKeys: removed });
    }

    case 'DELETE_MONTH': {
      if (!entity) return { kind: 'idempotent', result: { status: 'committed', resultVersion: 0, note: 'already-absent' } };
      if (entity.deleted) return { kind: 'idempotent', result: { status: 'committed', resultVersion: entity.entityVersion } };
      if (op.baseEntityVersion !== undefined && op.baseEntityVersion !== entity.entityVersion) return { kind: 'conflict', code: 'DELETE_VS_UPDATE', server: entity };
      const next = _clone(entity);
      next.deleted = true; next.deletedVer = next.entityVersion + 1; next.entityVersion += 1;
      next._ops = next._ops || {}; next._ops[op.opId] = { status: 'committed', resultVersion: next.entityVersion, at };
      next._audit = next._audit || {}; next._audit[auditId] = { op: op.opId, type: 'DELETE_MONTH', entityId: op.entityId, by, at, version: next.entityVersion };
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

function _recordDayConflict(entity, op, at, auditId, by, curCell) {
  const e = entity;
  e._ops = e._ops || {}; e._audit = e._audit || {};
  e._ops[op.opId] = { status: 'conflict', code: 'SAME_DAY_CONFLICT', dayKey: op.dayKey, serverValue: curCell ? curCell.v : undefined, resultVersion: e.entityVersion, at };
  e._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'SAME_DAY_CONFLICT', entityId: op.entityId, dayKey: op.dayKey, by, at, version: e.entityVersion };
  _prune(e._ops, OP_KEEP); _prune(e._audit, AUDIT_KEEP);
  return { kind: 'commit', entity: e, conflict: { code: 'SAME_DAY_CONFLICT', dayKey: op.dayKey } };
}

function _recordStatusConflict(entity, op, at, auditId, by) {
  const e = entity;
  e._ops = e._ops || {}; e._audit = e._audit || {};
  e._ops[op.opId] = { status: 'conflict', code: 'STATUS_CONFLICT', serverValue: e.status && e.status.v, resultVersion: e.entityVersion, at };
  e._audit[auditId] = { op: op.opId, type: 'CONFLICT', code: 'STATUS_CONFLICT', entityId: op.entityId, by, at, version: e.entityVersion };
  _prune(e._ops, OP_KEEP); _prune(e._audit, AUDIT_KEEP);
  return { kind: 'commit', entity: e, conflict: { code: 'STATUS_CONFLICT' } };
}

// Pure preview: what an import WOULD do vs the current month. No write. This is the
// diff the UI shows so the user sees exactly what a REPLACE would remove before it runs.
function diffImport(entity, importedDays) {
  const cur = (entity && entity.days) || {};
  const imported = importedDays || {};
  const added = [], changed = [], unchanged = [], removed = [];
  for (const k of Object.keys(imported)) {
    if (!(k in cur)) added.push(k);
    else if (_eq(cur[k].v, imported[k])) unchanged.push(k);
    else changed.push(k);
  }
  for (const k of Object.keys(cur)) if (!(k in imported)) removed.push(k);
  return { added, changed, unchanged, removed };
}

// Projection: authoritative aggregate -> the plain month object the UI renders.
// The flat v1 month object is reconstructed by the client adapter as:
//   DB.adminHours[key] = { ...projected.days (numeric day keys),
//                          mode, _total, _totalOverride, _globalAmount,
//                          _overrides:{day:v}, _travelDays:{day:v}, _notes:{day:v} }
//   DB.adminHoursStatus[key] = (projected.status === 'approved') ? 'approved' : absent
// so no month-level or per-day meta is dropped (the parity gap).
function projectAdminMonth(entity) {
  if (!entity || entity.deleted) return null;
  const out = { id: entity.id, _entityVersion: entity.entityVersion, status: entity.status ? entity.status.v : 'pending', _statusVersion: entity.status ? entity.status.ver : 0, days: {}, _dayVersions: {}, meta: {}, _metaVersions: {} };
  for (const k of Object.keys(entity.days || {})) { out.days[k] = entity.days[k].v; out._dayVersions[k] = entity.days[k].ver; }
  // flatten meta: month-level scalars (mode/totalOverride/globalAmount/total) + per-day
  // maps (override_<day>/travel_<day>/note_<day>) -> _overrides/_travelDays/_notes
  const perDay = { override: '_overrides', travel: '_travelDays', note: '_notes' };
  for (const key of Object.keys(entity.meta || {})) {
    const cell = entity.meta[key];
    if (!cell || cell.deleted) continue;                 // tombstoned = cleared to default
    out._metaVersions[key] = cell.ver;
    const us = key.indexOf('_');
    const prefix = us > 0 ? key.slice(0, us) : key;
    if (us > 0 && perDay[prefix]) {
      const day = key.slice(us + 1);
      const target = perDay[prefix];
      out.meta[target] = out.meta[target] || {};
      out.meta[target][day] = cell.v;
    } else {
      // month-level scalar: mode, totalOverride->_totalOverride, globalAmount->_globalAmount, total->_total
      const flat = (key === 'mode') ? 'mode' : ('_' + key);
      out.meta[flat] = cell.v;
    }
  }
  return out;
}

module.exports = { applyAdminHoursOperation, projectAdminMonth, diffImport, OP_KEEP, AUDIT_KEEP };
