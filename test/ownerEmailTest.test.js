const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { createService, testMessage } = require("../services/ownerEmailTest.service");
const { createRouter } = require("../routes/emailMarketingRoutes");
const owner = { id: "123456789012345678901234", email: "owner@example.invalid", isAdmin: true, adminRole: "owner" };
const requestId = "12345678-1234-4234-8234-123456789012";
const otherId = "12345678-1234-4234-8234-123456789013";
function fixture({ failSend = false, failWrite = false, failReserve = false } = {}) {
  let time = new Date("2026-11-05T19:59:00Z");
  const records = new Map(), sent = [], logs = [];
  const receipts = {
    findById: id => ({ lean: async () => records.get(id) ? { ...records.get(id) } : null }),
    create: async ([record]) => {
      if (failReserve) throw Error("PRIVATE DATABASE DETAIL");
      if (records.has(record._id)) throw Object.assign(Error("duplicate"), { code: 11000 });
      records.set(record._id, { ...record }); return [{ ...record }];
    },
    updateOne: async (filter, update) => {
      if (failWrite) throw Error("PRIVATE DATABASE DETAIL");
      const row = records.get(filter._id);
      if (!row || row.requestId !== filter.requestId || row.status !== filter.status) return { matchedCount: 0 };
      Object.assign(row, update.$set); return { matchedCount: 1 };
    },
  };
  const service = createService({ receipts, ensure: async () => {}, now: () => time,
    send: async message => { sent.push(message); if (failSend) throw Error("PRIVATE SMTP CREDENTIAL"); },
    logger: { info: s => logs.push(s), error: s => logs.push(s) } });
  return { service, records, sent, logs, time: value => { time = new Date(value); } };
}
test("an owner test sends only to the authenticated owner through the existing welcome content", async () => {
  const f = fixture(); const r = await f.service.sendTest(owner, requestId);
  assert.equal(r.test.status, "accepted"); assert.equal(r.availableToday, false); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, owner.email); assert.match(f.sent[0].text, /OWNER DELIVERY TEST/);
  assert.match(f.sent[0].text, /does not subscribe you/); assert.equal(f.sent[0].headers["X-BDFX-Delivery-Test"], requestId);
  assert.equal(f.sent[0].throwOnError, true); assert.ok(!f.sent[0].headers["List-Unsubscribe"]);
  assert.ok(!JSON.stringify(r).includes("ownerId"));
});
test("concurrent requests and different references share one durable owner/day SMTP reservation", async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.sendTest(owner, i % 2 ? requestId : otherId)));
  assert.equal(f.sent.length, 1); assert.equal(f.records.size, 1);
  const again = await f.service.sendTest(owner, otherId); assert.equal(again.test.status, "accepted"); assert.equal(f.sent.length, 1);
});
test("SMTP errors and post-acceptance database uncertainty never trigger a resend or expose provider details", async () => {
  for (const config of [{ failSend: true }, { failWrite: true }]) {
    const f = fixture(config); const result = await f.service.sendTest(owner, requestId);
    assert.equal(result.test.status, "unconfirmed");
    f.time("2026-11-05T19:59:59Z"); await f.service.sendTest(owner, otherId); assert.equal(f.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.logs), /PRIVATE|CREDENTIAL|DATABASE DETAIL/);
  }
});
test("reservation failure prevents SMTP, GET status never sends, and only the next Dubai day allows a new test", async () => {
  const failed = fixture({ failReserve: true }); await assert.rejects(failed.service.sendTest(owner, requestId)); assert.equal(failed.sent.length, 0);
  const f = fixture(); assert.equal((await f.service.status(owner)).availableToday, true); assert.equal(f.sent.length, 0);
  await f.service.sendTest(owner, requestId); assert.equal((await f.service.status(owner)).availableToday, false);
  f.time("2026-11-05T20:00:00Z"); assert.equal((await f.service.status(owner)).availableToday, true);
  await f.service.sendTest(owner, otherId); assert.equal(f.sent.length, 2);
});
test("service rejects clients, managers, invalid identifiers and email-header injection", async () => {
  const f = fixture();
  for (const actor of [{ ...owner, isAdmin: false }, { ...owner, adminRole: "manager" }, { ...owner, email: "owner@example.invalid\r\nBcc:victim@example.invalid" }]) {
    await assert.rejects(f.service.sendTest(actor, requestId));
  }
  await assert.rejects(f.service.sendTest(owner, "not-a-uuid")); assert.equal(f.sent.length, 0);
  assert.match(testMessage(owner.email, requestId).subject, new RegExp(requestId));
});
test("owner-only routes reject recipient overrides, never send on GET, and retain no-store headers", async () => {
  let sends = 0, captured;
  const authentication = (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401);
  const principal = (req, _res, next) => { req.principal = { ...owner, adminRole: req.headers.authorization }; next(); };
  const guard = (req, res, next) => req.principal.adminRole === "owner" ? next() : res.sendStatus(403);
  const deliveryTest = { status: async () => ({ availableToday: true }), sendTest: async (actor, id) => { sends++; captured = { actor, id }; return { test: { status: "accepted" } }; } };
  const app = express(); app.use(express.json()); app.use(createRouter({ authentication, principal, owner: guard, deliveryTest }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r)); const url = `http://127.0.0.1:${server.address().port}/delivery-test`;
  const post = (role, body) => fetch(url, { method: "POST", headers: { ...(role ? { Authorization: role } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(null, { requestId })).status, 401);
    for (const role of ["client", "manager"]) assert.equal((await post(role, { requestId })).status, 403);
    assert.equal((await post("owner", { requestId, to: "victim@example.invalid" })).status, 400);
    assert.equal((await post("owner", { requestId, subscribed: true })).status, 400);
    assert.equal((await post("owner", { requestId: "bad" })).status, 400); assert.equal(sends, 0);
    const read = await fetch(url, { headers: { Authorization: "owner" } }); assert.equal(read.status, 200); assert.equal(sends, 0);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal((await post("owner", { requestId })).status, 200); assert.equal(sends, 1); assert.deepEqual(captured, { actor: owner, id: requestId });
  } finally { await new Promise(r => server.close(r)); }
});
