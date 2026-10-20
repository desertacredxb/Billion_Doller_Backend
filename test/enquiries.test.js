const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, validateEnquiry } = require("../controllers/enquiryController");
const { createService } = require("../services/enquiryNotifications.service");

const valid = () => ({ name: "Test Client", email: "test@example.invalid", country: "India", message: "Please help me connect to MT5.", privacyAccepted: true, requestId: "11111111-1111-4111-8111-111111111111" });
const response = () => ({ code: 200, data: null, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; } });

test("enquiries validate required fields, country policy and contact consent without requiring marketing consent", () => {
  const result = validateEnquiry(valid());
  assert.equal(result.value.marketingConsent, false);
  assert.equal(result.value.phone, "");
  assert.equal(result.value.email, "test@example.invalid");
  for (const patch of [{ name: "" }, { email: { $ne: null } }, { country: "" }, { country: "UAE" }, { country: "United Arab Emirates" }, { message: "short" }, { privacyAccepted: false }, { requestId: "bad" }, { phone: "123" }]) assert.ok(validateEnquiry({ ...valid(), ...patch }).error);
  assert.equal(validateEnquiry({ ...valid(), phone: "+91 98765 43210", marketingConsent: true }).value.phone, "+919876543210");
});

test("accepted enquiries are persisted before confirmation and retries reuse the same reference", async () => {
  const state = { saved: null, created: 0, notifications: 0 };
  const enquiries = {
    findOne: () => ({ select: async () => state.saved }),
    create: async value => { state.created++; state.saved = { _id: "enquiry-1", ...value }; return state.saved; },
  };
  const controller = createController({ enquiries, notify: async () => { state.notifications++; }, reference: () => "BDFX-TEST" });
  for (let i = 0; i < 2; i++) {
    const res = response(); await controller.create({ body: valid() }, res, error => { throw error; });
    assert.equal(res.code, 201); assert.equal(res.data.reference, "BDFX-TEST");
    assert.equal(res.data.email, undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.created, 1); assert.equal(state.notifications, 1);
});

test("validation failures and honeypot submissions do not create a CRM record or trigger email", async () => {
  const controller = createController({ enquiries: { create: () => assert.fail("invalid lead saved") }, notify: () => assert.fail("invalid lead notified") });
  const invalid = response(); await controller.create({ body: { ...valid(), privacyAccepted: false } }, invalid, error => { throw error; });
  assert.equal(invalid.code, 400);
  const trapped = response(); await controller.create({ body: { ...valid(), website: "spam" } }, trapped, error => { throw error; });
  assert.equal(trapped.code, 201);
});

test("notification failure keeps a persisted enquiry eligible for retry rather than losing the request", async () => {
  process.env.EMAIL_USER = "admin@example.invalid";
  const writes = [];
  let called = false;
  const enquiries = { findOneAndUpdate: async () => {
    if (called) return null; called = true;
    return { _id: "enquiry-1", reference: "BDFX-TEST", notificationAttempts: 1, ...valid() };
  }, updateOne: async (filter, update) => { writes.push(update); } };
  await createService({ enquiries, send: async () => { throw new Error("test SMTP outage"); }, now: () => new Date("2026-10-21T12:00:00Z") }).processPending();
  assert.equal(writes[0].$set.notificationStatus, "pending");
  assert.equal(writes[0].$set.notificationNextAttemptAt.toISOString(), "2026-10-21T12:05:00.000Z");
});

test("notification success is recorded without sending customer data to an arbitrary submitted recipient", async () => {
  process.env.EMAIL_USER = "admin@example.invalid";
  let claimed = false; const writes = [], sent = [];
  const enquiries = { findOneAndUpdate: async () => {
    if (claimed) return null; claimed = true;
    return { _id: "enquiry-1", reference: "BDFX-TEST", notificationAttempts: 1, ...valid() };
  }, updateOne: async (filter, update) => { writes.push(update); } };
  await createService({ enquiries, send: async mail => { sent.push(mail); } }).processPending();
  assert.equal(sent[0].to, "admin@example.invalid");
  assert.equal(writes[0].$set.notificationStatus, "sent");
});
