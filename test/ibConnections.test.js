const test = require("node:test");
const assert = require("node:assert/strict");
const { createController } = require("../controllers/ibConnectionsController");
const User = require("../models/User");

test("IB report is restricted to its current approved relationship and serializes no private profile fields", async () => {
  const filters = [];
  const query = { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, populate() { return this; },
    lean: async () => [{ _id: "client-1", fullName: "Test Client", createdAt: new Date(), isKycVerified: true, password: "test-password", phone: "test-phone", idProof1: {}, accounts: [{ accountNo: 1001, mt5Password: "test-password" }] }] };
  const controller = createController({ ibs: { findOne: async filter => { assert.equal(filter.email, "ib@example.invalid"); assert.equal(filter.status, "approved"); return { _id: "ib-1", referralCode: "TESTCODE" }; } },
    users: { find: filter => { filters.push(filter); return query; }, countDocuments: async () => 1 } });
  const res = { set() {}, json(data) { this.data = data; } };
  await controller.getConnections({ principal: { email: "ib@example.invalid" }, query: { email: "other@example.invalid" } }, res, error => { throw error; });
  assert.equal(filters[0].$or[0].referredByIB, "ib-1");
  assert.equal(filters[0].$or[1].referredByIB, null);
  assert.deepEqual(Object.keys(res.data.connections[0]).sort(), ["accounts", "createdAt", "fullName", "id", "isKycVerified"]);
  assert.deepEqual(res.data.connections[0].accounts, [{ accountNo: 1001 }]);
});

test("user serialization strips passwords and all OTP fields from login and profile responses", () => {
  const user = new User({ email: "test@example.invalid", password: "dummy-password-hash", otp: "123456", resetOtp: "654321", otpExpires: new Date(), resetOtpExpires: new Date() });
  const payload = user.toJSON();
  for (const key of ["password", "otp", "otpExpires", "resetOtp", "resetOtpExpires"]) assert.equal(Object.hasOwn(payload, key), false);
});
