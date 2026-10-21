const test = require("node:test");
const assert = require("node:assert/strict");
const { createController } = require("../controllers/manualKycController");
const sessionId = "e779b84b-44ac-47df-8a2a-7bc0d1d21a8c";
const owner = { isAdmin: true, adminRole: "owner", id: "owner1", email: "owner@example.invalid" };
const body = { approved: true, reviewedDocuments: true, reason: "Reviewed original identity documents and verified the client in person.", sessionId, expectedRevision: 2 };
const response = () => ({ code: 200, set() { return this; }, status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } });
function fixture({ duplicate = false, failLog = false, failIB = false, patch = {} } = {}) {
  let user = { _id: "user1", email: "client@example.invalid", isVerified: true, isKycVerified: false, hasSubmittedDocuments: true,
    kycProvider: "veriff", nationality: "India", residenceCountry: "India", phone: "+919876543210",
    veriff: { status: "declined", reasonCode: 501, sessionId, revision: 2, mode: "live" }, ...patch };
  let entries = [], sent = 0, ibCalls = [];
  const query = value => ({ select() { return this; }, session: async () => value });
  const users = { findOne: () => query(structuredClone(user)), exists: () => query(duplicate), findOneAndUpdate: async (filter, update) => {
    assert.equal(filter["veriff.revision"], user.veriff.revision);
    Object.assign(user, update.$set); user.veriff.revision += update.$inc["veriff.revision"]; return structuredClone(user);
  } };
  const controller = createController({ users, reviews: { create: async records => { if (failLog) throw Error("private db error"); entries.push(...records); } },
    transaction: async work => { const snapshot = structuredClone(user), old = [...entries]; try { return await work({}); } catch (error) { user = snapshot; entries = old; throw error; } },
    ensure: async () => {}, syncIB: async (id, options) => {
      // The durable owner review must exist before automatic IB processing.
      assert.equal(entries.length, 1); assert.equal(user.kycManualReview.approved, options.reconsiderRejected);
      ibCalls.push({ id, options }); if (failIB) throw Error("private IB database error");
      return { managed: true, status: options.reconsiderRejected ? "approved" : "rejected", statusReason: "Identity review decision" };
    }, send: async () => { sent++; } });
  const call = async (b = body, principal = owner) => { const res = response(); await controller({ principal, params: { email: user.email }, body: b }, res); return res; };
  return { call, user: () => user, entries: () => entries, sent: () => sent, ibCalls: () => ibCalls };
}
test("only a human owner can record a document-reviewed manual decision", async () => {
  const f = fixture();
  for (const principal of [null, { ...owner, isAdmin: false }, { ...owner, adminRole: "manager" }]) assert.equal((await f.call(body, principal)).code, 403);
  assert.equal(f.entries().length, 0); assert.equal(f.user().isKycVerified, false);
  const result = await f.call(); assert.equal(result.code, 200); assert.equal(result.data.approved, true);
  assert.equal(f.user().veriff.status, "declined"); assert.equal(f.user().veriff.reasonCode, 501);
  assert.equal(f.user().kycManualReview.approved, true); assert.equal(f.entries()[0].reason, body.reason); assert.equal(f.entries()[0].reviewerId, owner.id); assert.equal(f.sent(), 1);
});
test("review requires evidence confirmation, reason and current session revision", async () => {
  const f = fixture();
  for (const patch of [{ approved: "true" }, { reviewedDocuments: false }, { reason: "" }, { expectedRevision: undefined }, { isKycVerified: true }]) assert.equal((await f.call({ ...body, ...patch })).code, 400);
  assert.equal((await f.call({ ...body, expectedRevision: 1 })).code, 409);
  assert.equal((await f.call({ ...body, sessionId: "e779b84b-44ac-47df-8a2a-7bc0d1d21a8d" })).code, 409);
  assert.equal(f.entries().length, 0);
});
test("manual approval preserves UAE, verified-email, live-evidence and duplicate-mobile checks", async () => {
  for (const patch of [{ nationality: "UAE" }, { residenceCountry: "AE" }, { isVerified: false }, { hasSubmittedDocuments: false }, { veriff: { status: "declined", sessionId, revision: 2, mode: "test" } }]) {
    const f = fixture({ patch }); assert.equal((await f.call()).code, 409); assert.equal(f.user().isKycVerified, false);
  }
  assert.equal((await fixture({ duplicate: true }).call()).code, 409);
});
test("review record and approval commit together; audit failure rolls back and sends no email", async () => {
  const f = fixture({ failLog: true }); const res = await f.call(); assert.equal(res.code, 503);
  assert.equal(f.user().isKycVerified, false); assert.equal(f.user().kycManualReview, undefined); assert.equal(f.entries().length, 0); assert.equal(f.sent(), 0); assert.equal(f.ibCalls().length, 0);
  assert.ok(!JSON.stringify(res.data).includes("private db"));
});
test("owner rejection is recorded independently of a provider approval", async () => {
  const f = fixture({ patch: { isKycVerified: true, veriff: { status: "approved", sessionId, revision: 2, mode: "live" } } });
  assert.equal((await f.call({ ...body, approved: false })).code, 200); assert.equal(f.user().isKycVerified, false); assert.equal(f.user().veriff.status, "approved"); assert.equal(f.entries()[0].approved, false);
});


test("owner manual approval automatically reconsiders an existing rejected IB after the review commits", async () => {
  const f = fixture(); const res = await f.call();
  assert.equal(res.data.ibStatus, "approved"); assert.match(res.data.message, /IB automatically approved/);
  assert.deepEqual(f.ibCalls(), [{ id: "user1", options: { reconsiderRejected: true } }]);
});
test("a separate IB update failure preserves the saved KYC decision and clearly requests retry", async () => {
  const f = fixture({ failIB: true }); const res = await f.call();
  assert.equal(res.code, 200); assert.equal(res.data.approved, true); assert.equal(res.data.ibStatus, "update_required");
  assert.equal(res.data.ibSyncFailed, true); assert.equal(f.entries().length, 1);
  assert.match(res.data.message, /could not be confirmed/); assert.ok(!JSON.stringify(res.data).includes("private IB"));
});
test("an owner rejection synchronizes IB without allowing automatic reconsideration of rejected applications", async () => {
  const f = fixture(); const res = await f.call({ ...body, approved: false });
  assert.equal(res.data.ibStatus, "rejected"); assert.equal(f.ibCalls()[0].options.reconsiderRejected, false);
});
