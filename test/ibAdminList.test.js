const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const { getAllIBRequests } = require("../controllers/ibController");

test("the actual IB list query uses a collision-free Mongo projection and returns only public application fields", async t => {
  const originalFind = IB.find, originalCollectionFind = User.collection.find;
  t.after(() => { IB.find = originalFind; User.collection.find = originalCollectionFind; });
  const email = "synthetic@example.invalid";
  IB.find = () => ({ sort: async () => [{ email, approvalProvider: "manual", status: "rejected", statusReason: "Please correct the application details.", toObject() { return { _id: "synthetic-ib", email, status: this.status }; } }] });
  let queries = 0;
  User.collection.find = (filter, options) => {
    queries++; assert.deepEqual(filter.email.$in, [email]);
    const paths = Object.keys(options.projection).filter(path => options.projection[path] === 1);
    for (const parent of paths) assert.ok(!paths.some(path => path.startsWith(parent + ".")), `Mongo projection collision at ${parent}`);
    for (const field of ["veriff.status", "veriff.reasonCode", "veriff.mode", "veriff.sessionId", "veriff.integrationKeyHash", "kycManualReview"]) assert.equal(options.projection[field], 1);
    return { toArray: async () => [{ email, commission: 12, veriff: { integrationKeyHash: "private-synthetic-hash" }, kycManualReview: { reviewerId: "private-owner" } }] };
  };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await getAllIBRequests({}, res);
  assert.equal(res.code, 200); assert.equal(queries, 1); assert.ok(Array.isArray(res.data));
  assert.equal(res.data[0].commission, 12); assert.match(res.data[0].statusReason, /correct the application/);
  assert.ok(!JSON.stringify(res.data).includes("private-"));
});
