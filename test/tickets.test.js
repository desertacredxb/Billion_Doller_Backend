const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, validateTicket } = require("../controllers/ticketController");
const { createService } = require("../services/ticketNotifications.service");
const response = () => ({ code: 200, data: null, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
const valid = () => ({ category: "MT5 Support", subject: "Cannot connect", description: "My MT5 connection shows an error.", requestId: "11111111-1111-4111-8111-111111111111" });

test("support rejects malformed input before touching storage", async () => {
  const controller = createController({ users: { findOne: () => assert.fail("invalid request queried storage") } });
  for (const patch of [{ category: "bad" }, { subject: {} }, { description: "short" }, { description: "x".repeat(5001) }, { requestId: { $ne: null } }]) {
    const res = response(); await controller.createTicket({ params: {}, body: { ...valid(), ...patch } }, res);
    assert.equal(res.code, 400); assert.ok(res.data.errors);
  }
  assert.deepEqual(validateTicket({ ...valid(), subject: "  Connection issue  " }).value.subject, "Connection issue");
});
test("retrying a saved ticket reuses its reference without another notification or active-slot check", async () => {
  let saved, created = 0, notified = 0, counts = 0;
  const controller = createController({ users: { findOne: async () => ({ _id: "owner" }) }, tickets: {
    findOne: async () => saved, countDocuments: async () => { counts++; return 0; },
    create: async value => { created++; saved = { _id: "ticket-1", ...value }; return saved; },
  }, notify: () => { notified++; } });
  for (let i = 0; i < 2; i++) { const res = response(); await controller.createTicket({ params: { email: "test@example.invalid" }, body: valid() }, res); assert.equal(res.code, 201); assert.equal(res.data._id, "ticket-1"); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 1); assert.equal(notified, 1); assert.equal(counts, 1);
});
test("a concurrent duplicate index conflict resolves to the already saved ticket", async () => {
  let lookups = 0;
  const controller = createController({ users: { findOne: async () => ({ _id: "owner" }) }, tickets: {
    findOne: async () => ++lookups === 1 ? null : ({ _id: "already-saved" }), countDocuments: async () => 0,
    create: async () => { throw Object.assign(new Error("duplicate"), { code: 11000 }); },
  } });
  const res = response(); await controller.createTicket({ params: { email: "test@example.invalid" }, body: valid() }, res);
  assert.equal(res.code, 201); assert.equal(res.data._id, "already-saved");
});
test("active-ticket limits, closed conversations and invalid statuses do not write records", async () => {
  const controller = createController({ users: { findOne: async () => ({ _id: "owner" }) }, tickets: { findOne: async () => null, countDocuments: async () => 2, create: () => assert.fail("limit bypass"), findById: async () => ({ status: "Closed" }) } });
  const limited = response(); await controller.createTicket({ params: {}, body: valid() }, limited); assert.equal(limited.code, 409);
  const closed = response(); await controller.addMessageToTicket({ params: { ticketId: "ticket" }, body: { message: "Help" }, principal: { isAdmin: false } }, closed); assert.equal(closed.code, 409);
  const status = response(); await controller.updateTicketStatus({ params: {}, body: { status: { $ne: "Closed" } } }, status); assert.equal(status.code, 400);
});
test("replies derive sender identity from the session and retries do not duplicate unread counters", async () => {
  let saved, writes = 0;
  const controller = createController({ tickets: { findById: async () => ({ _id: "ticket", status: "Open" }), updateOne: async () => { writes++; } }, messages: { findOne: async () => saved, create: async data => { saved = { _id: "message-1", ...data }; return saved; } } });
  const req = { params: { ticketId: "ticket" }, principal: { isAdmin: false }, body: { message: "  Please help. ", senderType: "Admin", requestId: valid().requestId } };
  for (let i = 0; i < 2; i++) { const res = response(); await controller.addMessageToTicket(req, res); assert.equal(res.code, 201); assert.equal(res.data.senderType, "User"); assert.equal(res.data.message, "Please help."); }
  assert.equal(writes, 1);
});
test("ticket email failures remain persisted for retry and never send to client-supplied recipients", async () => {
  const writes = []; let claimed = false;
  const envBefore = process.env.CONTACT_NOTIFICATION_EMAIL;
  process.env.CONTACT_NOTIFICATION_EMAIL = "team@example.invalid";
  try {
    const service = createService({ tickets: { findOneAndUpdate: async () => claimed ? null : (claimed = true, { _id: "ticket", notificationAttempts: 1, user: "owner", ...valid() }), updateOne: async (_filter, update) => writes.push(update) }, users: { findById: () => ({ select: async () => ({ email: "client@example.invalid" }) }) }, send: async mail => { assert.equal(mail.to, "team@example.invalid"); assert.equal(mail.html, undefined); throw new Error("SMTP outage"); }, now: () => new Date("2026-10-21T00:00:00Z") });
    await service.processPending();
    assert.equal(writes[0].$set.notificationStatus, "pending"); assert.equal(writes[0].$set.notificationNextAttemptAt.toISOString(), "2026-10-21T00:05:00.000Z");
  } finally { if (envBefore === undefined) delete process.env.CONTACT_NOTIFICATION_EMAIL; else process.env.CONTACT_NOTIFICATION_EMAIL = envBefore; }
});
