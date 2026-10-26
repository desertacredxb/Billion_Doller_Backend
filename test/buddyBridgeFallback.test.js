const test = require("node:test"), assert = require("node:assert/strict");
const { createWorker } = require("../services/buddyAiWorker.service");
const { createBuddyService } = require("../services/buddyN8n.service");
const env = { BDFX_BUDDY_AI_PROVIDER: "gemini", BDFX_BUDDY_GEMINI_API_KEY: "fixture-gemini-secret-not-a-real-key", BDFX_BUDDY_GEMINI_MODEL: "gemini-3.5-flash-lite", BDFX_BUDDY_N8N_ENABLED: "true", BDFX_BUDDY_N8N_TRANSPORT: "ticket", BDFX_BUDDY_N8N_WEBHOOK_URL: "https://n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1" };
const question = { consent: true, language: "hi", message: "How do I start a BDFX account?", contextQuestion: null };
const answer = "रजिस्ट्रेशन पेज से शुरुआत करें।";
const modelResult = () => ({ data: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: answer }] } }] } });
function setup({ reserve, generate } = {}) {
  let clock = 1000000, reservations = 0, calls = 0;
  const claims = new Set(), warnings = [];
  const worker = createWorker({ env, now: () => clock, warn: category => warnings.push(category),
    usage: { reserve: async () => { reservations++; return reserve ? reserve() : true; }, claim: async nonce => { if (claims.has(nonce)) return false; claims.add(nonce); return true; } },
    post: async () => { calls++; return generate ? generate() : modelResult(); } });
  const bridge = post => createBuddyService({ env, worker, post, now: () => clock, warn: category => warnings.push(category) });
  return { worker, bridge, calls: () => calls, reservations: () => reservations, warnings, advance: ms => { clock += ms; } };
}
test("a fast n8n connection failure completes the same ticket locally and rejects a late callback", async () => {
  const fixture = setup(); let delegated;
  const bridge = fixture.bridge(async (_url, body) => { delegated = body; throw new Error("private transport diagnostic"); });
  assert.deepEqual(await bridge.reply(question), { status: 200, body: { answer, language: "hi" } });
  assert.equal(fixture.reservations(), 1); assert.equal(fixture.calls(), 1);
  assert.equal((await fixture.worker.complete(delegated)).status, 409);
  assert.equal(fixture.calls(), 1);
  assert.deepEqual(fixture.warnings, ["local_ticket_fallback"]);
});
test("a lost n8n response after model completion never retries that consumed question", async () => {
  const fixture = setup();
  const bridge = fixture.bridge(async (_url, body) => { assert.equal((await fixture.worker.complete(body)).status, 200); throw new Error("response lost"); });
  assert.deepEqual(await bridge.reply(question), { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
  assert.equal(fixture.calls(), 1); assert.equal(fixture.reservations(), 1);
});
test("an n8n model call already in flight cannot race an inline second call", async () => {
  let finish, pending;
  const fixture = setup({ generate: () => new Promise(resolve => { finish = () => resolve(modelResult()); }) });
  const bridge = fixture.bridge(async (_url, body) => { pending = fixture.worker.complete(body); await Promise.resolve(); throw new Error("connection dropped"); });
  assert.equal((await bridge.reply(question)).status, 503);
  assert.equal(fixture.calls(), 1); assert.equal(fixture.reservations(), 1);
  finish(); assert.equal((await pending).status, 200); assert.equal(fixture.calls(), 1);
});
test("slow bridge failures retain the guide instead of exceeding the frontend deadline", async () => {
  const fixture = setup();
  const bridge = fixture.bridge(async () => { fixture.advance(2001); throw new Error("slow bridge"); });
  assert.equal((await bridge.reply(question)).status, 503);
  assert.equal(fixture.calls(), 0); assert.equal(fixture.reservations(), 1);
});
test("capacity, consent and private-input guards still run before any local fallback", async () => {
  const fixture = setup({ reserve: () => false });
  const bridge = fixture.bridge(() => assert.fail("n8n must not be called"));
  assert.equal((await bridge.reply({ ...question, consent: false })).status, 400);
  assert.equal((await bridge.reply({ ...question, message: "Email person@example.test" })).status, 400);
  assert.equal(fixture.reservations(), 0);
  assert.equal((await bridge.reply(question)).status, 503);
  assert.equal(fixture.reservations(), 1); assert.equal(fixture.calls(), 0);
});
test("local provider errors and unsafe output stay generic and do not retry the provider", async () => {
  for (const generate of [async () => { throw { response: { status: 403, data: "private key and provider message" } }; }, async () => ({ data: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "https://outside.example/" }] } }] } })]) {
    const fixture = setup({ generate });
    const bridge = fixture.bridge(async () => { throw new Error("offline"); });
    const result = await bridge.reply(question);
    assert.deepEqual(result, { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
    assert.equal(fixture.calls(), 1); assert.equal(fixture.reservations(), 1);
    assert(!JSON.stringify(result).includes("private"));
  }
});
