const assert = require("node:assert/strict");
const test = require("node:test");
const { createHashmiSync } = require("../services/crmHashmiSync.service");

test("Hashmi report polling scopes both queries and credits to mapped BDFX agents", async () => {
  const requests = [];
  const saved = [];
  const agent = { _id: "bdfx-agent", crmHashmiAgentId: "10953" };
  const reports = {
    "connected-call": { callStatus: 3, custAnswerSTime: "2026-11-12 08:32:00", talkDuration: 32 },
    "customer-failed": { callStatus: 4, nH: ["919876543210"], talkDuration: 18 },
    "agent-only": { callStatus: 1, talkDuration: 20 },
    "different-agent": { masterAgent: "10952", callStatus: 3, custAnswerSTime: "2026-11-12 08:32:00" },
  };
  const sync = createHashmiSync({
    config: () => ({ userId: "provider-account", token: "test-token", mode: "live" }),
    now: () => new Date("2026-11-12T16:00:00Z"),
    staff: { find: filter => {
      assert.equal(filter.permissions, "crm");
      return { select: () => ({ lean: async () => [agent] }) };
    } },
    calls: { distinct: async () => [] },
    save: async (report, staffMember) => { saved.push({ report, staffMember }); return true; },
    logger: { log() {}, warn: (...args) => assert.fail(args.join(" ")) },
    request: async (url, payload) => {
      requests.push({ url, payload });
      if (url.endsWith("/list")) return { data: { data: Object.keys(reports).map(callId => ({ callId })) } };
      const callId = payload.clId;
      return { data: { data: { callId, userId: "provider-account", cType: "CTC", cNumber: "919876543210",
        masterAgent: "10953", ivrSTime: "2026-11-12 08:31:00", ...reports[callId] } } };
    },
  });
  await sync.tick();
  await sync.tick();
  assert.deepEqual(requests[0].payload.filter, { agtIds: ["10953"], dtGte: "2026-11-12 01:15:00", dtLte: "2026-11-12 21:30:00" });
  assert.equal(requests.filter(request => request.url.endsWith("/detail")).length, 4);
  assert.deepEqual(saved.map(({ report, staffMember }) => [report.callId, staffMember._id, report.connected, report.talkSeconds]), [
    ["connected-call", "bdfx-agent", true, 32], ["customer-failed", "bdfx-agent", false, 0],
  ]);
});
