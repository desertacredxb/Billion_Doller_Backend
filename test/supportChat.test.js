const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createController, eventValue } = require("../controllers/supportChatController");
const { createRouter } = require("../routes/supportChatRoutes");
const { createAccessControl } = require("../middleware/accessControl");
const Session = require("../models/SupportChatSession");
const NOW = new Date("2026-10-21T10:00:00Z");
const secret = "a".repeat(64), requestId = crypto.randomUUID();
const response = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; }, end() { return this; } });
function fixture() {
  let time = new Date(NOW), counter = 0; const records = [];
  const field = (value, key) => key.split(".").reduce((item, part) => Array.isArray(item) && part === "id" ? item.map(event => event.id) : item?.[part], value);
  const matches = (item, filter) => Object.entries(filter).every(([key, condition]) => {
    const value = field(item, key);
    if (condition && typeof condition === "object" && !(condition instanceof Date)) return Object.entries(condition).every(([operator, target]) => {
      if (operator === "$exists") return (value !== undefined) === target;
      if (operator === "$ne") return Array.isArray(value) ? !value.includes(target) : value !== target;
      if (operator === "$gt") return value > target;
      if (operator === "$gte") return value >= target;
      if (operator === "$lt") return value < target;
      assert.fail(`Unexpected query operator ${operator}`);
    });
    return value === condition;
  });
  function query(get, many = false) {
    let fields = "", skip = 0, limit = Infinity;
    const project = value => {
      if (!value) return value;
      const copy = structuredClone(value);
      if (fields.startsWith("-")) for (const key of fields.split(" ")) delete copy[key.slice(1)];
      else if (fields) for (const key of Object.keys(copy)) if (key !== "_id" && !fields.split(" ").some(path => path.split(".")[0] === key)) delete copy[key];
      return copy;
    };
    const result = () => many ? get().slice(skip, skip + limit).map(project) : project(get());
    return { select(value) { fields = value; return this; }, sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, lean: async () => result(), then(resolve, reject) { return Promise.resolve().then(result).then(resolve, reject); } };
  }
  const sessions = {
    async create(value) {
      if (records.some(item => item.publicId === value.publicId)) throw Object.assign(new Error("Duplicate session"), { code: 11000 });
      const item = { _id: (++counter).toString(16).padStart(24, "0"), createdAt: new Date(time), status: "new", note: "", ...structuredClone(value) };
      records.push(item); return structuredClone(item);
    },
    findOne: filter => query(() => records.find(item => matches(item, filter))),
    find: filter => query(() => records.filter(item => matches(item, filter)), true),
    countDocuments: async filter => records.filter(item => matches(item, filter)).length,
    findOneAndUpdate(filter, update) {
      const item = records.find(item => matches(item, filter));
      if (item) {
        if (update.$set) Object.assign(item, structuredClone(update.$set));
        if (update.$push) for (const [key, value] of Object.entries(update.$push)) item[key].push(structuredClone(value));
      }
      return query(() => item);
    },
  };
  const controller = createController({ sessions, ensureStorage: async () => {}, now: () => new Date(time) });
  async function call(method, body = {}, token = secret, id = requestId, queryValues = {}) {
    const res = response();
    await controller[method]({ body, params: { id }, query: queryValues, get: () => token }, res, error => { throw error; }); return res;
  }
  return { records, sessions, controller, call, advance: milliseconds => { time = new Date(time.getTime() + milliseconds); } };
}
const start = (f, extra = {}) => f.call("create", { requestId, secret, language: "en", consent: true, ...extra });
const activity = (extra = {}) => ({ eventId: crypto.randomUUID(), type: "answer", language: "hi", question: 6, ...extra });
const contact = () => ({ name: "Synthetic Visitor", email: "visitor@example.invalid", phone: "+919876543210", country: "India", privacyAccepted: true });

test("saving requires explicit permission and unique retry-safe credentials; parallel retries create one session", async () => {
  const f = fixture();
  assert.equal((await start(f, { consent: false })).code, 400);
  assert.equal((await start(f, { secret: "weak" })).code, 400);
  assert.equal(f.records.length, 0);
  const results = await Promise.all([start(f), start(f), start(f)]);
  assert.ok(results.every(value => value.code === 201)); assert.equal(f.records.length, 1);
  assert.equal((await start(f, { secret: "b".repeat(64) })).code, 404);
  assert.equal(f.records[0].secretHash.includes(secret), false);
  assert.equal(f.records[0].expiresAt - NOW, 90 * 86400000);
  assert.equal(JSON.stringify(results).includes("secretHash"), false);
});

test("invalid, expired and cross-session credentials cannot append activity or contact data", async () => {
  const f = fixture(); await start(f);
  for (const [token, id] of [["wrong", requestId], ["b".repeat(64), requestId], [secret, crypto.randomUUID()]]) {
    assert.equal((await f.call("event", activity(), token, id)).code, 404);
    assert.equal((await f.call("contact", contact(), token, id)).code, 404);
  }
  f.advance(86400001);
  assert.equal((await f.call("event", activity())).code, 404);
  assert.equal((await f.call("contact", contact())).code, 404);
  assert.equal(f.records[0].events.length, 1); assert.equal(f.records[0].contact, undefined);
});

test("the saved guide trail uses fixed IDs and strips typed searches, URLs and supplied identities", async () => {
  const value = eventValue(activity({ topic: "account", search: "private OTP 123456", url: "https://private.invalid/?password=secret", email: "hidden@example.invalid" }), NOW);
  assert.equal(value.topic, "withdrawal"); assert.equal(value.question, 6);
  for (const key of ["search", "url", "email", "message"]) assert.equal(value[key], undefined);
  for (const body of [activity({ question: 999 }), activity({ question: "6" }), activity({ language: "outside" }), activity({ type: "message" }), activity({ type: "topic", topic: { $ne: null } })]) assert.equal(eventValue(body, NOW), null);
});

test("event retries are deduplicated atomically and the embedded activity cannot grow beyond 100 entries", async () => {
  const f = fixture(); await start(f); const value = activity();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.call("event", value)));
  assert.ok(results.every(result => result.code === 204)); assert.equal(f.records[0].events.length, 2);
  for (let i = 0; i < 98; i++) assert.equal((await f.call("event", activity())).code, 204);
  assert.equal((await f.call("event", activity())).code, 429);
  assert.equal(f.records[0].events.length, 100);
  assert.equal((await f.call("event", value)).code, 204);
});

test("visitor contacts require separate permission, preserve UAE policy and cannot replace an earlier submission", async () => {
  const f = fixture(); await start(f);
  for (const patch of [{ privacyAccepted: false }, { country: "UAE" }, { country: "United Arab Emirates" }, { email: "invalid" }, { website: "spam" }]) assert.equal((await f.call("contact", { ...contact(), ...patch })).code, 400);
  assert.equal(f.records[0].contact, undefined);
  await Promise.all([f.call("contact", contact()), f.call("contact", contact())]);
  assert.equal(f.records[0].contact.email, contact().email);
  await f.call("contact", { ...contact(), email: "replacement@example.invalid" });
  assert.equal(f.records[0].contact.email, contact().email);
  assert.equal(f.records[0].contact.marketingConsent, undefined);
});

test("admin summaries use Dubai date boundaries, remain session counts and never expose capability hashes", async () => {
  const f = fixture(); await start(f); await f.call("contact", contact()); await f.call("event", activity());
  const listing = await f.call("list", {}, secret, requestId, { from: "2026-10-21", to: "2026-10-21" });
  assert.deepEqual(listing.data.summary, { sessions: 1, contacts: 1, active: 1 });
  assert.equal(listing.data.data[0].events, undefined);
  const detail = await f.call("detail", {}, secret, f.records[0]._id);
  for (const key of ["secretHash", "publicId", "tokenExpiresAt"]) { assert.equal(detail.data.data[key], undefined); assert.equal(listing.data.data[0][key], undefined); }
  assert.equal(detail.data.data.events[1].question, 6);
  const outside = await f.call("list", {}, secret, requestId, { from: "2026-10-20", to: "2026-10-20" }); assert.equal(outside.data.total, 0);
  for (const query of [{ from: "2026-02-30" }, { from: "2026-01-01", to: "2026-10-21" }, { language: { $ne: null } }, { status: "invalid" }]) assert.equal((await f.call("list", {}, secret, requestId, query)).code, 400);
  f.advance(300001);
  assert.equal((await f.call("list", {}, secret, requestId)).data.summary.active, 0);
});

test("team updates allow only status and bounded notes, without changing visitor identity or activity", async () => {
  const f = fixture(); await start(f); const id = f.records[0]._id;
  assert.equal((await f.call("update", { status: "contacted", note: "  Follow up requested  ", contact: contact(), secretHash: "override" }, secret, id)).code, 200);
  assert.equal(f.records[0].status, "contacted"); assert.equal(f.records[0].note, "Follow up requested");
  assert.equal(f.records[0].contact, undefined); assert.equal(f.records[0].events.length, 1);
  assert.equal((await f.call("update", { status: "approved", note: "" }, secret, id)).code, 400);
  assert.equal((await f.call("update", { status: "closed", note: "x".repeat(2001) }, secret, id)).code, 400);
});

test("new chat documents validate bounded fields and redact capability credentials during serialization", () => {
  const doc = new Session({ publicId: requestId, secretHash: secret, tokenExpiresAt: NOW, expiresAt: NOW, reference: "CHAT-TEST", language: "en", consentedAt: NOW, lastActiveAt: NOW, events: [] });
  assert.equal(doc.validateSync(), undefined);
  const json = doc.toJSON(); for (const key of ["publicId", "secretHash", "tokenExpiresAt"]) assert.equal(json[key], undefined);
  doc.events = Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), type: "open", language: "en", at: NOW }));
  assert.ok(doc.validateSync());
});

test("signed-in HTTP flow enforces owner/support-manager access and rejects clients, other managers and anonymous readers", async () => {
  const express = require("express"), jwt = require("jsonwebtoken");
  process.env.JWT_SECRET = "isolated-support-chat-test-secret"; process.env.ADMIN_OWNER_EMAILS = "owner@example.invalid";
  const f = fixture(), admins = {
    owner: { _id: "owner", email: "owner@example.invalid", enabled: true },
    support: { _id: "support", email: "support@example.invalid", enabled: true, role: "manager", permissions: ["support"], invitedBy: "owner" },
    finance: { _id: "finance", email: "finance@example.invalid", enabled: true, role: "manager", permissions: ["finance"], invitedBy: "owner" },
  };
  const authorization = createAccessControl({ admins: { findOne: async query => admins[query._id] }, users: { findById: () => ({ select: async () => ({ _id: "client", email: "client@example.invalid", isVerified: true }) }) } });
  const app = express(); app.use(express.json()); app.use("/api/support-chat", createRouter({ controller: f.controller, authorization }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/support-chat`;
  try {
    const created = await fetch(`${url}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, secret, consent: true, language: "en" }) }); assert.equal(created.status, 201);
    const event = await fetch(`${url}/sessions/${requestId}/events`, { method: "POST", headers: { "Content-Type": "application/json", "X-BDFX-Chat-Token": secret }, body: JSON.stringify(activity()) }); assert.equal(event.status, 204);
    assert.equal((await fetch(`${url}/admin/sessions`)).status, 401);
    for (const [role, expected] of [["owner", 200], ["support", 200], ["finance", 403], ["client", 403]]) {
      const claims = role === "client" ? { id: "client" } : { kind: "admin", sub: role, email: admins[role].email, version: 1, iss: "bdfx-auth", aud: "bdfx-admin" };
      const headers = { Authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "5m" })}` };
      const listing = await fetch(`${url}/admin/sessions`, { headers }); assert.equal(listing.status, expected);
      const detail = await fetch(`${url}/admin/sessions/${f.records[0]._id}`, { headers }); assert.equal(detail.status, expected);
      if (expected === 200) { const body = await detail.json(); assert.equal(body.data.events.length, 2); assert.equal(body.data.secretHash, undefined); assert.equal(detail.headers.get("Cache-Control"), "no-store"); }
    }
    assert.equal((await fetch(`${url}/sessions/${requestId}`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
