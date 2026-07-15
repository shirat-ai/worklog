// anomaly-config.js — ONE place for all anomaly-containment thresholds. This is a MANUAL
// data-entry system: a user enters one record / one day / one row / one change per action.
// A large or old BURST of operations is therefore an anomaly, not a workload — so we cap the
// blast radius of ANY bug (known or unknown) with conservative limits tuned to real usage.
// (incident 2026-07-15: a single stale saveDB produced 376 ADD_ROW ops across 37 days.)
'use strict';

module.exports = {
  // client generation: the server refuses ops created by a build below this (STALE_CLIENT_GENERATION).
  MIN_CLIENT_GEN: 2,

  // ── OUTBOX (client, on load) — the FIRST line of defence: a large/old pending queue is
  //    quarantined and NEVER auto-replayed (this is what stops the 376-op batch before any
  //    of it is sent). Real life: a handful of pending ops that flush within seconds.
  OUTBOX_MAX_PENDING: 25,          // > this many pending ops on load ⇒ quarantine the whole queue
  OUTBOX_MAX_AGE_MS: 60 * 60 * 1000, // an op older than 1h ⇒ stale ⇒ quarantine (the 376 were ~15h old)

  // ── SERVER burst circuit-breaker (defence-in-depth, per authenticated uid, rolling window).
  //    Catches a runaway client that sends live (not via a stale outbox). On trip, the RELEVANT
  //    aggregate is frozen (not the whole system) and an alert is written.
  BURST_WINDOW_MS: 15 * 1000,
  MAX_OPS_PER_WINDOW: 40,          // one uid may commit at most N ops / 15s (a full day = ~10 rows)
  MAX_ENTITIES_PER_WINDOW: 12,     // …touching at most N DISTINCT entities / 15s (manual = ~1)

  // ── SEMANTIC guard on structural growth of a single day (the doubling was ADD_ROW spam).
  MAX_ROWS_PER_DAY: 60,            // a day with more rows than this is rejected (real max ~15)

  // ── HISTORICAL-days guard: a structural change to a day older than this, via the NORMAL
  //    (non-repair) path, is blocked — manual entry doesn't restructure old days in bulk.
  HISTORICAL_DAY_MS: 45 * 24 * 60 * 60 * 1000,

  // when an aggregate is frozen by an anomaly, ONLY that node is blocked; clearing is a manual
  // admin action (delete shirat_v2/_frozen/<node>). Alerts live at shirat_v2/_alerts.
};
