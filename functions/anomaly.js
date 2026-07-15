// anomaly.js — small, hard, testable server-side anomaly containment. Pure decision helpers
// (the Cloud Function supplies the persisted per-uid burst state + writes the freeze/alert).
// Goal: cap the blast radius of ANY client bug in a MANUAL-entry system. (incident 2026-07-15)
'use strict';
const CFG = require('./anomaly-config.js');

// ── per-uid rolling-window burst breaker ──────────────────────────────────────────────────
// state = { windowStart, count, entities:[...] }. Call step() on every accepted op; if it
// returns tripped=true the op is REFUSED and the aggregate is frozen.
function burstStep(prev, entityId, nowMs, cfg) {
  cfg = cfg || CFG;
  let s = (prev && typeof prev.windowStart === 'number' && (nowMs - prev.windowStart) < cfg.BURST_WINDOW_MS)
    ? { windowStart: prev.windowStart, count: prev.count || 0, entities: Array.isArray(prev.entities) ? prev.entities : [] }
    : { windowStart: nowMs, count: 0, entities: [] };
  s.count += 1;
  if (entityId && s.entities.indexOf(entityId) === -1) s.entities.push(entityId);
  if (s.entities.length > 500) s.entities = s.entities.slice(-500);       // bound the array
  const tripped = s.count > cfg.MAX_OPS_PER_WINDOW || s.entities.length > cfg.MAX_ENTITIES_PER_WINDOW;
  const reason = tripped ? (s.count > cfg.MAX_OPS_PER_WINDOW ? 'BURST_OPS' : 'BURST_ENTITIES') : null;
  return { state: s, tripped, reason };
}

// ── semantic row-cap: a single day can never legitimately hold this many rows ──────────────
// `entity` is the stored days entity (or null); returns true if applying the ADD_ROW would
// exceed the cap.
function rowCapExceeded(entity, cfg) {
  cfg = cfg || CFG;
  if (!entity || !entity.groups) return false;
  let n = 0;
  for (const gid of Object.keys(entity.groups)) { const g = entity.groups[gid]; if (g && !g.deleted && g.rows) for (const rid of Object.keys(g.rows)) if (!g.rows[rid].deleted) n++; }
  return n >= cfg.MAX_ROWS_PER_DAY;
}

// ── historical-days guard: normal manual entry does not restructure old days. A structural
// write (ADD_ROW / CREATE_DAY / REMOVE_ROW) to a day whose date is well in the past must carry
// an explicit privileged repair marker (op.repair === true, set only by the admin repair path).
function historicalDaysBlocked(op, route, nowMs, cfg) {
  cfg = cfg || CFG;
  if (!route || route.node !== 'days') return false;
  const structural = op && (op.type === 'ADD_ROW' || op.type === 'CREATE_DAY' || op.type === 'REMOVE_ROW');
  if (!structural) return false;
  if (op.repair === true) return false;                                   // explicit repair/import lane is allowed
  // derive the day's date: CREATE_DAY carries patch.date; others need the stored date (checked in the Fn).
  const date = op.patch && op.patch.date;
  if (!date) return false;                                                // unknown here → the Fn checks against stored entity
  const dayMs = Date.parse(date + 'T12:00:00Z');
  return !isNaN(dayMs) && (nowMs - dayMs) > (cfg.HISTORICAL_DAY_MS || 45 * 24 * 3600 * 1000);
}

module.exports = { burstStep, rowCapExceeded, historicalDaysBlocked, CFG };
