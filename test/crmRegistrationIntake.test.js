const assert = require("node:assert/strict");
const test = require("node:test");
const { createIntake } = require("../services/crmRegistrationIntake.service");
const { assignedLeadByPhone, distribute, importLeads, listLeads, recordOutcome, renameLead, syncRegisteredLeads } = require("../services/crm.service");
const { dial } = require("../services/crmHashmi.service");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");
const Staff = require("../models/AdminAccount");
const AssignmentLock = require("../models/CrmAssignmentLock");
const { setLeadEmail, importLeadEmails } = require("../services/crm.service");

const at = new Date("2026-11-12T10:00:00Z");
const agent = "64a18b33dd4fb15a2b01c001";
const person = "64a18b33dd4fb15a2b01c002";
const leadId = "64a18b33dd4fb15a2b01c003";

test("editing a CRM email requires a matching lead assignment and touches only the contact email", async t => {
  const write = t.mock.method(Lead, "updateOne", async () => ({ matchedCount: 1 }));
  await assert.rejects(setLeadEmail({ id: agent }, leadId, "not-an-email"), { status: 400 });
  assert.deepEqual(await setLeadEmail({ id: agent }, leadId, " Agent@Example.test "), { email: "agent@example.test" });
  const [filter, update] = write.mock.calls[0].arguments;
  assert.equal(String(filter.assignedTo), agent);
  assert.deepEqual(update, { $set: { email: "agent@example.test" } });
  write.mock.mockImplementation(async () => ({ matchedCount: 0 }));
  await assert.rejects(setLeadEmail({ id: person }, leadId, "agent@example.test"), { status: 404 });
});

test("email-only imports skip conflicting rows and update only existing blank contacts", async t => {
  const bulk = t.mock.method(Lead, "bulkWrite", async () => ({ modifiedCount: 1 }));
  const result = await importLeadEmails([
    { phone: "+12025550101", email: "alex@example.test" }, { phone: "+12025550101", email: "other@example.test" },
    { phone: "+12025550102", email: " Contact@Example.test " }, { phone: "+12025550103", email: "" },
  ]);
  assert.equal(result.emailsAdded, 1);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(bulk.mock.calls[0].arguments[0], [{ updateOne: {
    filter: { phone: "+12025550102", email: { $in: [null, ""] } }, update: { $set: { email: "contact@example.test" } },
  } }]);
});

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
  const { tick } = createIntake({ users, accounts, reconcile: async () => { steps.push("reconcile"); return 0; }, now: () => at, logger: { log() {}, error(error) { assert.fail(error); } },
    async save(leads) {
      assert.deepEqual(leads, [{ userId: person, phone: "+919999888888", name: "CRM test", registeredAt: at, accountOpened: true }]);
      steps.push("save");
      return 1;
    },
    async assign() { steps.push("assign"); return { assigned: 0 }; },
  });
  await tick();
  await tick();
  assert.deepEqual(steps, ["save", "reconcile", "assign", "save", "assign"]);
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

test("team Work queue excludes unassigned stock and the bank view keeps caller scope", async t => {
  const query = { sort: () => query, skip: () => query, limit: () => query, lean: async () => [] };
  const filters = [];
  t.mock.method(Lead, "find", filter => { filters.push(filter); return query; });
  t.mock.method(Lead, "countDocuments", async filter => { assert.deepEqual(filter, filters.at(-1)); return 0; });
  const owner = { adminRole: "owner" };
  await listLeads(owner, { view: "queue", agent });
  await listLeads(owner, { view: "unassigned" });
  await listLeads({ id: person, adminRole: "manager", permissions: ["crm"] }, { view: "unassigned", agent });
  const [queue, bank, personal] = filters.map(filter => filter.$and);
  assert.equal(String(queue[0].assignedTo), agent);
  assert.deepEqual(queue.at(-1).assignedTo, { $ne: null });
  assert.equal(queue.at(-1).lastOutcome.$ne, "do_not_call");
  assert.deepEqual(queue.at(-1).$or[0], { status: "new", accountOpened: { $ne: true } });
  assert.ok(queue.at(-1).$or[1].followUpAt.$lte instanceof Date);
  assert.deepEqual(bank.at(-1), { assignedTo: null, assignmentPending: false, status: "new", accountOpened: { $ne: true }, lastOutcome: { $ne: "do_not_call" } });
  assert.equal(String(personal[0].assignedTo), person);
  assert.deepEqual(personal.at(-1), bank.at(-1));
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
  assert.deepEqual(await recordOutcome(principal, leadId, { ...body, outcome: "do_not_call", requestId: "7b204a2c-f26d-4510-a3f3-2d1f4506b9e1" }), { saved: true, status: "closed" });
  assert.equal(update.mock.calls[1].arguments[1].$set.assignmentPending, false);
  assert.equal(lastOutcome, "do_not_call");
});

test("CRM names and direct phone lookups are scoped to the caller's assigned leads", async t => {
  const principal = { id: agent, adminRole: "manager", permissions: ["crm"] };
  t.mock.method(Lead, "updateOne", async (filter, changes) => {
    assert.equal(String(filter.assignedTo), agent);
    assert.deepEqual(changes.$set, { contactName: "Corrected lead name" });
    return { matchedCount: String(filter._id) === leadId ? 1 : 0 };
  });
  t.mock.method(Lead, "findOne", filter => ({ select: () => ({ lean: async () => {
    assert.equal(String(filter.assignedTo), agent);
    return filter.phone === "+12025550101" ? { _id: leadId } : null;
  } }) }));
  assert.deepEqual(await renameLead(principal, leadId, " Corrected lead name "), { name: "Corrected lead name" });
  await assert.rejects(renameLead(principal, person, "Corrected lead name"), { status: 404 });
  assert.equal(await assignedLeadByPhone(principal, "+1 202-555-0101"), leadId);
  await assert.rejects(assignedLeadByPhone(principal, "+12025550102"), { status: 404 });
});

test("assignment requires a mapped CRM caller and never assigns imported opt-outs", async t => {
  const staff = [{ _id: agent, fullName: "Caller", crmHashmiAgentId: "10953" }];
  const queries = [];
  t.mock.method(Staff, "find", filter => {
    assert.equal(filter.permissions, "crm");
    assert.equal(filter.crmHashmiAgentId.test(""), false);
    assert.equal(filter.crmHashmiAgentId.test("10953"), true);
    return { select: () => ({ sort: () => ({ lean: async () => staff }) }) };
  });
  t.mock.method(AssignmentLock, "updateOne", async () => {});
  t.mock.method(AssignmentLock, "deleteOne", async () => {});
  t.mock.method(Lead, "bulkWrite", async ([operation]) => {
    if (operation.updateMany) {
      assert.deepEqual(operation.updateMany.filter.lastOutcome, { $ne: "do_not_call" });
      return { modifiedCount: 0 };
    }
    queries.push(operation.updateOne.update.$setOnInsert);
    return { upsertedCount: 1 };
  });
  t.mock.method(Lead, "aggregate", async () => [{ _id: agent, ready: 300 }]);
  t.mock.method(Call, "aggregate", async () => []);
  assert.deepEqual(await distribute(), { assigned: 0 });
  await importLeads([{ phone: "+12025550101", creditedAgent: "Caller", doNotCall: true }]);
  await importLeads([{ phone: "+12025550102", creditedAgent: "Unmapped caller" }]);
  assert.equal(queries[0].assignedTo, null);
  assert.equal(queries[0].assignmentPending, false);
  assert.equal(queries[0].lastOutcome, "do_not_call");
  assert.equal(queries[1].assignedTo, null);
  assert.equal(queries[1].assignmentPending, true);
});

test("an opted-out lead cannot reach Hashmi even if its old status is still new", async t => {
  const env = process.env;
  t.mock.method(Staff, "findOne", () => ({ select: () => ({ lean: async () => ({ crmHashmiAgentId: "10953" }) }) }));
  t.mock.method(Lead, "findOneAndUpdate", filter => {
    assert.deepEqual(filter.lastOutcome, { $ne: "do_not_call" });
    return { lean: async () => null };
  });
  t.mock.method(Lead, "findOne", () => ({ select: () => ({ lean: async () => ({ status: "new", lastOutcome: "do_not_call" }) }) }));
  const previous = [env.BDFX_HASHMI_USER_ID, env.BDFX_HASHMI_API_TOKEN];
  env.BDFX_HASHMI_USER_ID = "fixture";
  env.BDFX_HASHMI_API_TOKEN = "fixture";
  t.after(() => ["BDFX_HASHMI_USER_ID", "BDFX_HASHMI_API_TOKEN"].forEach((name, index) => {
    if (previous[index] === undefined) delete env[name];
    else env[name] = previous[index];
  }));
  await assert.rejects(dial({ id: agent }, leadId, "198e1ff4-df44-4044-a322-11f8786ec761", () => assert.fail("Hashmi was called")), { status: 409 });
});
