const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const service = require("../services/veriff.service");
const { isUae, normalizePhone, phonePattern, normalizeDecision, decisionOutcome, isStaleDecision } = require("../utils/veriffPolicy");
const { createController } = require("../controllers/veriffController");

const config = { apiKey: "test-key", sharedSecret: "local-test-secret", mode: "live", keyHash: "key-hash", webhookType: "decision" };
const sessionId = "e779b84b-44ac-47df-8a2a-7bc0d1d21a8c";
const reference = "79024007-c92a-4afd-9649-6f94461c3e98";
const fixture = (patch = {}) => ({
  status: "success", verification: {
    id: sessionId, vendorData: reference, status: "approved", code: 9001,
    decisionTime: "2026-10-20T12:00:00Z", document: { country: "IN", type: "PASSPORT" },
    person: { nationality: "IN" }, ...patch,
  },
});
const account = () => ({
  _id: "user-1", isVerified: true, isKycVerified: false, phone: "+91 98765 43210",
  nationality: "India", residenceCountry: "India", kycProvider: "veriff",
  veriff: { reference, sessionId, mode: "live", integrationKeyHash: "key-hash", status: "created", revision: 0 },
});
function signedRequest(payload = fixture()) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  return { body, headers: {
    "x-auth-client": config.apiKey,
    "x-hmac-signature": crypto.createHmac("sha256", config.sharedSecret).update(body).digest("hex"),
  } };
}
function response() {
  return { code: 200, data: null, headers: {}, status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; }, set(key, value) { this.headers[key] = value; return this; } };
}
function valueAt(object, key) { return key.split(".").reduce((value, part) => value?.[part], object); }
function matches(object, filter) {
  return Object.entries(filter).every(([key, wanted]) => {
    if (key === "$or") return wanted.some(item => matches(object, item));
    const actual = valueAt(object, key);
    if (wanted && typeof wanted === "object" && "$exists" in wanted) return (actual !== undefined) === wanted.$exists;
    return wanted == null ? actual == null : actual === wanted;
  });
}
function setAt(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key] ||= {}, object);
  parent[last] = value;
}
function modelFor(initial, { duplicate = false, conflict = false } = {}) {
  const state = { user: initial, writes: 0 };
  const query = value => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
  const model = {
    findById: () => query(structuredClone(state.user)),
    findOne: filter => query(state.user && matches(state.user, filter) ? structuredClone(state.user) : null),
    exists: async () => duplicate,
    findOneAndUpdate: async (filter, update) => {
      if (conflict || !state.user || !matches(state.user, filter)) return null;
      for (const [path, value] of Object.entries(update.$set || {})) setAt(state.user, path, value);
      for (const [path, value] of Object.entries(update.$inc || {})) setAt(state.user, path, (valueAt(state.user, path) || 0) + value);
      state.writes++;
      return structuredClone(state.user);
    },
    updateOne: async (filter, update) => model.findOneAndUpdate(filter, update),
  };
  return { model, state };
}
function controllerFor(user = account(), options = {}) {
  const database = modelFor(user, options);
  const veriff = { ...service, getConfig: () => ({ ...config, ...options.config }), isEnabled: () => true,
    getDecision: options.getDecision || (async () => null),
    getDecisionReason: options.getDecisionReason || (async () => null),
    createSession: options.createSession || (async () => ({ id: sessionId, url: "https://magic.veriff.me/test-session" })) };
  return { ...database, controller: createController({ users: database.model, veriff,
    ...(options.syncIB ? { syncIB: options.syncIB } : {}) }) };
}

test("HMAC authenticates exact raw bytes and rejects tampering or a wrong integration", () => {
  const req = signedRequest();
  assert.equal(service.authenticateWebhook(req.body, req.headers, config), true);
  assert.equal(service.authenticateWebhook(Buffer.from(req.body.toString().replace("approved", "declined")), req.headers, config), false);
  assert.equal(service.authenticateWebhook(JSON.parse(req.body), req.headers, config), false);
  assert.equal(service.authenticateWebhook(req.body, { ...req.headers, "x-auth-client": "other-key" }, config), false);
  assert.equal(service.authenticateWebhook(req.body, { ...req.headers, "x-hmac-signature": "invalid" }, config), false);
});

test("country aliases and formatted international phone numbers enforce the same policy", () => {
  for (const country of ["AE", "ARE", "U.A.E.", "United Arab Emirates"]) assert.equal(isUae(country), true);
  assert.equal(isUae("India"), false);
  assert.equal(normalizePhone("0091 98765-43210"), "+919876543210");
  assert.equal(normalizePhone("+91 (98765) 43210"), "+919876543210");
  assert.equal(normalizePhone("call 9876543210"), null);
  assert.equal(normalizePhone("123"), null);
  for (const phone of ["+91 98765 43210", "0091-98765-43210", "+919876543210"]) assert.match(phone, phonePattern("+919876543210"));
});

test("only a conclusive approved IDV decision with code 9001 is accepted", () => {
  assert.equal(normalizeDecision(fixture({ code: 9102 }), "decision"), null);
  assert.equal(normalizeDecision(fixture({ status: "submitted" }), "decision"), null);
  assert.equal(normalizeDecision(fixture({ decisionTime: null }), "decision"), null);
  assert.equal(normalizeDecision(fixture(), "fullauto"), null);
  assert.equal(normalizeDecision(fixture(), "decision").status, "approved");
});

test("Full Auto uses its own payload and extraction values", () => {
  const payload = { status: "success", eventType: "fullauto", sessionId, vendorData: reference,
    time: "2026-10-20T12:00:00Z", data: { verification: { decision: "approved",
      document: { country: { value: "IN" }, type: { value: "id_card" } } } } };
  const decision = normalizeDecision(payload, "fullauto");
  assert.equal(decision.id, sessionId);
  assert.equal(decisionOutcome(decision, account(), config, false).approved, true);
  assert.equal(normalizeDecision(payload, "decision"), null);
});

test("live approved decision enables KYC only for an eligible client", () => {
  const decision = normalizeDecision(fixture(), "decision");
  assert.equal(decisionOutcome(decision, account(), config, false).approved, true);
  for (const patch of [{ residenceCountry: "UAE" }, { nationality: "AE" }, { residenceCountry: "" }, { isVerified: false }]) {
    assert.equal(decisionOutcome(decision, { ...account(), ...patch }, config, false).approved, false);
  }
  for (const patch of [{ documentCountry: "AE" }, { nationality: "ARE" }, { documentCountry: null }]) {
    assert.equal(decisionOutcome({ ...decision, ...patch }, account(), config, false).approved, false);
  }
  assert.equal(decisionOutcome(decision, account(), config, true).status, "review");
});

test("live Veriff-approved document classes are accepted without a separate BDFX type whitelist", async () => {
  for (const type of ["DRIVERS_LICENSE", "RESIDENCE_PERMIT", "VISA", "OTHER", "GOVERNMENT_ISSUED_LETTER"]) {
    const { controller, state } = controllerFor();
    const res = response();
    await controller.decisionWebhook(signedRequest(fixture({ document: { country: "IN", type } })), res);
    assert.equal(res.code, 200); assert.equal(state.user.isKycVerified, true);
  }
});

test("status refresh reconciles an existing review from the same authenticated live approval", async () => {
  const user = account(); user.veriff.status = "review"; user.veriff.decisionAt = new Date("2026-10-20T12:00:00Z");
  const { controller, state } = controllerFor(user, { getDecision: async () => normalizeDecision(fixture({ document: { country: "IN", type: "DRIVERS_LICENSE" } }), "decision") });
  const res = response(); await controller.getStatus({ user: { id: "user-1" } }, res);
  assert.equal(res.data.approved, true); assert.equal(res.data.status, "approved");
  assert.equal(state.user.isKycVerified, true); assert.equal(state.writes, 1);
});

test("approval refresh preserves manual decisions, session ownership, country and duplicate-phone checks", async () => {
  const approved = normalizeDecision(fixture(), "decision");
  const cases = [
    { user: { nationality: "UAE" } }, { duplicate: true },
    { config: { mode: "test" } },
    { decision: { ...approved, reference: "different-account" } },
    { decision: { ...approved, id: "different-session" } },
    { decision: { ...approved, status: "declined" } },
    { decision: { ...approved, timestamp: Date.parse("2026-10-19T12:00:00Z") } },
    { user: { kycManualReview: { sessionId, approved: false } } },
    { conflict: true },
  ];
  for (const scenario of cases) {
    const user = { ...account(), ...scenario.user }; user.veriff.status = "review"; user.veriff.decisionAt = new Date("2026-10-20T12:00:00Z");
    const { controller, state } = controllerFor(user, { ...scenario, getDecision: async () => scenario.decision || approved });
    const res = response(); await controller.getStatus({ user: { id: "user-1" } }, res);
    assert.equal(res.data.approved, false); assert.equal(state.user.isKycVerified, false); assert.equal(state.writes, 0);
  }
});

test("owner sync requires the current session and cannot be used by a client", async () => {
  const user = account(); user._id = "a".repeat(24); user.veriff.status = "review";
  const { controller, state } = controllerFor(user, { getDecision: async () => normalizeDecision(fixture(), "decision") });
  const req = { principal: { isAdmin: true, adminRole: "owner" }, params: { userId: user._id }, body: { sessionId, expectedRevision: user.veriff.revision } };
  const denied = response(); await controller.syncStatus({ ...req, principal: { isAdmin: false } }, denied); assert.equal(denied.code, 403);
  const stale = response(); await controller.syncStatus({ ...req, body: { ...req.body, expectedRevision: 999 } }, stale); assert.equal(stale.code, 409); assert.equal(state.writes, 0);
  const res = response(); await controller.syncStatus(req, res); assert.equal(res.code, 200); assert.equal(res.data.approved, true);
  assert.equal(req.auditEvent, "kyc:provider-synced");
});

test("test-mode sessions and test-mode deployments never enable live KYC", () => {
  const decision = normalizeDecision(fixture(), "decision");
  assert.equal(decisionOutcome(decision, account(), { ...config, mode: "test" }, false).status, "test_approved");
  const user = account(); user.veriff.mode = "test";
  assert.equal(decisionOutcome(decision, user, config, false).approved, false);
});

test("non-approved outcomes remain unverified and resubmission has a useful message", () => {
  for (const status of ["declined", "review", "resubmission_requested", "expired", "abandoned"]) {
    const decision = normalizeDecision(fixture({ status }), "decision");
    assert.equal(decisionOutcome(decision, account(), config, false).approved, false);
    assert.equal(decisionOutcome(decision, account(), config, false).status, status);
  }
});

test("signed successful webhook atomically updates the client's KYC flag", async () => {
  const { controller, state } = controllerFor();
  const res = response();
  await controller.decisionWebhook(signedRequest(), res);
  assert.equal(res.code, 200);
  assert.equal(state.user.isKycVerified, true);
  assert.equal(state.user.hasSubmittedDocuments, true);
  assert.equal(state.user.veriff.status, "approved");
  assert.equal(state.writes, 1);
  assert.equal(state.user.veriff.document, undefined);
});

test("forged webhook cannot modify a client", async () => {
  const { controller, state } = controllerFor();
  const req = signedRequest(); req.headers["x-hmac-signature"] = "0".repeat(64);
  const res = response(); await controller.decisionWebhook(req, res);
  assert.equal(res.code, 401); assert.equal(state.writes, 0);
});

test("a signed decision for a different session cannot approve this client", async () => {
  const { controller, state } = controllerFor();
  const res = response(); await controller.decisionWebhook(signedRequest(fixture({ id: "different-session" })), res);
  assert.equal(res.code, 400); assert.equal(state.writes, 0);
});

test("unknown or replaced vendor reference is acknowledged without touching accounts", async () => {
  const { controller, state } = controllerFor();
  const res = response(); await controller.decisionWebhook(signedRequest(fixture({ vendorData: "old-reference" })), res);
  assert.equal(res.code, 200); assert.equal(state.writes, 0);
});

test("duplicate and delayed webhook deliveries do not reverse a final approval", async () => {
  const { controller, state } = controllerFor();
  await controller.decisionWebhook(signedRequest(), response());
  await controller.decisionWebhook(signedRequest(), response());
  await controller.decisionWebhook(signedRequest(fixture({ status: "resubmission_requested", decisionTime: "2026-10-20T12:01:00Z" })), response());
  assert.equal(state.writes, 1); assert.equal(state.user.isKycVerified, true);
  assert.equal(isStaleDecision({ status: "declined", timestamp: Date.parse("2026-10-20T11:00:00Z") }, state.user.veriff), true);
});

test("UAE documents and duplicate mobile checks block signed approvals", async () => {
  for (const options of [{ payload: fixture({ document: { country: "AE", type: "ID_CARD" } }) }, { duplicate: true }]) {
    const { controller, state } = controllerFor(account(), options);
    await controller.decisionWebhook(signedRequest(options.payload || fixture()), response());
    assert.equal(state.user.isKycVerified, false);
    assert.ok(["declined", "review"].includes(state.user.veriff.status));
  }
});

test("a concurrent update causes retry instead of losing a decision", async () => {
  const { controller, state } = controllerFor(account(), { conflict: true });
  const res = response(); await controller.decisionWebhook(signedRequest(), res);
  assert.equal(res.code, 503); assert.equal(state.writes, 0);
});

test("changed integration credentials cannot approve an existing session", async () => {
  const user = account(); user.veriff.integrationKeyHash = "old-key";
  const { controller, state } = controllerFor(user);
  const res = response(); await controller.decisionWebhook(signedRequest(), res);
  assert.equal(res.code, 400); assert.equal(state.writes, 0);
});

test("session creation resumes an existing link without making a second provider request", async () => {
  const user = account(); user.veriff.sessionUrl = "https://magic.veriff.me/existing"; user.veriff.sessionCreatedAt = new Date();
  const { controller } = controllerFor(user, { createSession: async () => { throw Error("Should not create a second session"); } });
  const res = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, res);
  assert.equal(res.code, 200); assert.equal(res.data.url, user.veriff.sessionUrl);
});

test("email-verification tokens and login tokens both identify their owner", async () => {
  const { controller } = controllerFor();
  for (const user of [{ id: "user-1" }, { userId: "user-1" }]) {
    const res = response(); await controller.getStatus({ user }, res);
    assert.equal(res.code, 200); assert.equal(res.data.approved, false);
    assert.equal(res.data.url, undefined); assert.equal(res.data.reference, undefined);
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
});

test("session creation fails closed for UAE residents and unverified email", async () => {
  for (const patch of [{ residenceCountry: "UAE" }, { isVerified: false }]) {
    const { controller, state } = controllerFor({ ...account(), ...patch });
    const res = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, res);
    assert.equal(res.code, 403); assert.equal(state.writes, 0);
  }
});

test("HTTPS Veriff URLs are required and lookalike hosts are rejected", () => {
  assert.equal(service.isVeriffUrl("https://stationapi.veriff.com/"), true);
  for (const url of ["http://veriff.com", "https://veriff.com.attacker.test", "https://user:password@veriff.com", "https://veriff.com:1234"]) {
    assert.equal(service.isVeriffUrl(url), false);
  }
});

test("new sessions persist correlation before provider calls and resume without duplicates", async () => {
  const user = account(); delete user.veriff;
  let calls = 0;
  const { controller, state } = controllerFor(user, { createSession: async ref => {
    calls++;
    assert.equal(state.user.veriff.reference, ref);
    return { id: sessionId, url: "https://magic.veriff.me/new-session" };
  } });
  const res = response();
  await controller.startSession({ user: { userId: "user-1" }, body: {} }, res);
  assert.equal(res.code, 201);
  assert.equal(state.user.veriff.status, "created");
  assert.equal(state.user.isKycVerified, false);
  await controller.startSession({ user: { id: "user-1" }, body: {} }, response());
  assert.equal(calls, 1);
});

test("a fast provider webhook cannot be overwritten by the later session response", async () => {
  const user = account(); delete user.veriff;
  const setup = controllerFor(user, { createSession: async ref => {
    const res = response();
    await setup.controller.decisionWebhook(signedRequest(fixture({ vendorData: ref })), res);
    assert.equal(res.code, 200);
    return { id: sessionId, url: "https://magic.veriff.me/fast-session" };
  } });
  const res = response(); await setup.controller.startSession({ user: { id: "user-1" }, body: {} }, res);
  assert.equal(res.code, 201);
  assert.equal(setup.state.user.isKycVerified, true);
  assert.equal(setup.state.user.veriff.status, "approved");
});

test("a failed provider call remains unapproved and does not expose provider error details", async () => {
  const user = account(); delete user.veriff;
  const { controller, state } = controllerFor(user, { createSession: async () => { throw new Error("private provider headers"); } });
  const res = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, res);
  assert.equal(res.code, 502);
  assert.equal(state.user.isKycVerified, false);
  assert.equal(state.user.veriff.status, "error");
  assert.doesNotMatch(JSON.stringify(res.data), /private provider headers/);
});

test("HTTP router preserves raw HMAC bytes and requires bearer authentication for status", async t => {
  const express = require("express");
  const { createRouter } = require("../routes/veriffRoutes");
  const { controller, state } = controllerFor();
  const app = express();
  app.use("/api/veriff", createRouter(controller));
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/veriff`;
  const req = signedRequest();
  const accepted = await fetch(`${base}/webhooks/decision`, { method: "POST", headers: { ...req.headers, "content-type": "application/json" }, body: req.body });
  assert.equal(accepted.status, 200);
  assert.equal(state.user.isKycVerified, true);
  const denied = await fetch(`${base}/status`);
  assert.equal(denied.status, 401);
});

test("legacy KYC handlers cannot override Veriff-managed clients", async t => {
  const User = require("../models/User");
  const auth = require("../controllers/authController");
  const originalFind = User.findOne;
  User.findOne = async () => account();
  t.after(() => { User.findOne = originalFind; });
  for (const handler of [auth.verifyKyc, auth.rejectUserKyc, auth.updateDocuments]) {
    const res = response();
    await handler({ params: { email: "synthetic@example.test" }, body: { status: true } }, res);
    assert.equal(res.code, 409);
  }
});

test("profile updates cannot write approval flags, session references, or credentials", async t => {
  const User = require("../models/User");
  const auth = require("../controllers/authController");
  const originalFind = User.findOne;
  const originalUpdate = User.findOneAndUpdate;
  let written;
  User.findOne = async () => account();
  User.findOneAndUpdate = async (filter, update) => { written = update.$set; return account(); };
  t.after(() => { User.findOne = originalFind; User.findOneAndUpdate = originalUpdate; });
  const res = response();
  await auth.updateUserProfile({ user: { userId: "user-1" }, params: { email: "synthetic@example.test" }, body: {
    city: "Mumbai", isKycVerified: true, kycProvider: "manual", veriff: { reference: "forged" }, password: "forged",
  } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(written, { city: "Mumbai" });
  const denied = response();
  await auth.updateUserProfile({ user: { id: "other-user" }, params: { email: "synthetic@example.test" }, body: { city: "Delhi" } }, denied);
  assert.equal(denied.code, 403);
});

test("retrying a committed identity decision retries IB approval without rewriting KYC", async () => {
  let attempts = 0;
  const { controller, state } = controllerFor(account(), { syncIB: async () => {
    if (++attempts === 1) throw Error("Synthetic IB transaction failure");
  } });
  const first = response(); await controller.decisionWebhook(signedRequest(), first);
  assert.equal(first.code, 500);
  assert.equal(state.user.isKycVerified, true);
  const retry = response(); await controller.decisionWebhook(signedRequest(), retry);
  assert.equal(retry.code, 200);
  assert.equal(attempts, 2);
  assert.equal(state.writes, 1);
});

test("IB registration cannot be submitted for another user", async t => {
  const User = require("../models/User");
  const { registerIB } = require("../controllers/ibController");
  const original = User.findById;
  User.findById = async () => ({ ...account(), email: "owner@example.test" });
  t.after(() => { User.findById = original; });
  const denied = response();
  await registerIB({ user: { id: "user-1" }, body: { email: "other@example.test" } }, denied);
  assert.equal(denied.code, 403);
});


test("a failed provider verification can start a new check without granting KYC approval", async () => {
  const user = account(); user.veriff.status = "declined";
  user.veriff.message = "Your identity could not be verified. Please contact support."; user.veriff.reasonCode = 101;
  const { controller, state } = controllerFor(user);
  const before = response(); await controller.getStatus({ user: { id: "user-1" } }, before);
  assert.equal(before.data.canRetry, true);
  const res = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, res);
  assert.equal(res.code, 201); assert.equal(state.user.isKycVerified, false);
  assert.notEqual(state.user.veriff.reference, reference);
  const stale = response(); await controller.decisionWebhook(signedRequest(), stale);
  assert.equal(state.user.isKycVerified, false);
});
test("policy rejection and review cannot be bypassed by requesting another session", async () => {
  for (const [status, message] of [["declined", "We don't accept UAE clients or UAE-issued identity documents."], ["review", "Your verification needs further review. Please contact support."], ["test_approved", "Test verification completed."]]) {
    const user = account(); Object.assign(user.veriff, { status, message });
    let calls = 0; const { controller } = controllerFor(user, { createSession: async () => { calls++; } });
    const res = response(); await controller.startSession({ user: { id: "user-1" }, body: { canRetry: true } }, res);
    assert.equal(res.code, 409); assert.equal(calls, 0);
  }
});

test("clients can correct their own name/address before retry without changing verification or identity controls", async () => {
  const user = account(); user.veriff.status = "declined"; user.veriff.message = "Your identity could not be verified. Please contact support."; user.veriff.reasonCode = 101;
  const { controller, state } = controllerFor(user);
  const res = response(); await controller.updateDetails({ user: { id: "user-1" }, body: { fullName: " Correct Name ", city: "Delhi" } }, res);
  assert.equal(res.code, 200); assert.equal(state.user.fullName, "Correct Name"); assert.equal(res.data.details.fullName, "Correct Name");
  assert.equal(state.user.isKycVerified, false); assert.equal(state.user.veriff.status, "declined"); assert.equal(res.data.canRetry, true);
  for (const body of [{ isKycVerified: true }, { nationality: "India" }, { residenceCountry: "India" }, { phone: "+919876543210" }, { userId: "other", fullName: "Other" }, { fullName: " " }, { fullName: { $ne: null } }]) {
    const bad = response(); await controller.updateDetails({ user: { id: "user-1" }, body }, bad); assert.equal(bad.code, 400);
  }
});
test("identity corrections are blocked for active, approved, policy-rejected and review accounts, including races", async () => {
  for (const status of ["created", "creating", "resubmission_requested", "approved", "review", "declined", "test_approved"]) {
    const user = account(); user.veriff.status = status; user.isKycVerified = status === "approved";
    const { controller, state } = controllerFor(user); const res = response();
    await controller.updateDetails({ user: { id: "user-1" }, body: { fullName: "Changed" } }, res);
    assert.equal(res.code, 409); assert.equal(state.writes, 0);
  }
  const user = account(); user.veriff.status = "expired";
  const { controller } = controllerFor(user, { conflict: true }); const res = response();
  await controller.updateDetails({ user: { id: "user-1" }, body: { fullName: "Changed" } }, res); assert.equal(res.code, 409);
});


test("signed webhook reason codes produce safe client guidance without exposing raw provider data", async () => {
  const { controller, state } = controllerFor(); const res = response();
  await controller.decisionWebhook(signedRequest(fixture({ status: "declined", code: 9102, reasonCode: 501, reason: "PRIVATE PROVIDER TEXT" })), res);
  assert.equal(state.user.veriff.reasonCode, 501);
  const view = response(); await controller.getStatus({ user: { id: "user-1" } }, view);
  assert.match(view.data.failureReason, /security review/); assert.equal(view.data.canRetry, false);
  assert.ok(!JSON.stringify(view.data).includes("PRIVATE PROVIDER TEXT"));
  const retry = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, retry); assert.equal(retry.code, 409);
});
test("legacy failures load authenticated reasons once and never change KYC approval", async () => {
  const user = account(); Object.assign(user.veriff, { status: "declined", message: "Your identity could not be verified. Please contact support." });
  let calls = 0; const { controller, state } = controllerFor(user, { getDecisionReason: async () => { calls++; return { status: "declined", reasonCode: 104 }; } });
  for (let i = 0; i < 2; i++) { const res = response(); await controller.getStatus({ user: { id: "user-1" } }, res); assert.equal(res.data.canRetry, true); assert.match(res.data.failureReason, /name/); }
  assert.equal(calls, 1); assert.equal(state.user.isKycVerified, false);
});

test("BDFX review without a provider rejection reason is not presented as a provider failure", async () => {
  const user = account(); user.veriff.status = "review";
  const { controller, state } = controllerFor(user);
  const res = response(); await controller.getStatus({ user: { id: "user-1" } }, res);
  assert.equal(res.data.status, "review"); assert.equal(res.data.approved, false);
  assert.equal(res.data.canRetry, false);
  assert.match(res.data.failureReason, /BDFX review/);
  assert.doesNotMatch(res.data.failureReason, /provider has not supplied|unsuccessful/i);
  assert.equal(state.user.isKycVerified, false);
});

test("decision reason lookup rejects unsigned and mismatched provider responses", async () => {
  const axios = require("axios"), original = axios.get;
  let body = fixture({ status: "declined", code: 9102, reasonCode: 104 }); let valid = true;
  axios.get = async () => {
    const data = JSON.stringify(body);
    return { data, headers: { "x-auth-client": config.apiKey, "x-hmac-signature": valid ? crypto.createHmac("sha256", config.sharedSecret).update(data).digest("hex") : "bad" } };
  };
  try {
    const cfg = { ...config, apiUrl: "https://example.veriff.com/v1/sessions" };
    assert.deepEqual(await service.getDecisionReason(sessionId, reference, cfg), { status: "declined", reasonCode: 104 });
    valid = false; await assert.rejects(service.getDecisionReason(sessionId, reference, cfg));
    valid = true; body = fixture({ vendorData: "other-account" }); await assert.rejects(service.getDecisionReason(sessionId, reference, cfg));
  } finally { axios.get = original; }
});

test("decision refresh validates the response signature, approval code and saved session correlation", async () => {
  const axios = require("axios"), original = axios.get;
  let payload = fixture({ document: { country: "IN", type: "DRIVERS_LICENSE" } }), signed = true;
  axios.get = async () => {
    const data = JSON.stringify(payload);
    return { data, headers: { "x-auth-client": config.apiKey, "x-hmac-signature": signed ? crypto.createHmac("sha256", config.sharedSecret).update(data).digest("hex") : "invalid" } };
  };
  const cfg = { ...config, apiUrl: "https://example.veriff.com/v1/sessions" };
  try {
    const decision = await service.getDecision(sessionId, reference, cfg);
    assert.equal(decision.status, "approved"); assert.equal(decision.documentType, "DRIVERS_LICENSE");
    assert.equal(decision.id, sessionId); assert.equal(decision.reference, reference);
    assert.equal(decision.document?.number, undefined);
    signed = false; await assert.rejects(service.getDecision(sessionId, reference, cfg));
    signed = true; payload = fixture({ code: 9102 }); await assert.rejects(service.getDecision(sessionId, reference, cfg));
    payload = fixture({ vendorData: "other-client" }); await assert.rejects(service.getDecision(sessionId, reference, cfg));
    payload = { status: "success", verification: null }; assert.equal(await service.getDecision(sessionId, reference, cfg), null);
  } finally { axios.get = original; }
});

test("a provider webhook retains the owner's recorded manual decision for the reviewed session", async () => {
  for (const approved of [true, false]) {
    const user = account(); user.kycManualReview = { sessionId, approved };
    const { controller, state } = controllerFor(user); const res = response();
    await controller.decisionWebhook(signedRequest(fixture({ status: approved ? "declined" : "approved", reasonCode: approved ? 501 : null })), res);
    assert.equal(res.code, 200); assert.equal(state.user.isKycVerified, approved); assert.equal(state.user.veriff.status, approved ? "declined" : "approved");
  }
});
test("a manually rejected client cannot restart verification to discard the owner's decision", async () => {
  const user = account(); user.kycManualReview = { sessionId, approved: false };
  const { controller } = controllerFor(user); const res = response(); await controller.startSession({ user: { id: "user-1" }, body: {} }, res); assert.equal(res.code, 409);
  const view = response(); await controller.getStatus({ user: { id: "user-1" } }, view); assert.equal(view.data.status, "manual_rejected"); assert.equal(view.data.canRetry, false);
});
