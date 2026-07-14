// ─────────────────────────────────────────────────────────────────────────────
// functions/index.js — DEPLOYABLE Cloud Function commit authority (Option B).
// The ONLY writer of /entities, /auditLog. Uses the Admin SDK (bypasses Security
// Rules), so the atomic CAS is done by ref.transaction() here; rules only firewall
// the client (deny direct writes; see rules-v2.json). The routing + authorization +
// path validation is the shared, unit-tested dispatch.js; the commit decision is the
// shared, unit-tested commit-core*.js. This wrapper is intentionally thin.
//
// Deploy: functions/index.js of a Firebase Functions project on shirat1 (Blaze).
//   `firebase deploy --only functions`. Requires App Check enforcement + Firebase
//   Auth + a server-set /roles node. NEVER auto-deployed from an agent session.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const functions = require('firebase-functions/v1');            // v1 API for the RTDB audit triggers
const { onRequest } = require('firebase-functions/v2/https');   // Gen2 HTTP — matches the org's working pattern (shirat-core)
const { setGlobalOptions } = require('firebase-functions/v2');
setGlobalOptions({ region: 'me-west1' });                       // same region as the existing working Gen2 functions
const admin = require('firebase-admin');
admin.initializeApp();
const { routeOp, authorize, ownershipOk } = require('./dispatch.js');

const DB_ROOT = 'shirat_v2';   // legacy shirat_v1 stays read-only during migration

// HTTP function submitOperation, invoked via a Firebase Hosting REWRITE (/__submitOp).
// Why onRequest + Hosting rewrite instead of onCall: the shirat.net org enforces
// Domain Restricted Sharing (iam.allowedPolicyMemberDomains), which forbids granting
// `allUsers` the invoker role — so a public callable is impossible. A Hosting rewrite
// invokes this function with Firebase Hosting's own (org-permitted) managed identity,
// same-origin, needing no `allUsers`. App Check + Firebase Auth are verified MANUALLY
// here from request headers — identical security to onCall, org-policy-compatible.
// Contract: POST JSON { op }, headers Authorization: Bearer <idToken> +
// X-Firebase-AppCheck: <token>. Returns the same ACK JSON the outbox expects.
exports.submitOperation = onRequest(async (req, res) => {
  // same-origin via Hosting rewrite; reflect origin + handle preflight defensively
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, X-Firebase-AppCheck, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ status: 'validation', code: 'METHOD_NOT_ALLOWED' });

  try {
    // 1) App Check — verify the token manually (equivalent to onCall's context.app).
    const appCheckTok = req.header('X-Firebase-AppCheck');
    if (!appCheckTok) return res.status(401).json({ status: 'unauthorized', code: 'APP_CHECK_REQUIRED' });
    try { await admin.appCheck().verifyToken(appCheckTok); }
    catch (e) { return res.status(401).json({ status: 'unauthorized', code: 'APP_CHECK_INVALID' }); }

    // 2) Firebase Auth — verify the ID token. The app uses ANONYMOUS auth (no stable
    //    per-user identity), so the ROLE travels as a CUSTOM CLAIM set by claimRole
    //    after server-side PIN verification. The token is signed by Firebase Auth, so
    //    the claim cannot be forged (this is the real INV-13 fix: authorization is
    //    server-enforced, not the old client-side PIN).
    const m = /^Bearer (.+)$/.exec(req.header('Authorization') || '');
    if (!m) return res.status(401).json({ status: 'unauthorized', code: 'UNAUTHENTICATED' });
    let uid, role, claims;
    try { const decoded = await admin.auth().verifyIdToken(m[1]); uid = decoded.uid; role = decoded.role; claims = decoded; }
    catch (e) { return res.status(401).json({ status: 'unauthorized', code: 'UNAUTHENTICATED' }); }

    const op = req.body && req.body.op;

    // 3) Route + validate (allowlist type/collection, validate path components — NO
    //    arbitrary client paths, no traversal). One route or a hard reject.
    const route = routeOp(op);
    if (!route.ok) return res.status(400).json({ status: 'validation', code: route.code });

    // 4) Server-side authorization: the role capability matrix (privileged=principal
    //    only) PLUS per-record ownership (a staff member may write only their own
    //    adminHours/<month>_<staffId> — enforced from the signed staffId claim).
    const authz = authorize(role, route);
    if (!authz.ok) return res.status(403).json({ status: 'forbidden', code: authz.code });
    if (!ownershipOk(role, claims, op, route)) return res.status(403).json({ status: 'forbidden', code: 'NOT_OWN_DATA' });

    // 5) Atomic CAS + dedupe + audit in ONE transaction on the resolved aggregate root.
    const ref = admin.database().ref(`${DB_ROOT}/${route.path}`);   // entities/<node>/<entityId>, both validated
    const nowMs = Date.now();
    let outcome = null;
    const txn = await ref.transaction((entity) => {
      const r = route.core(entity, { ...op, actor: { uid, role } }, { now: nowMs });
      outcome = r;
      if (r.kind === 'commit') return r.entity;   // write back atomically
      return;                                     // abort (idempotent/conflict/error): entity unchanged
    }, undefined, /* applyLocally */ false);

    if (!txn.committed && outcome && outcome.kind === 'commit') {
      return res.status(503).json({ status: 'transient', code: 'CONTENTION' }); // real non-ACK (INV-4): client retries
    }

    // 6) Consistent ACK contract (identical for every aggregate).
    if (outcome.kind === 'commit') {
      const stored = outcome.entity._ops[op.opId];
      if (stored && stored.status === 'conflict') return res.status(200).json({ status: 'conflict', conflict: outcome.conflict, resultVersion: stored.resultVersion });
      return res.status(200).json({ status: 'committed', resultVersion: outcome.entity.entityVersion });
    }
    if (outcome.kind === 'idempotent') return res.status(200).json({ status: outcome.result.status === 'conflict' ? 'conflict' : 'committed', resultVersion: outcome.result.resultVersion, replayed: true });
    if (outcome.kind === 'conflict') return res.status(200).json({ status: 'conflict', conflict: { code: outcome.code }, resultVersion: outcome.server ? outcome.server.entityVersion : 0 });
    return res.status(400).json({ status: 'validation', code: outcome.code || 'rejected' });
  } catch (e) {
    console.error('submitOperation error', e);
    return res.status(500).json({ status: 'transient', code: 'INTERNAL' });
  }
});

// claimRole — server-side PIN verification → Firebase Auth custom claim { role }.
// The app signs in ANONYMOUSLY; the user picks a role + enters a PIN. This verifies the
// PIN against the server-held codes (shirat_v1/codes, read via Admin — never trusting
// the client) and, if correct, stamps a signed `role` claim on the caller's token.
// The client then refreshes its ID token (getIdToken(true)) and submitOperation reads
// the role from that claim. Reached via the Hosting rewrite /__claimRole (same pattern
// as submitOperation). teacher needs no PIN (self-report only).
exports.claimRole = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, X-Firebase-AppCheck, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ status: 'validation', code: 'METHOD_NOT_ALLOWED' });
  try {
    const appCheckTok = req.header('X-Firebase-AppCheck');
    if (!appCheckTok) return res.status(401).json({ status: 'unauthorized', code: 'APP_CHECK_REQUIRED' });
    try { await admin.appCheck().verifyToken(appCheckTok); } catch (e) { return res.status(401).json({ status: 'unauthorized', code: 'APP_CHECK_INVALID' }); }
    const m = /^Bearer (.+)$/.exec(req.header('Authorization') || '');
    if (!m) return res.status(401).json({ status: 'unauthorized', code: 'UNAUTHENTICATED' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(m[1]); } catch (e) { return res.status(401).json({ status: 'unauthorized', code: 'UNAUTHENTICATED' }); }
    const uid = decoded.uid;

    const role = req.body && req.body.role;
    const pin = req.body && req.body.pin;
    const ROLES = { principal: 1, office: 1, coord_m: 1, coord_w: 1, staff: 1, teacher: 1 };
    if (!ROLES[role]) return res.status(400).json({ status: 'validation', code: 'BAD_ROLE' });

    let claims = { role };
    if (role === 'staff') {
      // Staff self-report: identity = the VERIFIED email from passwordless (email-link)
      // sign-in, mapped to an adminStaff record. No shared PIN — each staff member is a
      // distinct identity and (enforced in submitOperation) may edit only their own hours.
      const email = String(decoded.email || '').toLowerCase();
      if (!email || decoded.email_verified !== true) return res.status(403).json({ status: 'forbidden', code: 'EMAIL_REQUIRED' });
      const raw = (await admin.database().ref('shirat_v1/adminStaff').once('value')).val() || [];
      const list = Array.isArray(raw) ? raw : Object.values(raw);
      const staff = list.find(function (s) { return s && String(s.email || '').toLowerCase() === email; });
      if (!staff || !staff.id) return res.status(403).json({ status: 'forbidden', code: 'EMAIL_NOT_STAFF' });
      claims = { role: 'staff', staffId: staff.id };
    } else if (role !== 'teacher') {                            // teacher = no PIN; principal/office/coord = PIN
      const codes = (await admin.database().ref('shirat_v1/codes').once('value')).val() || {};
      const expected = role === 'coord_m' ? (codes.coord_m || '1234')
        : role === 'coord_w' ? (codes.coord_w || '5678')
        : role === 'office' ? (codes.office || '9999')
        : codes.principal;                                      // principal
      if (!expected || String(pin) !== String(expected)) return res.status(403).json({ status: 'forbidden', code: 'BAD_PIN' });
    }
    await admin.auth().setCustomUserClaims(uid, claims);        // signed role (+staffId) claim
    return res.status(200).json({ status: 'ok', role: claims.role, staffId: claims.staffId }); // client: getIdToken(true)
  } catch (e) {
    console.error('claimRole error', e);
    return res.status(500).json({ status: 'transient', code: 'INTERNAL' });
  }
});

// Immutable audit fan-out: every aggregate's in-txn _audit tail → a global append-only
// /auditLog, idempotent by eventId (a re-run for the same event is a no-op create).
// One trigger per migrated node (wildcard {id} = entityId). Add a block per aggregate
// as it is migrated; the body is identical.
function auditTrigger(node) {
  return functions.database.ref(`${DB_ROOT}/entities/${node}/{id}/_audit/{eventId}`)
    .onCreate(async (snap, ctx) => {
      const ev = snap.val();
      await admin.database().ref(`${DB_ROOT}/auditLog/${ctx.params.eventId}`).transaction(cur => (cur === null ? ev : undefined));
    });
}
exports.fanoutAudit_lecturers = auditTrigger('lecturers');
exports.fanoutAudit_days = auditTrigger('days');
exports.fanoutAudit_adminHours = auditTrigger('adminHours');
exports.fanoutAudit_privateLessons = auditTrigger('privateLessons');
exports.fanoutAudit_miscPayments = auditTrigger('miscPayments');
exports.fanoutAudit_manualPayments = auditTrigger('manualPayments');
exports.fanoutAudit_adminStaff = auditTrigger('adminStaff');
exports.fanoutAudit_students = auditTrigger('students');
exports.fanoutAudit_payables = auditTrigger('payables');
exports.fanoutAudit_lockedMonths = auditTrigger('lockedMonths');
exports.fanoutAudit_scheduleSets = auditTrigger('scheduleSets');
exports.fanoutAudit_scheduleMeta = auditTrigger('scheduleMeta');
