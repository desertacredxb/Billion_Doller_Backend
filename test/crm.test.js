const assert = require("node:assert/strict");
const test = require("node:test");
const { dubaiDay, importLeads, planAssignments, staffScope, TARGET } = require("../services/crm.service");
const { authorizedReport, buildCallParameters, parseReport, setAgent } = require("../services/crmHashmi.service");
const Lead = require("../models/CrmLead");
const Staff = require("../models/AdminAccount");

test("lead imports recover from early model initialization failure and retry index creation before writing", async t => {
  const indexes = [];
  const saved = new Set();
  const init = t.mock.method(Lead, "init", async () => { throw new TypeError("Cached early initialization failure"); });
  const staffQuery = { select: () => staffQuery, sort: () => staffQuery, lean: async () => [] };
  t.mock.method(Staff, "find", () => staffQuery);
  let failFirstIndex = true;
  t.mock.method(Lead.collection, "createIndex", async (keys, options) => {
    if (failFirstIndex) {
      failFirstIndex = false;
      throw new Error("Temporary index creation failure");
    }
    indexes.push({ keys, unique: options.unique === true });
  });
  const write = t.mock.method(Lead.collection, "bulkWrite", async operations => {
    assert.ok(indexes.some(index => index.keys.phone === 1 && index.unique));
    assert.ok(indexes.some(index => index.keys.leadId === 1 && index.unique));
    const before = saved.size;
    for (const { updateOne } of operations) {
      assert.equal(updateOne.upsert, true);
      assert.equal(updateOne.update.$setOnInsert.phone, updateOne.filter.phone);
      saved.add(updateOne.filter.phone);
    }
    return { upsertedCount: saved.size - before };
  });
  const rows = [{ phone: "+12025550101", source: "Import test" }];
  await assert.rejects(() => importLeads(rows), /Temporary index creation failure/);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(await importLeads(rows), { imported: 1, duplicates: 0, rejected: [] });
  assert.deepEqual(await importLeads(rows), { imported: 0, duplicates: 1, rejected: [] });
  assert.equal(indexes.length, Lead.schema.indexes().length);
  assert.equal(init.mock.callCount(), 0);
});

test("Hashmi mapping verifies its unique index and updates the active CRM account", async () => {
  const calls = [];
  const staffId = "111111111111111111111111";
  const staff = {
    listIndexes: async () => [],
    collection: { createIndex: async (...args) => calls.push(args) },
    findOneAndUpdate: (filter, update) => {
      assert.equal(String(filter._id), staffId);
      assert.equal(filter.enabled, true);
      assert.equal(filter.permissions, "crm");
      calls.push(update);
      return { select: () => ({ lean: async () => ({ _id: staffId }) }) };
    },
  };
  const config = { userId: "123456789" };
  await assert.rejects(() => setAgent(staffId, config.userId, { staff, config }), { status: 400 });
  assert.equal(calls.length, 0);
  await setAgent(staffId, "12345", { staff, config });
  assert.deepEqual(calls, [
    [{ crmHashmiAgentId: 1 }, { name: "crmHashmiAgentId_1", unique: true, sparse: true }],
    { $set: { crmHashmiAgentId: "12345" } },
  ]);
});
const { permissionForRequest } = require("../services/adminPolicy");

test("CRM allocation covers the least-filled queue and stops at each agent's target", () => {
  const staff = [{ _id: "A" }, { _id: "B" }, { _id: "C" }];
  const stats = new Map([
    ["A", { ready: 2, verified: TARGET - 2 }],
    ["B", { ready: 0, verified: TARGET - 3 }],
    ["C", { ready: 1, verified: TARGET - 3 }],
  ]);
  const available = Array.from({ length: 8 }, (_, i) => ({ _id: String(i + 1) }));
  assert.deepEqual(planAssignments(staff, stats, available), [
    { lead: "1", agent: "B" }, { lead: "2", agent: "B" }, { lead: "3", agent: "C" },
    { lead: "4", agent: "B" }, { lead: "5", agent: "C" },
  ]);
  assert.deepEqual(planAssignments([], stats, available), []);
});

test("CRM routes use their own permission and an agent's assignment is enforced at query time", () => {
  const own = "64a18b33dd4fb15a2b01c001";
  assert.equal(permissionForRequest({ originalUrl: "/api/crm/leads?agent=other" }), "crm");
  assert.equal(String(staffScope({ id: own, adminRole: "manager" }).assignedTo), own);
  assert.deepEqual(staffScope({ adminRole: "owner" }), {});
  assert.equal(dubaiDay("2026-11-11").start.toISOString(), "2026-11-10T20:00:00.000Z");
  assert.throws(() => dubaiDay("2026-02-30"), /valid Dubai date/);
});

test("Hashmi Quick Calls count customer attempts, connected talk time and matching account only", () => {
  const config = { userId: "crm-test", offset: "+05:30" };
  const payload = { callId: "qc-example", userId: "crm-test", cType: "QC", cNumber: "12025550101",
    masterAgent: 9, ivrSTime: "2026-11-11 01:30:00", callStatus: 6, talkDuration: 12 };
  const parsed = parseReport(payload, config);
  assert.equal(parsed.occurredAt.toISOString(), "2026-11-10T20:00:00.000Z");
  assert.deepEqual(parsed.agentIds, ["9"]);
  assert.equal(parsed.attempted, true);
  assert.equal(parsed.connected, false);
  assert.equal(parsed.talkSeconds, 0);
  assert.equal(parseReport({ ...payload, callStatus: 7 }, config).attempted, false);
  assert.equal(parseReport({ ...payload, callStatus: 3 }, config).connected, true);
  assert.equal(parseReport({ ...payload, callStatus: 3 }, config).talkSeconds, 12);
  assert.equal(parseReport({ ...payload, userId: "other-business" }, config), null);
  assert.equal(parseReport({ ...payload, cType: "IBD" }, config), null);
  assert.equal(parseReport(payload, { ...config, offset: "" }), null);
});

test("Hashmi test requests use only the selected agent and reports require the configured secret", () => {
  const config = { userId: "crm-test", token: "fixture", key: "a".repeat(32), mode: "developer" };
  const body = buildCallParameters(config, "+12025550101", "9");
  assert.equal(body.get("agentType"), "agent_id");
  assert.equal(body.get("agent_id"), "9");
  assert.equal(body.get("callFirst"), "agent");
  assert.equal(body.get("mode"), "developer");
  assert.equal(authorizedReport("a".repeat(32), config), true);
  assert.equal(authorizedReport("b".repeat(32), config), false);
  assert.equal(authorizedReport(undefined, config), false);
});
