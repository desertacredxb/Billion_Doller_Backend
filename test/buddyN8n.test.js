const test = require("node:test");
const assert = require("node:assert/strict");
const { createBuddyService, reportAuthorized } = require("../services/buddyN8n.service");
const { createReportService } = require("../services/buddyReport.service");
const { createRouter } = require("../routes/buddyN8nRoutes");
const env = { BDFX_BUDDY_N8N_ENABLED: "true", BDFX_BUDDY_N8N_WEBHOOK_URL: "https://n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1", BDFX_BUDDY_N8N_TOKEN: "x".repeat(40), BDFX_N8N_REPORT_TOKEN: "y".repeat(40) };
const request = { consent: true, language: "hi", message: "How do I start identity verification?", contextQuestion: 2 };
test("n8n bridge stays disabled for incomplete configuration, untrusted URLs or missing consent", async () => {
  for (const patch of [{ BDFX_BUDDY_N8N_ENABLED: "false" }, { BDFX_BUDDY_N8N_TOKEN: "short" },
    { BDFX_BUDDY_N8N_WEBHOOK_URL: "http://127.0.0.1/webhook/bdfx-buddy-v1" },
    { BDFX_BUDDY_N8N_WEBHOOK_URL: env.BDFX_BUDDY_N8N_WEBHOOK_URL + "?key=private" },
    { BDFX_BUDDY_N8N_WEBHOOK_URL: "https://user:pass@n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1" }]) {
    const service = createBuddyService({ env: { ...env, ...patch }, post: () => assert.fail("network call") });
    assert.equal(service.available(), false); assert.equal((await service.reply(request)).status, 503);
  }
  const service = createBuddyService({ env, post: () => assert.fail("network call") });
  for (const patch of [{ consent: false }, { language: "xx" }, { message: "" }, { contextQuestion: 14 }, { extra: "private" }, { message: "x".repeat(1001) }]) assert.equal((await service.reply({ ...request, ...patch })).status, 400);
});
test("n8n receives only explicitly consented text and safe context, never request headers or visitor identifiers", async () => {
  let called = 0;
  const service = createBuddyService({ env, post: async (url, body, options) => {
    called++; assert.equal(url, env.BDFX_BUDDY_N8N_WEBHOOK_URL);
    assert.deepEqual(Object.keys(body).sort(), ["contextQuestion", "language", "message", "requestId"]);
    assert.equal(body.language, "hi"); assert.equal(body.contextQuestion, 2);
    assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 10000);
    assert.deepEqual(Object.keys(options.headers), ["X-BDFX-Buddy-Key"]);
    return { data: { answer: "वेरिफिकेशन के लिए सुरक्षित क्लाइंट क्षेत्र खोलें।", language: "hi" } };
  } });
  assert.equal((await service.reply(request)).status, 200); assert.equal(called, 1);
  for (const message of ["email me at person@example.test", "my code is 123456", "wallet 0x" + "a".repeat(40)]) {
    assert.equal((await service.reply({ ...request, message })).body.code, "REMOVE_PRIVATE_DETAILS");
  }
  assert.equal(called, 1);
});
test("upstream errors and unsafe or malformed model output return a local fallback state without leaking details", async () => {
  for (const data of [{ answer: "wrong language", language: "en" }, { answer: "<script>bad</script>", language: "hi" },
    { answer: "https://example.test/steal", language: "hi" }, { answer: "https://www.billiondollarfx.com.evil.test/", language: "hi" },
    { answer: "https://www.billiondollarfx.com/register?token=private", language: "hi" }, { answer: "x".repeat(2401), language: "hi" }, {}]) {
    const service = createBuddyService({ env, post: async () => ({ data }) });
    assert.deepEqual(await service.reply(request), { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
  }
  const service = createBuddyService({ env, post: async () => { throw new Error("private provider token"); } });
  assert.equal(JSON.stringify(await service.reply(request)).includes("private"), false);
});
test("report authentication has a separate scoped key and fails closed", () => {
  assert.equal(reportAuthorized(env.BDFX_N8N_REPORT_TOKEN, env.BDFX_N8N_REPORT_TOKEN), true);
  for (const key of [undefined, "", env.BDFX_BUDDY_N8N_TOKEN, "z".repeat(300)]) assert.equal(reportAuthorized(key, env.BDFX_N8N_REPORT_TOKEN), false);
  assert.equal(reportAuthorized("", ""), false);
});
test("reports use Dubai bounds and export only aggregate consented activity", async () => {
  const counts = [], pipelines = [];
  const report = createReportService({ now: () => new Date("2026-10-25T13:00:00Z"), sessions: {
    countDocuments: async filter => { counts.push(filter); return counts.length; },
    aggregate: async pipeline => { pipelines.push(pipeline); return [
      { _id: { type: "topic", language: "hi", topic: "verification" }, count: 2 },
      { _id: { type: "answer", language: "en", question: 2 }, count: 1 },
      { _id: { type: "team", language: "hi" }, count: 1 },
    ]; },
  } });
  const data = await report("7");
  assert.deepEqual(data.period, { from: "2026-10-19", to: "2026-10-25", timezone: "Asia/Dubai" });
  assert.equal(counts[0].createdAt.$gte.toISOString(), "2026-10-18T20:00:00.000Z");
  assert.equal(counts[0].consentVersion, "support-chat-2026-10");
  assert.deepEqual(pipelines[0][1], { $project: { events: 1 } });
  assert.equal(data.sessionsStarted, 1); assert.equal(data.sessionsWithActivity, 2); assert.equal(data.contactRequests, 3);
  assert.equal(data.topicSelections.verification, 2); assert.equal(data.answersViewed[2], 1); assert.equal(data.supportHandoffs, 1);
  assert.equal(data.email, undefined); assert.equal(data.contact, undefined); assert.equal(data.sessions, undefined);
  await assert.rejects(report("100"));
});
test("report endpoint denies anonymous/wrong-key requests and never presents storage errors as zero activity", async t => {
  const express = require("express"), app = express(); let calls = 0;
  app.use(createRouter({ env, buddy: { available: () => false, reply: async () => ({ status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } }) }, report: async () => { calls++; throw new Error("database unavailable"); } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/report")).status, 401);
  assert.equal((await fetch(base + "/report", { headers: { "X-BDFX-Report-Key": env.BDFX_BUDDY_N8N_TOKEN } })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await fetch(base + "/report?days=365", { headers: { "X-BDFX-Report-Key": env.BDFX_N8N_REPORT_TOKEN } })).status, 400);
  const res = await fetch(base + "/report?days=7", { headers: { "X-BDFX-Report-Key": env.BDFX_N8N_REPORT_TOKEN } });
  assert.equal(res.status, 503); assert.equal((await res.json()).code, "REPORT_UNAVAILABLE");
  assert.equal(res.headers.get("cache-control"), "no-store"); assert.equal(calls, 1);
});
