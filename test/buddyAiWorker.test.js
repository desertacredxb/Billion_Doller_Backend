const test = require("node:test"), assert = require("node:assert/strict");
const { createWorker } = require("../services/buddyAiWorker.service");
const { createBuddyService } = require("../services/buddyN8n.service");
const { createUsage, DAILY_LIMIT } = require("../services/buddyAiUsage.service");
const env = { OPENAI_API_KEY: "not-a-provider-key-fixture-only", BDFX_BUDDY_N8N_ENABLED: "true", BDFX_BUDDY_N8N_TRANSPORT: "ticket", BDFX_BUDDY_N8N_WEBHOOK_URL: "https://n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1" };
const question = { consent: true, language: "hi", message: "How do I start verification?", contextQuestion: 0 };
function setup(overrides = {}) {
  let calls = 0, reservations = 0, clock = 1000000;
  const claims = new Set();
  const worker = createWorker({ env, now: () => clock, usage: { reserve: async () => { reservations++; return true; }, claim: async nonce => { if (claims.has(nonce)) return false; claims.add(nonce); return true; } },
    generate: async params => { calls++; assert.equal(params.store, false); assert.equal(params.max_completion_tokens, 1000); assert.equal(params.model, "gpt-5"); return { choices: [{ message: { content: "सुरक्षित क्लाइंट क्षेत्र में Continue to Verify खोलें।" } }] }; }, ...overrides });
  return { worker, calls: () => calls, reservations: () => reservations, advance: amount => { clock += amount; } };
}
test("signed n8n round trip uses the existing provider without sending its credential or a visitor identity", async () => {
  const fixture = setup(); let delegated;
  const bridge = createBuddyService({ env, worker: fixture.worker, post: async (url, body, options) => {
    assert.equal(url, env.BDFX_BUDDY_N8N_WEBHOOK_URL); assert.deepEqual(Object.keys(body), ["ticket"]);
    assert(!JSON.stringify(body).includes(env.OPENAI_API_KEY)); assert(!JSON.stringify(options).includes(env.OPENAI_API_KEY));
    assert.equal(options.maxRedirects, 0); delegated = body;
    const result = await fixture.worker.complete(body); assert.equal(result.status, 200); return { data: result.body };
  } });
  const reply = await bridge.reply(question);
  assert.equal(reply.status, 200); assert.equal(reply.body.language, "hi");
  assert.equal(fixture.calls(), 1); assert.equal(fixture.reservations(), 1);
  assert.equal((await fixture.worker.complete(delegated)).status, 409); assert.equal(fixture.calls(), 1);
});
test("forged, expired, malformed or differently signed commands never reach the model", async () => {
  const fixture = setup(), ticket = await fixture.worker.issue(question);
  for (const body of [null, {}, { ticket: "invalid" }, { ticket, extra: "private" }, { ticket: ticket.slice(0, -1) + (ticket.endsWith("0") ? "1" : "0") }, { ticket: "x".repeat(7000) }]) {
    assert.equal((await fixture.worker.complete(body)).status, 401);
  }
  const other = setup({ env: { ...env, OPENAI_API_KEY: "different-fixture-provider-key" } });
  assert.equal((await other.worker.complete({ ticket })).status, 401);
  fixture.advance(30001); assert.equal((await fixture.worker.complete({ ticket })).status, 401); assert.equal(fixture.calls(), 0);
});
test("parallel replays consume a command once even when the provider reply is lost", async () => {
  let providerCalls = 0;
  const fixture = setup({ generate: async () => { providerCalls++; throw new Error("provider secret text"); } });
  const body = { ticket: await fixture.worker.issue(question) };
  const results = await Promise.all([fixture.worker.complete(body), fixture.worker.complete(body)]);
  assert.deepEqual(results.map(item => item.status).sort(), [409, 503]); assert.equal(providerCalls, 1);
  assert(!JSON.stringify(results).includes("secret"));
});
test("capacity and storage failures stop before delegation or model use", async () => {
  for (const reserve of [async () => false, async () => { throw new Error("database unavailable"); }]) {
    const fixture = setup({ usage: { reserve, claim: () => assert.fail("claim") } });
    const bridge = createBuddyService({ env, worker: fixture.worker, post: () => assert.fail("n8n call") });
    assert.equal((await bridge.reply(question)).status, 503); assert.equal(fixture.calls(), 0);
  }
  const fixture = setup({ usage: { reserve: async () => true, claim: async () => { throw new Error("database unavailable"); } } });
  assert.equal((await fixture.worker.complete({ ticket: await fixture.worker.issue(question) })).status, 503); assert.equal(fixture.calls(), 0);
});
test("consent/private details are checked before reserving capacity, and unsafe model output falls back", async () => {
  const fixture = setup(), bridge = createBuddyService({ env, worker: fixture.worker, post: () => assert.fail("n8n call") });
  for (const patch of [{ consent: false }, { message: "My email is person@example.test" }, { message: "My code is 123456" }]) assert.equal((await bridge.reply({ ...question, ...patch })).status, 400);
  assert.equal(fixture.reservations(), 0);
  for (const content of ["<b>HTML</b>", "https://outside.example/", "x".repeat(2401), null]) {
    const bad = setup({ generate: async () => ({ choices: [{ message: { content } }] }) });
    assert.equal((await bad.worker.complete({ ticket: await bad.worker.issue(question) })).status, 503);
  }
});
test("provider diagnostics distinguish quota and rate limits without exposing provider text", async () => {
  for (const [code, expected] of [["insufficient_quota", "provider_quota"], ["rate_limit_exceeded", "provider_rate_limit_exceeded"], ["credit_balance_exhausted", "provider_credit_balance_exhausted"], ["project_spend_limit_exceeded", "provider_project_spend_limit_exceeded"], ["organization_spend_limit_exceeded", "provider_organization_spend_limit_exceeded"], ["organization_usage_limit_exceeded", "provider_organization_usage_limit_exceeded"], ["usage_limit_exceeded", "provider_usage_limit_exceeded"], ["slow_down", "provider_slow_down"], ["unrecognized-private-code", "provider_capacity"]]) {
    const warnings = [];
    const fixture = setup({ warn: value => warnings.push(value), generate: async () => { throw Object.assign(new Error("private provider text"), { status: 429, code }); } });
    const result = await fixture.worker.complete({ ticket: await fixture.worker.issue(question) });
    assert.deepEqual(result, { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } });
    assert.deepEqual(warnings, [expected]);
  }
});
test("usage collection stores only counters/nonces, reserves an atomic daily cap and fails closed", async () => {
  const calls = [], duplicate = Object.assign(new Error("duplicate"), { code: 11000 }); let full = false;
  const store = { createIndex: async (...args) => { calls.push(["index", ...args]); },
    findOneAndUpdate: async (...args) => { calls.push(["reserve", ...args]); if (full) throw duplicate; return { count: 1 }; },
    insertOne: async (...args) => { calls.push(["claim", ...args]); if (full) throw duplicate; } };
  const connection = { readyState: 1, collection: name => { assert.equal(name, "buddy_ai_usage"); return store; } };
  const usage = createUsage({ connection, now: () => new Date("2026-10-25T14:00:00Z") });
  assert.equal(await usage.reserve(), true); assert.equal(await usage.claim("nonce", 1000000), true);
  assert.deepEqual(calls.find(item => item[0] === "reserve")[1], { _id: "day:2026-10-25", count: { $lt: DAILY_LIMIT } });
  assert.equal(calls.find(item => item[0] === "reserve")[3].writeConcern.w, "majority");
  const serialized = JSON.stringify(calls); for (const key of ["message", "email", "language", "question", "ticket"]) assert(!serialized.includes(key));
  full = true; assert.equal(await usage.reserve(), false); assert.equal(await usage.claim("nonce", 1000000), false);
  connection.readyState = 0; await assert.rejects(usage.reserve());
});
