const assert = require("node:assert/strict");
const test = require("node:test");
const Staff = require("../models/AdminAccount");
const IB = require("../models/Broker.model");
const User = require("../models/User");
const Lead = require("../models/CrmLead");
const { listIbClients, resolveLinks } = require("../services/crmIbClients.service");
const { listLeads } = require("../services/crm.service");

const a = "60f000000000000000000001";
const b = "60f000000000000000000002";
const agents = [{ _id: a, fullName: "A", email: "a@example.test" }, { _id: b, fullName: "B", email: "b@example.test" }];
const brokers = [{ _id: "ibA", email: "A@example.test", referralCode: "OLD_A" }, { _id: "ibB", email: "b@example.test", referralCode: "OLD_B" }];
function query(rows) {
  return { select() { return this; }, collation() { return this; }, sort() { return this; }, skip() { return this; },
    limit() { return this; }, lean: async () => rows };
}

test("IB links use an unambiguous email or the explicit owner link, never an agent name", () => {
  assert.equal(resolveLinks(agents, brokers).length, 2);
  const ambiguous = [...brokers, { _id: "second", email: agents[0].email }];
  assert.deepEqual(resolveLinks(agents, ambiguous).map(link => link.agent._id), [b]);
  assert.deepEqual(resolveLinks([{ ...agents[0], crmIbId: "ibB" }, agents[1]], brokers).map(link => link.agent._id), [a]);
});

test("agent IB list ignores a foreign agent filter, supports legacy referrals and shows a pending signup without a CRM lead", async t => {
  t.mock.method(Staff, "find", () => query(agents));
  t.mock.method(IB, "find", filter => { assert.equal(filter.status, "approved"); return query(brokers); });
  t.mock.method(User, "find", filter => {
    assert.deepEqual(filter.$and[0], { $or: [{ referredByIB: { $in: ["ibA"] } }, { referredByIB: null, referralCode: { $in: ["OLD_A"] } }] });
    return query([{ _id: "client", fullName: "Client", referralCode: "OLD_A" }]);
  });
  t.mock.method(User, "countDocuments", async () => 1);
  const data = await listIbClients({ id: a, adminRole: "manager", permissions: ["crm"] }, { agent: b });
  assert.equal(data.total, 1);
  assert.equal(data.rows[0].agentName, "A");
  assert.equal(data.rows[0].verified, false);
  assert.equal(data.referralCode, undefined);
});

test("fresh, due and exact saved outcome lists retain the agent scope", async t => {
  const filters = [];
  t.mock.method(Lead, "find", filter => { filters.push(filter.$and); return query([]); });
  t.mock.method(Lead, "countDocuments", async () => 0);
  const principal = { id: a, adminRole: "manager", permissions: ["crm"] };
  for (const params of [{ view: "queue", queue: "fresh" }, { view: "queue", queue: "callbacks" }, { view: "outcome_switched_off" }]) {
    await listLeads(principal, { ...params, agent: b });
  }
  assert.ok(filters.every(parts => String(parts[0].assignedTo) === a));
  assert.ok(filters[0].some(part => part.status === "new"));
  assert.ok(filters[1].some(part => part.status === "follow_up"));
  assert.ok(filters[2].some(part => part.lastOutcome === "switched_off"));
  await assert.rejects(listLeads(principal, { view: "outcome_unknown" }), { status: 400 });
});

test("one saved outcome allocates one fresh lead, retries reuse it and an empty bank keeps the request pending", async t => {
  const { allocate } = require("../services/crmOutcomeRefill.service");
  const Call = require("../models/CrmCall");
  const event = { _id: "ev", refillState: "pending", refillAgent: a, lead: "called" };
  const available = [{ _id: "next", assignedTo: a, phone: "+12025550123", status: "new" }];
  let allocations = 0;
  const session = {};
  t.mock.method(Call, "findOne", () => query(event));
  t.mock.method(Staff, "exists", () => ({ session: async () => true }));
  t.mock.method(Lead, "findOneAndUpdate", (filter, update, opts) => {
    assert.equal(filter.assignedTo, null);
    assert.equal(filter.status, "new");
    assert.equal(filter.lastOutcome, null);
    assert.equal(filter._id.$ne, "called");
    assert.equal(opts.session, session);
    assert.equal(update.$set.assignedTo, a);
    const next = available.shift();
    if (next) allocations++;
    return query(next);
  });
  t.mock.method(Call, "updateOne", async (filter, update, opts) => {
    assert.equal(filter.refillState, "pending");
    assert.equal(opts.session, session);
    Object.assign(event, update.$set);
  });
  t.mock.method(Lead, "findOne", filter => {
    assert.equal(filter._id, "next");
    assert.equal(filter.assignedTo, a);
    return query({ _id: "next", assignedTo: a, status: "new" });
  });
  assert.equal((await allocate("outcome:fixture", a, session)).lead.id, "next");
  assert.equal((await allocate("outcome:fixture", a, session)).lead.id, "next");
  assert.deepEqual(await allocate("outcome:fixture", b, session), { state: "assigned" });
  assert.equal(allocations, 1);
  event.refillState = "pending";
  assert.deepEqual(await allocate("outcome:other", a, session), { state: "pending" });
  assert.equal(event.refillState, "pending");
});
