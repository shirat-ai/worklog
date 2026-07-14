// ─────────────────────────────────────────────────────────────────────────────
// dispatch.js — the SERVER-SIDE operation router + authorization matrix (Option B).
// Pure + deterministic + unit-tested; used by BOTH the Cloud Function
// (functions-index.js) and dispatch.test.js. For a client op it decides:
//   • is the op type known?                         (allowlist — no arbitrary types)
//   • which commit-core applies it?                 (fixed routing table)
//   • which RTDB entities node is its txn root?     (validated path components; NO
//                                                     client-provided arbitrary paths)
//   • is the caller's role allowed?                 (explicit authorization matrix;
//                                                     privileged ops are manager-only)
// It NEVER trusts a client-provided path. entityId / collection become RTDB ref keys,
// so they are validated against Firebase's key rules + an allowlist. Everything else
// (dayKey/groupId/rowId/patch) is DATA applied by the pure core inside the aggregate
// value — never a ref path — so it cannot cause path traversal.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { applyOperation } = require('./commit-core.js');
const { applyDayOperation } = require('./commit-core-days.js');
const { applyAdminHoursOperation } = require('./commit-core-adminHours.js');
const { applyRecordOperation } = require('./commit-core-collection.js');
const { applyScheduleOperation } = require('./commit-core-schedule.js');

const CORES = {
  lecturers: applyOperation,
  days: applyDayOperation,
  adminHours: applyAdminHoursOperation,
  collection: applyRecordOperation,
  schedule: applyScheduleOperation,
};

// Collections that the generic per-record core serves. An op with op.collection MUST
// name one of these — nothing else may become an entities/<node> path.
const COLLECTION_ALLOWLIST = new Set([
  'privateLessons', 'miscPayments', 'manualPayments', 'manualPayees',
  'adminStaff', 'students', 'payables', 'lockedMonths', 'scheduleMeta',
]);

// op.type → { coreKey, node (fixed) | fromCollection:true, privileged? }
// privileged = manager-only (destructive/structural/lock/restore/financial-reopen).
const ROUTES = {
  // lecturers
  CREATE_LECTURER: { coreKey: 'lecturers', node: 'lecturers' },
  UPDATE_LECTURER_FIELDS: { coreKey: 'lecturers', node: 'lecturers' },
  DELETE_LECTURER: { coreKey: 'lecturers', node: 'lecturers', privileged: true },
  // days
  CREATE_DAY: { coreKey: 'days', node: 'days' },
  UPDATE_DAY_FIELDS: { coreKey: 'days', node: 'days' },
  UPDATE_DAY_ROW: { coreKey: 'days', node: 'days' },
  ADD_ROW: { coreKey: 'days', node: 'days' },
  REMOVE_ROW: { coreKey: 'days', node: 'days' },
  APPROVE_DAY: { coreKey: 'days', node: 'days' },
  RETURN_DAY: { coreKey: 'days', node: 'days' },
  UNAPPROVE_DAY: { coreKey: 'days', node: 'days' },
  DELETE_DAY: { coreKey: 'days', node: 'days', privileged: true },
  // adminHours
  SET_DAY_HOURS: { coreKey: 'adminHours', node: 'adminHours' },
  REMOVE_DAY: { coreKey: 'adminHours', node: 'adminHours' },
  APPROVE_MONTH: { coreKey: 'adminHours', node: 'adminHours' },
  UNAPPROVE_MONTH: { coreKey: 'adminHours', node: 'adminHours' },
  IMPORT_APPLY: { coreKey: 'adminHours', node: 'adminHours' },
  SET_META_FIELD: { coreKey: 'adminHours', node: 'adminHours' },
  REPLACE_MONTH: { coreKey: 'adminHours', node: 'adminHours', privileged: true }, // destructive whole-month replace
  DELETE_MONTH: { coreKey: 'adminHours', node: 'adminHours', privileged: true },
  // schedule sets
  CREATE_SET: { coreKey: 'schedule', node: 'scheduleSets' },
  UPDATE_SET_FIELDS: { coreKey: 'schedule', node: 'scheduleSets' },
  UPDATE_SLOT_ROW: { coreKey: 'schedule', node: 'scheduleSets' },
  ADD_SLOT_ROW: { coreKey: 'schedule', node: 'scheduleSets' },
  REMOVE_SLOT_ROW: { coreKey: 'schedule', node: 'scheduleSets' },
  DELETE_SET: { coreKey: 'schedule', node: 'scheduleSets', privileged: true }, // structural destructive
  // generic flat-collection record ops (node = validated op.collection)
  CREATE_RECORD: { coreKey: 'collection', fromCollection: true },
  UPDATE_RECORD_FIELDS: { coreKey: 'collection', fromCollection: true },
  SET_APPROVAL: { coreKey: 'collection', fromCollection: true },
  DELETE_RECORD: { coreKey: 'collection', fromCollection: true, privilegedOnCollections: ['lockedMonths'] }, // unlock = manager-only
};

// Firebase RTDB keys may not contain . # $ [ ] / and must be non-empty. We also cap
// length and forbid whitespace to keep ids clean.
const ILLEGAL_KEY = /[.#$/\[\]]/;
function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 512 && !ILLEGAL_KEY.test(k) && !/\s/.test(k);
}

// Resolve + validate an op to a concrete route, or an error code. Pure.
function routeOp(op) {
  if (!op || typeof op !== 'object') return { ok: false, code: 'MALFORMED_OP' };
  if (!op.opId || !validKey(op.opId)) return { ok: false, code: 'BAD_OPID' };
  if (!op.type || !Object.prototype.hasOwnProperty.call(ROUTES, op.type)) return { ok: false, code: 'UNKNOWN_OP_TYPE' };
  if (!op.entityId || !validKey(op.entityId)) return { ok: false, code: 'BAD_ENTITY_ID' };
  const r = ROUTES[op.type];
  let node = r.node;
  if (r.fromCollection) {
    if (!op.collection || !COLLECTION_ALLOWLIST.has(op.collection)) return { ok: false, code: 'BAD_COLLECTION' };
    node = op.collection;
  }
  if (!node || ILLEGAL_KEY.test(node)) return { ok: false, code: 'BAD_NODE' };
  const privileged = !!r.privileged || (Array.isArray(r.privilegedOnCollections) && r.privilegedOnCollections.includes(node));
  return { ok: true, node, coreKey: r.coreKey, core: CORES[r.coreKey], privileged, path: `entities/${node}/${op.entityId}` };
}

// Authorization matrix for the app's ACTUAL roles (anonymous auth + PIN → custom
// claim; the PIN is verified server-side by claimRole). Roles: principal (school
// principal = full manager), office (office manager), coord_m/coord_w (track
// coordinators — operational data entry), teacher (self-reports private lessons),
// staff (self-reports admin hours). `manager` is accepted as an alias of principal for
// the modeled tests. Privileged ops (destructive/lock/replace) are principal-only.
// This ENFORCES server-side what v1 only did with a client-side PIN (INV-13).
function authorize(role, route) {
  if (role === 'principal' || role === 'manager') return { ok: true };                 // full, incl. privileged
  if (role === 'office') return route.privileged ? { ok: false, code: 'FORBIDDEN_PRIVILEGED' } : { ok: true };
  if (route.privileged) return { ok: false, code: 'FORBIDDEN_PRIVILEGED' };             // below: no one else gets privileged
  if (role === 'coord_m' || role === 'coord_w') {
    // coordinators enter study days + admin hours (their operational domain)
    return (route.node === 'days' || route.node === 'adminHours') ? { ok: true } : { ok: false, code: 'FORBIDDEN_ROLE' };
  }
  if (role === 'teacher') {                                                             // DISABLED pending an identity-safe
    return { ok: false, code: 'TEACHER_DISABLED' };                                     // lecturer model (no real per-lecturer ownership yet)
  }
  if (role === 'staff') {                                                               // self-report admin hours only (ownership checked separately)
    return (route.node === 'adminHours') ? { ok: true } : { ok: false, code: 'FORBIDDEN_ROLE' };
  }
  return { ok: false, code: 'FORBIDDEN' };                                              // unknown / no role
}

// Per-record OWNERSHIP guard. Staff members self-report via passwordless email sign-in
// (each is a real identity mapped to an adminStaff record; claimRole stamps {role:'staff',
// staffId}). A staff member may write ONLY their own month bucket
// adminHours/<month>_<staffId> — never another staff member's or any other aggregate.
// All other roles are unconstrained by ownership (their capabilities are the authz
// matrix). Returns true if allowed.
function ownershipOk(role, claims, op, route) {
  if (role !== 'staff') return true;
  const staffId = claims && claims.staffId;
  if (!staffId || route.node !== 'adminHours') return false;
  // STRICT schema parse of the adminHours key `<YYYY-MM>_<staffId>` — NOT endsWith (which
  // suffers a suffix-collision: claim 's1' would match another staff's key '..._b_s1').
  // Validate month and staffId separately; staffId must equal the SIGNED claim EXACTLY.
  const id = typeof op.entityId === 'string' ? op.entityId : '';
  const m = /^(\d{4})-(\d{2})_(.+)$/.exec(id);
  if (!m) return false;                               // malformed entityId
  const mm = parseInt(m[2], 10);
  if (mm < 1 || mm > 12) return false;                // invalid month component
  return m[3] === String(staffId);                    // exact staffId match — no collision, no client-supplied authority
}

// Staff identity resolution: map a VERIFIED email-link email to EXACTLY ONE adminStaff
// record. This is the sole authority for a staff member's staffId — the client never
// supplies it. 0 matches → not staff; >1 → LOUD ambiguous failure (never pick arbitrarily,
// which could hand one person another's hours). Pure + unit-tested; used by claimRole.
function resolveStaffByEmail(adminStaff, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false, code: 'EMAIL_REQUIRED' };
  const list = Array.isArray(adminStaff) ? adminStaff : Object.values(adminStaff || {});
  const matches = list.filter(s => s && s.id && String(s.email || '').trim().toLowerCase() === e);
  if (matches.length === 0) return { ok: false, code: 'EMAIL_NOT_STAFF' };
  if (matches.length > 1) return { ok: false, code: 'EMAIL_AMBIGUOUS' };
  return { ok: true, staffId: matches[0].id };
}

module.exports = { routeOp, authorize, ownershipOk, resolveStaffByEmail, validKey, CORES, ROUTES, COLLECTION_ALLOWLIST };
