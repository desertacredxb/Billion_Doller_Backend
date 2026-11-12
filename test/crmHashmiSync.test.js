const assert = require("node:assert/strict");
const test = require("node:test");
const { createHashmiSync } = require("../services/crmHashmiSync.service");

test("Hashmi report polling scopes both queries and credits to mapped BDFX agents", async () => {
  const requests = [];
  const saved = [];
  const agent = { _id: "bdfx-agent", crmHashmiAgentId: "10953" };
  const reports = {
    "connected-call": { masterAgent: undefined, mAgent: { agentId: 10953 }, ivrSTime: undefined, startTime: {} },
    "customer-failed": { callStatus: 4, nH: ["919876543210"], talkDuration: 18 },
    "agent-only": { callStatus: 1, talkDuration: 20 },
    "different-agent": { masterAgent: "10952", callStatus: 3, custAnswerSTime: "2026-11-12 08:32:00" },
    "connected-duration": { callStatus: 3, duration: { talk: 22, ivr: 18 } },
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
      if (url.endsWith("/list")) return { data: { data: Object.keys(reports).map(clId => ({ clId,
        st: "Both Answered", tkTmDurAr: clId === "connected-duration" ? [] : [{ start: "8:32:00 pm", end: "8:32:20 pm" },
          { start: "8:32:14 pm", end: "8:32:32 pm" }], clSTm: Date.parse("2026-11-12T03:01:00Z"),
      })) } };
      const callId = payload.clId;
      return { data: { data: { callId, userId: "provider-account", cType: "CTC", cNumber: "919876543210",
        masterAgent: "10953", ivrSTime: "2026-11-12 08:31:00", ...reports[callId] } } };
    },
  });
  await sync.tick();
  await sync.tick();
  assert.deepEqual(requests[0].payload.filter, { agtIds: ["10953"], dtGte: "2026-11-12 01:15:00", dtLte: "2026-11-12 21:30:00" });
  assert.equal(requests.filter(request => request.url.endsWith("/detail")).length, 5);
  assert.deepEqual(saved.map(({ report, staffMember }) => [report.callId, staffMember._id, report.connected, report.talkSeconds]), [
    ["connected-call", "bdfx-agent", true, 32], ["customer-failed", "bdfx-agent", false, 0], ["connected-duration", "bdfx-agent", true, 22],
  ]);
});

test("full Hashmi report pages send the provider continuation cursor", async () => {
  const requests = [];
  const next = [1794501000000, "last-call"];
  const data = Array.from({ length: 100 }, (_, index) => ({ clId: "existing-" + index }));
  const sync = createHashmiSync({
    config: () => ({ userId: "account", token: "test-token", mode: "live" }),
    staff: { find: () => ({ select: () => ({ lean: async () => [{ crmHashmiAgentId: "10953" }] }) }) },
    calls: { distinct: async () => data.map(row => row.clId) },
    logger: { log() {}, warn: (...args) => assert.fail(args.join(" ")) },
    request: async (url, payload) => {
      assert.match(url, /\/list$/);
      requests.push(payload);
      return { data: requests.length === 1 ? { data, next } : { data: [] } };
    },
  });
  await sync.tick();
  await sync.tick();
  assert.deepEqual(requests[1].sAftr, next);
  assert.equal(requests[1].page, 1);
});
