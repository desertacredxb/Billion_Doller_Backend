const test = require("node:test");
const assert = require("node:assert/strict");
const { withReferrerNames } = require("../services/adminUsers.service");
const doc = value => ({ toJSON: () => structuredClone(value) });
test("hundreds of clients resolve referrals with one batch lookup, including rotated codes", async () => {
  const brokerId = "111111111111111111111111", parentId = "222222222222222222222222";
  const list = [doc({ _id: parentId, email: "partner@example.invalid", fullName: "Partner" }), ...Array.from({ length: 350 }, (_, i) => doc({ _id: String(i), referralCode: "OLD", referredByIB: brokerId }))];
  let calls = 0, filter;
  const brokers = { find(f) { calls++; filter = f; return { select() { return this; }, maxTimeMS(n) { assert.equal(n, 5000); return this; }, lean: async () => [{ _id: brokerId, user: parentId, referralCode: "NEW" }] }; } };
  const result = await withReferrerNames(list, brokers);
  assert.equal(calls, 1); assert.equal(filter.$or[0].referralCode.$in.length, 1); assert.equal(result[350].referredByName, "Partner");
});
test("legacy IB email links and missing referrals resolve without extra user queries", async () => {
  const list = [doc({ _id: "parent", email: "Partner@Example.invalid", fullName: "Partner" }), doc({ _id: "client", referralCode: "CODE" }), doc({ _id: "unknown", referralCode: "UNKNOWN" })];
  const brokers = { find: () => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => [{ email: "partner@example.invalid", referralCode: "CODE" }] }) };
  const result = await withReferrerNames(list, brokers); assert.equal(result[1].referredByName, "Partner"); assert.equal(result[2].referredByName, "N/A");
  const noRefs = await withReferrerNames([doc({ _id: "only" })], { find() { throw Error("unnecessary lookup"); } }); assert.equal(noRefs.length, 1);
});
