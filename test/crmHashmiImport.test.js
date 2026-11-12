const assert = require("node:assert/strict");
const test = require("node:test");
const { exportRow, importHashmiRows } = require("../services/crmHashmiImport.service");

const row = { row: 2, callId: "provider-call-id", phone: "9876543210", type: "Quick Call", date: "12/Nov/2026",
  time: "8:33:01 pm", status: "Both Answered", talkDuration: "00:00:25", agents: ["10953"] };

test("Hashmi export preserves talk time and distinguishes outbound attempts from agent-only failures", () => {
  const agents = new Map([["10953", "crm-agent"]]);
  const parse = overrides => exportRow({ ...row, ...overrides }, agents, "+05:30");
  assert.deepEqual(parse({}), { callId: "provider-call-id", phone: "+919876543210", agent: "crm-agent",
    occurredAt: new Date("2026-11-12T15:03:01Z"), status: "Both Answered", attempted: true, connected: true, talkSeconds: 25 });
  assert.equal(parse({ status: "From Ans. - To Unans." }).attempted, true);
  assert.equal(parse({ status: "Agent Unanswered" }).attempted, false);
  assert.equal(parse({ status: "" }).attempted, false);
  assert.equal(parse({ type: "Inbound" }).skipped, true);
  assert.match(parse({ agents: ["10952"] }).error, /mapped BDFX caller/);
  assert.match(parse({ date: "31/Feb/2026" }).error, /date or time/);
});

test("Hashmi import links history and only inserts missing contacts", async () => {
  const query = data => ({ select: () => ({ lean: async () => data }) });
  const writes = {};
  const summary = await importHashmiRows([row, { ...row, row: 3 }, { ...row, row: 4, type: "Inbound" }], {
    staff: { find: () => query([{ _id: "crm-agent", crmHashmiAgentId: "10953" }]) },
    leads: { find: () => query([{ _id: "existing-lead", phone: "+919876543210" }]),
      bulkWrite: async input => { writes.leads = input; return { upsertedCount: 0 }; } },
    calls: { find: () => query([{ eventKey: "hashmi:provider-call-id", agent: "crm-agent", attempted: true, connected: true, talkSeconds: 0 }]),
      bulkWrite: async input => { writes.calls = input; return { upsertedCount: 0, modifiedCount: 1 }; } },
    ensureIndexes: async () => {}, account: {},
  });
  assert.deepEqual(summary, { added: 0, updated: 1, existing: 1, leadsAdded: 0, skipped: 1, rejected: [] });
  assert.deepEqual(Object.keys(writes.leads[0].updateOne.update), ["$setOnInsert"]);
  assert.deepEqual(writes.calls[0].updateOne.update.$set, { lead: "existing-lead", attempted: true, connected: true, talkSeconds: 25,
    hashmiExportStatus: "Both Answered" });
});
