const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const approval = require("../services/ibAutoApproval.service");
const controller = require("../controllers/ibController");
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });

function setup(t, provider = "veriff") {
  const original = { user: User.findById, broker: IB.findOne, sync: approval.syncUser };
  t.after(() => { User.findById = original.user; IB.findOne = original.broker; approval.syncUser = original.sync; });
  const user = { _id: "synthetic-user", email: "synthetic@example.test", isVerified: true };
  const broker = { _id: "synthetic-ib", user: user._id, email: user.email, approvalProvider: provider, status: "rejected", save: async () => {} };
  User.findById = async () => user; IB.findOne = async () => broker;
  const requests = [];
  approval.syncUser = async (id, options) => {
    requests.push({ id, options });
    return { managed: true, status: options.reconsiderRejected ? "approved" : "rejected", statusReason: options.reconsiderRejected ? "Your IB application is approved." : "Original rejection reason", canReapply: !options.reconsiderRejected, verificationRequired: false };
  };
  return { user, broker, requests };
}

test("only an explicit reapplication asks for reconsideration, and returns the actual decision", async t => {
  const { user, requests } = setup(t);
  for (const reapply of [undefined, "true", true]) {
    const res = response();
    await controller.registerIB({ user: { id: user._id }, body: { email: user.email, reapply } }, res);
    assert.equal(res.code, 200); assert.equal(res.data.newIB.status, reapply === true ? "approved" : "rejected");
    assert.equal(requests.at(-1).options.reconsiderRejected, reapply === true);
  }
});

test("legacy manual rejection can be resubmitted without silently granting an IB role", async t => {
  const { user, broker, requests } = setup(t, "manual");
  const res = response(); await controller.registerIB({ user: { id: user._id }, body: { email: user.email, reapply: true } }, res);
  assert.equal(res.code, 200); assert.equal(res.data.newIB.status, "pending"); assert.equal(broker.status, "pending");
  assert.equal(requests.length, 0); assert.equal(user.isApprovedIB, undefined);
});

test("an owner can explicitly approve from reviewed KYC; managers cannot trigger reconsideration", async t => {
  const { user, requests } = setup(t);
  const denied = response(); await controller.approveIBByEmail({ params: { email: user.email }, principal: { adminRole: "manager" } }, denied);
  assert.equal(denied.code, 403); assert.equal(requests.length, 0);
  const accepted = response(); const req = { params: { email: user.email }, principal: { adminRole: "owner" } };
  await controller.approveIBByEmail(req, accepted); assert.equal(accepted.code, 200);
  assert.equal(requests[0].options.reconsiderRejected, true); assert.equal(req.auditTargetId, "synthetic-ib");
});

test("manual rejection cannot hide its reason from the applicant", async t => {
  const { user, broker } = setup(t, "manual"); let saves = 0; broker.save = async () => { saves++; };
  const res = response(); await controller.rejectIBByEmail({ params: { email: user.email }, body: {} }, res);
  assert.equal(res.code, 400); assert.equal(saves, 0);
});
