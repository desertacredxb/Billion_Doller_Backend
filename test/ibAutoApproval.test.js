const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("../services/ibAutoApproval.service");

const config = { mode: "live", keyHash: "synthetic-integration-hash" };
const userFixture = () => ({ _id: "synthetic-user", email: "synthetic@example.test", isVerified: true,
  isKycVerified: true, isApprovedIB: false, kycProvider: "veriff", residenceCountry: "India", nationality: "India",
  phone: "+919876543210", veriff: { status: "approved", mode: "live", integrationKeyHash: config.keyHash, sessionId: "synthetic-session" } });
const brokerFixture = () => ({ _id: "synthetic-ib", user: "synthetic-user", approvalProvider: "veriff", status: "pending" });

function fixture({ user = userFixture(), broker = brokerFixture(), duplicate = false, failRole = false, currentConfig = config, enabled = true } = {}) {
  const state = { user, broker, writes: 0, transactions: 0 };
  const session = { synthetic: true };
  const query = value => ({ select() { return this; }, session: async received => {
    assert.equal(received, session); return structuredClone(value);
  } });
  const apply = (target, update) => {
    Object.assign(target, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete target[key];
  };
  const users = {
    findById: () => query(state.user),
    exists: () => query(duplicate),
    updateOne: async (filter, update, options) => {
      assert.equal(options.session, session);
      if (failRole) throw Error("Synthetic role-write failure");
      apply(state.user, update); state.writes++;
    },
  };
  const brokers = {
    exists: async filter => state.broker && state.broker.user === filter.user && state.broker.approvalProvider === filter.approvalProvider,
    findOne: () => query(state.broker),
    updateOne: async (filter, update, options) => {
      assert.equal(options.session, session);
      apply(state.broker, update); state.writes++;
    },
  };
  const transaction = async work => {
    state.transactions++;
    const before = structuredClone(state);
    try { return await work(session); }
    catch (error) { Object.assign(state, before); throw error; }
  };
  return { state, service: createService({ users, brokers, enabled: () => enabled, getConfig: () => currentConfig, transaction }) };
}

test("verified live client receives an IB role and referral code together", async () => {
  const { state, service } = fixture();
  const result = await service.syncUser("synthetic-user");
  assert.equal(result.status, "approved");
  assert.equal(state.user.isApprovedIB, true);
  assert.equal(state.broker.status, "approved");
  assert.equal(state.broker.approvalSessionId, "synthetic-session");
  assert.match(result.referralCode, /^IB[A-F0-9]{10}$/);
  assert.equal(state.writes, 2);
});

test("repeated synchronization keeps one stable referral code", async () => {
  const { state, service } = fixture();
  const first = await service.syncUser("synthetic-user");
  const second = await service.syncUser("synthetic-user");
  assert.equal(first.referralCode, second.referralCode);
  assert.equal(state.writes, 2);
});

test("clients without an IB application are never enrolled automatically", async () => {
  const { state, service } = fixture({ broker: null });
  assert.deepEqual(await service.syncUser("synthetic-user"), { managed: false });
  assert.equal(state.user.isApprovedIB, false);
  assert.equal(state.transactions, 0);
});

test("test, pending, unverified, mismatched-integration, and duplicate-mobile cases remain unapproved", async () => {
  const variants = [
    { edit: user => { user.veriff.mode = "test"; } },
    { currentConfig: { ...config, mode: "test" } },
    { edit: user => { user.veriff.status = "review"; user.isKycVerified = false; } },
    { edit: user => { user.isVerified = false; } },
    { edit: user => { user.veriff.integrationKeyHash = "other-integration"; } },
    { duplicate: true },
    { edit: user => { user.kycProvider = "manual"; } },
  ];
  for (const variant of variants) {
    const user = userFixture(); variant.edit?.(user);
    const { state, service } = fixture({ ...variant, user });
    const result = await service.syncUser("synthetic-user");
    assert.equal(result.status, "pending");
    assert.equal(state.user.isApprovedIB, false);
    assert.equal(state.broker.referralCode, undefined);
  }
});

test("UAE declarations and a declined identity result reject IB approval", async () => {
  for (const patch of [{ residenceCountry: "UAE" }, { nationality: "AE" }, { veriff: { ...userFixture().veriff, status: "declined" }, isKycVerified: false }]) {
    const { state, service } = fixture({ user: { ...userFixture(), ...patch } });
    assert.equal((await service.syncUser("synthetic-user")).status, "rejected");
    assert.equal(state.user.isApprovedIB, false);
    assert.equal(state.broker.referralCode, undefined);
  }
});

test("a failed role write rolls back the IB status and referral code", async () => {
  const { state, service } = fixture({ failRole: true });
  await assert.rejects(service.syncUser("synthetic-user"), /Synthetic role-write failure/);
  assert.equal(state.broker.status, "pending");
  assert.equal(state.broker.referralCode, undefined);
  assert.equal(state.user.isApprovedIB, false);
  assert.equal(state.writes, 0);
});

test("a later identity decline revokes the automated IB role and referral code together", async () => {
  const { state, service } = fixture();
  await service.syncUser("synthetic-user");
  state.user.isKycVerified = false;
  state.user.veriff.status = "declined";
  assert.equal((await service.syncUser("synthetic-user")).status, "rejected");
  assert.equal(state.user.isApprovedIB, false);
  assert.equal(state.broker.referralCode, undefined);
});

test("manual or rejected IB applications are never silently reapproved", async () => {
  const manual = fixture({ broker: { ...brokerFixture(), approvalProvider: "manual" } });
  assert.deepEqual(await manual.service.syncUser("synthetic-user"), { managed: false });
  const rejected = fixture({ broker: { ...brokerFixture(), status: "rejected" } });
  assert.equal((await rejected.service.syncUser("synthetic-user")).status, "rejected");
  assert.equal(rejected.state.writes, 0);
});

test("disabled automation does not provision any IB role", async () => {
  const { service, state } = fixture({ enabled: false });
  assert.deepEqual(await service.syncUser("synthetic-user"), { managed: false });
  assert.equal(state.transactions, 0);
  assert.equal(state.writes, 0);
});

test("an owner-reviewed live identity qualifies for an existing IB application while preserving the provider decline", async () => {
  const user = userFixture(); user.veriff.status = "declined"; user.veriff.reasonCode = 501;
  user.kycManualReview = { approved: true, sessionId: user.veriff.sessionId, reviewId: "review1", reviewerId: "owner1", reviewedAt: new Date() };
  const { state, service } = fixture({ user }); const result = await service.syncUser(user._id);
  assert.equal(result.status, "approved"); assert.equal(state.user.isApprovedIB, true); assert.equal(state.user.veriff.status, "declined");
});
test("a rejected IB requires explicit owner reconsideration even when identity is now approved", async () => {
  const user = userFixture(); user.veriff.status = "declined";
  user.kycManualReview = { approved: true, sessionId: user.veriff.sessionId, reviewId: "review1", reviewerId: "owner1", reviewedAt: new Date() };
  const { state, service } = fixture({ user, broker: { ...brokerFixture(), status: "rejected" } });
  assert.equal((await service.syncUser(user._id)).status, "rejected"); assert.equal(state.writes, 0);
  assert.equal((await service.syncUser(user._id, { reconsiderRejected: true })).status, "approved"); assert.equal(state.user.isApprovedIB, true);
});
test("manual identity acceptance cannot cross sessions or bypass duplicate and country restrictions", async () => {
  const user = userFixture(); user.veriff.status = "declined";
  user.kycManualReview = { approved: true, sessionId: "different", reviewId: "review1", reviewerId: "owner1", reviewedAt: new Date() };
  assert.equal((await fixture({ user }).service.syncUser(user._id, { reconsiderRejected: true })).status, "rejected");
  user.kycManualReview.sessionId = user.veriff.sessionId;
  for (const options of [{ duplicate: true }, { user: { ...user, nationality: "UAE" } }]) {
    const f = fixture({ user, ...options }); assert.notEqual((await f.service.syncUser(user._id, { reconsiderRejected: true })).status, "approved"); assert.equal(f.state.user.isApprovedIB, false);
  }
});

test("failed eligibility stores actionable reasons and never provisions a referral", async () => {
  const variants = [
    { patch: { residenceCountry: "AE" }, code: "country_ineligible", status: "rejected" },
    { patch: { isVerified: false }, code: "email_unverified", status: "pending" },
    { patch: { phone: "" }, code: "phone_invalid", status: "pending" },
    { duplicate: true, code: "phone_duplicate", status: "pending" },
    { patch: { veriff: { ...userFixture().veriff, status: "declined", reasonCode: 501 }, isKycVerified: false }, code: "identity_declined", status: "rejected" },
  ];
  for (const variant of variants) {
    const { state, service } = fixture({ user: { ...userFixture(), ...variant.patch }, duplicate: variant.duplicate });
    const result = await service.syncUser("synthetic-user");
    assert.equal(result.reasonCode, variant.code); assert.equal(result.status, variant.status);
    assert.equal(state.broker.statusReason, result.statusReason); assert.ok(result.statusReason.length > 20);
    assert.equal(state.broker.referralCode, undefined); assert.equal(state.user.isApprovedIB, false);
    if (variant.code === "identity_declined") assert.match(result.statusReason, /security review/);
  }
});

test("reapplying before correction retains the reason; corrected live KYC clears the rejection", async () => {
  const user = userFixture(); user.isKycVerified = false; user.veriff.status = "declined"; user.veriff.reasonCode = 101;
  const { state, service } = fixture({ user });
  const failed = await service.syncUser(user._id); assert.match(failed.statusReason, /physical ID/);
  const retry = await service.syncUser(user._id, { reconsiderRejected: true }); assert.equal(retry.status, "rejected"); assert.equal(retry.canReapply, true);
  state.user.veriff.status = "approved"; state.user.isKycVerified = true;
  const approved = await service.syncUser(user._id, { reconsiderRejected: true });
  assert.equal(approved.status, "approved"); assert.equal(state.broker.statusReason, undefined); assert.equal(state.broker.reasonCode, undefined);
  assert.equal(state.user.isApprovedIB, true);
});

test("reading an older rejected application explains the failure without approving it or exposing review records", () => {
  const { applicationDetails } = require("../services/ibAutoApproval.service");
  const user = userFixture(); user.isKycVerified = false; user.veriff.status = "declined"; user.veriff.reasonCode = 501;
  const broker = { ...brokerFixture(), status: "rejected", referralCode: "OLD" };
  const result = applicationDetails(broker, user, config);
  assert.equal(result.canReapply, true); assert.match(result.statusReason, /security review/); assert.equal(result.referralCode, undefined);
  assert.equal(broker.status, "rejected"); assert.equal(result.kycManualReview, undefined); assert.equal(result.veriff, undefined);
});
