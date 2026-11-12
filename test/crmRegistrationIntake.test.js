const assert = require("node:assert/strict");
const test = require("node:test");
const { createIntake } = require("../services/crmRegistrationIntake.service");
const { listLeads, recordOutcome, syncRegisteredLeads } = require("../services/crm.service");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");

const at = new Date("2026-11-12T10:00:00Z");
const agent = "64a18b33dd4fb15a2b01c001";
const person = "64a18b33dd4fb15a2b01c002";
const leadId = "64a18b33dd4fb15a2b01c003";

test("intake reads completed registrations, catches newly opened accounts and assigns after saving", async () => {
  const queries = [];
  const steps = [];
  const rows = [
    { _id: person, fullName: "CRM test", phone: "09999888888", country: "India", createdAt: at },
    { _id: "other", phone: "+971501234567", country: "UAE", createdAt: at },
  ];
  const users = { find(filter) {
    queries.push(filter);
    return { select: () => ({ lean: () => ({ async *cursor() { yield* rows; } }) }) };
  } };
  const accounts = { async distinct(field, filter) {
    assert.equal(field, "user");
    assert.equal(filter.accountType, "LIVE");
    return [person];
  } };
  const { tick } = createIntake({ users, accounts, now: () => at, logger: { log() {}, error(error) { assert.fail(error); } },
    async save(leads) {
      assert.deepEqual(leads, [{ userId: person, phone: "+919999888888", name: "CRM test", registeredAt: at, accountOpened: true }]);
      steps.push("save");
      return 1;
    },
    async assign() { steps.push("assign"); return { assigned: 0 }; },
  });
  await tick();
  await tick();
  assert.deepEqual(steps, ["save", "assign", "save", "assign"]);
  assert.deepEqual(queries[0], { isVerified: true });
  assert.deepEqual(queries[1], { isVerified: true, $or: [{ updatedAt: { $gte: new Date(+at - 120_000) } }, { _id: { $in: [person] } }] });
});

test("registration upserts keep existing ownership, call outcomes, source and conversion credit", async t => {
  t.mock.method(Lead.collection, "createIndex", async () => {});
  t.mock.method(Lead.collection, "bulkWrite", async ([{ updateOne }]) => {
    assert.equal(updateOne.upsert, true);
    assert.equal(updateOne.filter.phone, "+919999888888");
    assert.deepEqual(Object.keys(updateOne.update.$set).sort(), ["accountOpened", "registeredAt", "registrationName", "registrationUserId"]);
    assert.equal(updateOne.update.$setOnInsert.source, "Website registration");
    assert.equal(updateOne.update.$setOnInsert.status, "new");
    assert.equal(updateOne.update.$setOnInsert.assignedTo, null);
    return { upsertedCount: 0 };
  });
  assert.equal(await syncRegisteredLeads([{ userId: person, phone: "+919999888888", name: "CRM test", registeredAt: at, accountOpened: true }]), 0);
});

test("separate lists apply the caller's own assignment scope", async t => {
  const filters = [];
  const query = { sort: () => query, skip: () => query, limit: () => query, lean: async () => [] };
  t.mock.method(Lead, "find", filter => { filters.push(filter); return query; });
  t.mock.method(Lead, "countDocuments", async () => 0);
  for (const view of ["follow_ups", "interested", "account_opened", "purchased", "registrations", "number_not_in_use"]) {
    await listLeads({ id: agent, adminRole: "manager" }, { view, agent: person });
  }
  assert.ok(filters.every(filter => String(filter.$and[0].assignedTo) === agent));
  assert.deepEqual(filters.map(filter => filter.$and.at(-1)), [
    { status: "follow_up" }, { lastOutcome: "qualified", status: { $ne: "closed" }, accountOpened: { $ne: true } },
    { accountOpened: true }, { source: /^(COMEXFOREX|purchased data)$/i }, { registeredAt: { $type: "date" } },
    { status: "closed", lastOutcome: "number_not_in_use" },
  ]);
});

test("number not in use closes the lead and preserves the caller's note", async t => {
  let lastOutcome;
  t.mock.method(Lead, "findOne", () => ({ select: () => ({ lean: async () => ({ lastOutcome }) }) }));
  t.mock.method(Call.collection, "createIndex", async () => {});
  t.mock.method(Call, "findOneAndUpdate", (_filter, update) => ({ lean: async () => update.$setOnInsert }));
  const update = t.mock.method(Lead, "updateOne", async (filter, changes) => {
    assert.equal(String(filter.assignedTo), agent);
    assert.equal(changes.$set.lastNote, "Carrier says the line is disconnected");
    assert.equal(changes.$set.followUpAt, null);
    lastOutcome = changes.$set.lastOutcome;
  });
  const body = { requestId: "198e1ff4-df44-4044-a322-11f8786ec761", note: "Carrier says the line is disconnected" };
  const principal = { id: agent };
  assert.deepEqual(await recordOutcome(principal, leadId, { ...body, outcome: "number_not_in_use" }), { saved: true, status: "closed" });
  await assert.rejects(recordOutcome(principal, leadId, { ...body, outcome: "connected" }), { status: 409 });
  assert.equal(update.mock.callCount(), 1);
});
