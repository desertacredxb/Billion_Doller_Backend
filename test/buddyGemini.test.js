const test = require("node:test"), assert = require("node:assert/strict");
const { providerConfig, DEFAULT_GEMINI_MODEL } = require("../services/buddyGemini.service");
const { createWorker } = require("../services/buddyAiWorker.service");
const { createBuddyService } = require("../services/buddyN8n.service");
const env = { BDFX_BUDDY_AI_PROVIDER: "gemini", BDFX_BUDDY_GEMINI_API_KEY: "fixture-gemini-secret-not-a-real-key", OPENAI_API_KEY: "fixture-openai-secret-not-a-real-key", BDFX_BUDDY_N8N_ENABLED: "true", BDFX_BUDDY_N8N_TRANSPORT: "ticket", BDFX_BUDDY_N8N_WEBHOOK_URL: "https://n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1" };
const question = { consent: true, language: "hi", message: "How do I start verification?", contextQuestion: 2 };
const answer = "सुरक्षित क्लाइंट क्षेत्र में Continue to Verify खोलें।";
const result = (parts = [{ text: answer }], finishReason = "STOP") => ({ data: { candidates: [{ finishReason, content: { parts } }] } });
function setup(overrides = {}) {
  let calls = 0, reservations = 0;
  const claims = new Set(), warnings = [];
  const worker = createWorker({ env, now: () => 1000000,
    usage: { reserve: async () => { reservations++; return true; }, claim: async nonce => { if (claims.has(nonce)) return false; claims.add(nonce); return true; } },
    generate: () => assert.fail("Gemini must not invoke OpenAI"),
    post: async () => { calls++; return result(); }, warn: category => warnings.push(category), ...overrides });
  return { worker, calls: () => calls, reservations: () => reservations, warnings };
}
test("Gemini needs its own credential and cannot fall back to OpenAI or an unsafe model path", () => {
  assert.equal(providerConfig({ ...env, BDFX_BUDDY_GEMINI_API_KEY: undefined }), null);
  assert.equal(setup({ env: { ...env, BDFX_BUDDY_GEMINI_API_KEY: undefined } }).worker.configured(), false);
  assert.equal(providerConfig({ ...env, BDFX_BUDDY_GEMINI_API_KEY: undefined, GEMINI_API_KEY: "alternate-fixture-gemini-secret" }).provider, "gemini");
  assert.equal(providerConfig({ ...env, BDFX_BUDDY_AI_PROVIDER: "unknown" }), null);
  assert.equal(providerConfig({ ...env, BDFX_BUDDY_GEMINI_MODEL: "../../outside?key=secret" }), null);
  assert.equal(providerConfig(env).model, DEFAULT_GEMINI_MODEL);
  assert.equal(providerConfig({ OPENAI_API_KEY: env.OPENAI_API_KEY }).provider, "openai");
});
test("signed n8n round trip calls fixed Google endpoint with the credential only in its server header", async () => {
  let calls = 0, delegation;
  const fixture = setup({ post: async (url, body, options) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(options.headers["x-goog-api-key"], env.BDFX_BUDDY_GEMINI_API_KEY);
    assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 8000); assert.equal(options.maxContentLength, 16000);
    assert.equal(body.generationConfig.maxOutputTokens, 1000);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "low", includeThoughts: false });
    assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), { language: "hi", question: question.message, publicFaqIndex: 2 });
    return result();
  } });
  const bridge = createBuddyService({ env, worker: fixture.worker, post: async (url, body) => {
    assert.equal(url, env.BDFX_BUDDY_N8N_WEBHOOK_URL); assert.deepEqual(Object.keys(body), ["ticket"]); delegation = body;
    for (const key of [env.OPENAI_API_KEY, env.BDFX_BUDDY_GEMINI_API_KEY]) assert(!JSON.stringify(body).includes(key));
    const reply = await fixture.worker.complete(body); return { data: reply.body };
  } });
  assert.deepEqual(await bridge.reply(question), { status: 200, body: { answer, language: "hi" } });
  assert.equal((await fixture.worker.complete(delegation)).status, 409); assert.equal(calls, 1);
});
test("Gemini consent/private checks and provider-bound tickets stop unintended calls", async () => {
  const fixture = setup(), bridge = createBuddyService({ env, worker: fixture.worker, post: () => assert.fail("n8n") });
  for (const patch of [{ consent: false }, { message: "Email person@example.test" }]) assert.equal((await bridge.reply({ ...question, ...patch })).status, 400);
  assert.equal(fixture.reservations(), 0); assert.equal(fixture.calls(), 0);
  const openai = setup({ env: { ...env, BDFX_BUDDY_AI_PROVIDER: "openai", OPENAI_API_KEY: env.BDFX_BUDDY_GEMINI_API_KEY } });
  assert.equal((await fixture.worker.complete({ ticket: await openai.worker.issue(question) })).status, 401);
  assert.equal(fixture.calls(), 0);
});
test("Gemini returns final plain text only and falls back on blocked, truncated, tool or unsafe output", async () => {
  const thought = setup({ post: async () => result([{ thought: true, text: "internal thought" }, { text: answer }]) });
  assert.equal((await thought.worker.complete({ ticket: await thought.worker.issue(question) })).body.answer, answer);
  for (const response of [result([{ text: answer }], "MAX_TOKENS"), result([{ functionCall: { name: "payment" } }]), result([{ text: "<b>unsafe</b>" }]), result([{ text: "https://outside.example/" }]), { data: { promptFeedback: { blockReason: "SAFETY" } } }, result([], "SAFETY")]) {
    const fixture = setup({ post: async () => response });
    assert.deepEqual(await fixture.worker.complete({ ticket: await fixture.worker.issue(question) }), { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
  }
});
test("Gemini errors log only allowlisted categories and each command is consumed once", async () => {
  for (const [status, code, expected] of [[403, undefined, "gemini_auth"], [429, undefined, "gemini_capacity"], [404, undefined, "gemini_model"], [undefined, "ECONNABORTED", "gemini_timeout"], [400, "private-provider-code", "gemini_request"]]) {
    let calls = 0;
    const fixture = setup({ post: async () => { calls++; throw { code, response: { status, data: { error: "private question and key" } } }; } });
    const body = { ticket: await fixture.worker.issue(question) };
    assert.deepEqual(await fixture.worker.complete(body), { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
    assert.deepEqual(fixture.warnings, [expected]);
    assert.equal((await fixture.worker.complete(body)).status, 409); assert.equal(calls, 1);
  }
});
