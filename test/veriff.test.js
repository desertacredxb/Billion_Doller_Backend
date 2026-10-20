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
    createSession: options.createSession || (async () => ({ id: sessionId, url: "https://magic.veriff.me/test-session" })) };
  return { ...database, controller: createController({ users: database.model, veriff }) };
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
  for (const patch of [{ documentCountry: "AE" }, { nationality: "ARE" }, { documentCountry: null }, { documentType: "VISA" }]) {
    assert.equal(decisionOutcome({ ...decision, ...patch }, account(), config, false).approved, false);
  }
  assert.equal(decisionOutcome(decision, account(), config, true).status, "review");
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
