const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { createOperationsAssistant } = require('../services/bdfxOperationsAssistant.service');
const { createTelegramQueryService } = require('../services/bdfxTelegramQuery.service');
const { createRouter } = require('../routes/buddyN8nRoutes');
const { parseTelegramQuestion, formatTelegramAnswer, GROUP_ID } = require('../integrations/n8n/bdfx-telegram-questions');
const { createGroqGenerate, GROQ_BASE_URL } = require('../services/bdfxGroqProvider.service');
const at = new Date('2026-11-03T19:30:00Z');
const tool = (name, args) => ({ output: [{ type: 'function_call', call_id: 'test-call', name, arguments: JSON.stringify(args) }] });
const final = text => ({ output: [{ type: 'message', role: 'assistant' }], output_text: text });
const fresh = (topic, page) => ({ version: 1, source: 'BDFX Telegram operations', topic, page, generatedAt: at.toISOString(), reply: 'BDFX: pending requests12; checked23:30 Dubai.' });
function fixture(overrides = {}) {
  const requests = [], reads = []; let calls = 0, reservations = 0;
  const service = createOperationsAssistant({ env: { BDFX_TELEGRAM_GROQ_API_KEY: 'gsk_TEST_NOT_A_REAL_CREDENTIAL' }, now: () => at,
    usage: { reserve: async () => { reservations++; return true; } }, query: async (topic, page) => { reads.push({ topic, page }); return fresh(topic, page); },
    generate: async params => { requests.push(JSON.parse(JSON.stringify(params))); return calls++ ? final('BDFX mein12 pending requests hain.') : tool('read_bdfx_report', { topic: 'pending_withdrawals', page: 1 }); }, ...overrides });
  return { service, requests, reads, reservations: () => reservations };
}
test('Groq gets only fixed read-only tools and fresh report evidence, with no provider key in prompts', async () => {
  const { service, requests, reads } = fixture(); const result = await service.reply({ message: 'BDFX mein payout pending kiska hai?' });
  assert.equal(result.status, 200); assert.equal(result.body.provider, 'groq'); assert.match(result.body.reply, /BDFX AI.*23:30/); assert.deepEqual(result.body.usedTopics, ['pending_withdrawals']);
  assert.deepEqual(reads, [{ topic: 'pending_withdrawals', page: 1 }]); assert.equal(requests[0].tool_choice, 'required');
  assert.equal(requests[0].parallel_tool_calls, false); assert.equal(requests[0].model, 'openai/gpt-oss-20b');
  assert.equal(requests[0].tools.every(t => t.strict && t.parameters.additionalProperties === false), true);
  assert.equal(JSON.stringify(requests).includes('gsk_TEST'), false); assert.equal(requests[1].input.at(-1).type, 'function_call_output');
});
test('OpenAI credentials alone never enable Groq or trigger a request; a BDFX Groq key takes priority', async () => {
  const f = fixture({ env: { OPENAI_API_KEY: 'TEST-OPENAI-NOT-A-REAL-KEY', BDFX_TELEGRAM_OPENAI_API_KEY: 'TEST-OPENAI-NOT-A-REAL-KEY' } });
  assert.equal(f.service.status().provider, 'groq'); assert.equal(f.service.status().configured, false);
  assert.equal((await f.service.reply({ message: 'BDFX SEO?' })).body.category, 'not_configured');
  assert.equal(f.requests.length, 0); assert.equal(f.reservations(), 0);
  const invalid = fixture({ env: { BDFX_TELEGRAM_GROQ_API_KEY: 'PASTE-KEY-HERE' } });
  assert.equal(invalid.service.status().configured, false);
});
test('Groq adapter pins the Groq endpoint and sends verified tool results through Chat Completions', async () => {
  let clientOptions; const requests = [];
  class Client {
    constructor(options) {
      clientOptions = options;
      this.chat = { completions: { create: async params => {
        requests.push(JSON.parse(JSON.stringify(params)));
        return { choices: [requests.length === 1
          ? { finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ type: 'function', id: 'groq-test-call', function: { name: 'read_bdfx_report', arguments: JSON.stringify({ topic: 'seo', page: 1 }) } }] } }
          : { finish_reason: 'stop', message: { content: 'Publishing is enabled according to the checked SEO report.' } }] };
      } } };
    }
  }
  const generate = createGroqGenerate({ apiKey: 'gsk_TEST_NOT_A_REAL_CREDENTIAL', Client });
  const f = fixture({ generate }); const result = await f.service.reply({ message: 'BDFX SEO kaise chal raha hai?' });
  assert.equal(result.status, 200); assert.equal(result.body.provider, 'groq'); assert.deepEqual(result.body.usedTopics, ['seo']);
  assert.equal(clientOptions.baseURL, GROQ_BASE_URL); assert.equal(clientOptions.baseURL, 'https://api.groq.com/openai/v1');
  assert.equal(clientOptions.maxRetries, 0); assert.equal(clientOptions.timeout, 12000);
  assert.equal(requests[0].model, 'openai/gpt-oss-20b'); assert.equal(requests[0].tool_choice, 'required');
  assert.equal(requests[0].parallel_tool_calls, false); assert.equal(requests[0].tools.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'tool'); assert.equal(requests[1].messages.at(-1).tool_call_id, 'groq-test-call');
  assert.equal(JSON.stringify(requests).includes('gsk_TEST'), false); assert.equal(requests[0].include, undefined);
});
test('truncated Groq output cannot be delivered as a complete operational answer', async () => {
  class Client { constructor() { this.chat = { completions: { create: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'All payments settled' } }] }) } }; } }
  const f = fixture({ generate: createGroqGenerate({ apiKey: 'gsk_TEST_NOT_A_REAL_CREDENTIAL', Client }) });
  assert.equal((await f.service.reply({ message: 'report' })).body.category, 'provider_response'); assert.equal(f.reads.length, 0);
});
test('a model cannot answer from memory alone, invent a mutation tool or pass arbitrary database filters', async () => {
  for (const response of [final('I already approved the payout.'), tool('approve_payout', { id: 'x' }), tool('read_bdfx_report', { topic: 'report', page: 1, mongoFilter: {} }), tool('read_bdfx_report', { topic: 'bank_details', page: 1 })]) {
    let reads = 0; const { service } = fixture({ generate: async () => response, query: async () => { reads++; } });
    const result = await service.reply({ message: 'approve payment' }); assert.equal(result.status, 503); assert.equal(reads, 0);
  }
});
test('tool loop and pages are bounded and source failures never become invented zero totals', async () => {
  const repeated = fixture({ generate: async () => tool('read_bdfx_report', { topic: 'report', page: 1 }) });
  assert.equal((await repeated.service.reply({ message: 'report' })).body.category, 'tool_limit'); assert.equal(repeated.reads.length, 3);
  const stale = fixture({ query: async () => ({ ...fresh('report', 1), generatedAt: '2026-11-01T00:00:00Z' }) });
  assert.equal((await stale.service.reply({ message: 'report' })).body.category, 'source');
  assert.equal((await fixture({ generate: async () => tool('read_bdfx_report', { topic: 'report', page: 2 }) }).service.reply({ message: 'report' })).body.category, 'invalid_tool');
});
test('private credentials and invalid input are rejected before usage, source reads or Groq requests', async () => {
  const f = fixture();
  for (const body of [{}, { message: 'x'.repeat(1001) }, { message: 'report', secret: 'x' }, { message: 'sk-' + 'a'.repeat(32) }, { message: 'report', replyContext: 'Bearer ' + 'a'.repeat(25) }]) assert.equal((await f.service.reply(body)).status, 400);
  assert.equal(f.reservations(), 0); assert.equal(f.requests.length, 0); assert.equal(f.reads.length, 0);
});
test('provider configuration and errors are metadata only; no keys, provider payloads or private request text leak', async () => {
  const missing = fixture({ env: {} }); assert.equal(missing.service.status().configured, false); assert.equal((await missing.service.reply({ message: 'report' })).body.category, 'not_configured');
  for (const [error, category] of [[{ status: 401 }, 'provider_auth'], [{ status: 429, code: 'insufficient_quota' }, 'provider_quota'], [{ status: 429, code: 'rate_limit_exceeded' }, 'provider_rate_limit'], [{ status: 429, code: 'slow_down' }, 'provider_rate_limit'], [{ status: 429 }, 'provider_capacity'], [{ status: 404 }, 'provider_model']]) {
    const f = fixture({ generate: async () => { throw { ...error, message: 'PRIVATE-PROVIDER-CONTENT' }; } }); const result = await f.service.reply({ message: 'report' });
    assert.equal(result.body.category, category); assert.equal(JSON.stringify(result).includes('PRIVATE-'), false); assert.equal(JSON.stringify(f.service.status()).includes('gsk_TEST'), false);
  }
});
test('AI routing preserves group identity restrictions, slash commands and bounded bot-reply context', () => {
  const base = { update_id: 1, message: { message_id: 5, date: at.getTime() / 1000, chat: { id: Number(GROUP_ID), type: 'supergroup' }, from: { id: 123, is_bot: false }, text: 'Explain BDFX SEO and new registrations?' } };
  const parsed = parseTelegramQuestion(base, at, { enableAI: true }); assert.equal(parsed.topic, 'assistant'); assert.equal(parsed.question, base.message.text);
  assert.equal(parseTelegramQuestion({ ...base, message: { ...base.message, text: '/seo' } }, at, { enableAI: true }).topic, 'seo');
  assert.equal(parseTelegramQuestion({ ...base, message: { ...base.message, text: '/mt5@OtherBot' } }, at, { enableAI: true }), null);
  assert.equal(parseTelegramQuestion({ ...base, message: { ...base.message, chat: { id: -1004403226746, type: 'supergroup' } } }, at, { enableAI: true }), null);
  const quoted = parseTelegramQuestion({ ...base, message: { ...base.message, reply_to_message: { from: { username: 'BDFXAccountsReportBot' }, text: 'x'.repeat(2000) } } }, at, { enableAI: true }); assert.equal(quoted.replyContext.length, 1500);
  const unavailable = formatTelegramAnswer({ statusCode: 503, body: { code: 'OPERATIONS_AI_UNAVAILABLE', category: 'provider_quota' } }, parsed, at);
  assert.equal(unavailable.sourceVerified, false); assert.match(unavailable.summary, /BDFX AI chat is unavailable/); assert.match(unavailable.summary, /does not confirm a website or database outage/);
});
test('SEO answers distinguish live publishing evidence, stale workers, pauses and Google performance that is not connected', async () => {
  const status = { enabled: true, cadenceDays: 7, starterArticles: 6, lastRunAt: '2026-11-03T19:29:00Z', nextPublishAt: '2026-11-04T02:03:00Z', lastOutcome: 'waiting', lastError: '', queued: [{ title: 'Next educational guide' }], recent: [{ title: 'Published guide', slug: 'published-guide', status: 'published', lastAutoPublishedAt: '2026-10-28T02:03:00Z' }] };
  const ask = override => createTelegramQueryService({ now: () => at, seoStatus: async () => ({ ...status, ...override }) })('seo');
  const report = await ask({}); assert.match(report.reply, /Worker check is recent/); assert.match(report.reply, /Queued drafts: 1/); assert.match(report.reply, /Published guide/); assert.match(report.reply, /04\/11\/2026, 06:03 Dubai/); assert.match(report.reply, /does not prove Google indexing/);
  assert.match((await ask({ lastRunAt: '2026-11-01T00:00:00Z' })).reply, /check is stale/); assert.match((await ask({ enabled: false })).reply, /Worker: Paused/);
  assert.match((await ask({ lastRunAt: null })).reply, /has not been observed/);
});
test('assistant routes authenticate with the scoped report key before invoking provider or exposing options', async () => {
  const token = 'z'.repeat(64); let calls = 0;
  const app = express(); app.use('/n8n', createRouter({ env: { BDFX_N8N_BUSINESS_REPORT_TOKEN: token }, worker: { complete: async () => ({}) }, buddy: { available: () => false }, operationsAssistant: { status: () => ({ configured: true, provider: 'groq' }), reply: async () => { calls++; return { status: 200, body: { ok: true } }; } } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); const base = `http://127.0.0.1:${server.address().port}/n8n/business-assistant`;
  try {
    assert.equal((await fetch(base + '/options')).status, 401);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'report' }) })).status, 401); assert.equal(calls, 0);
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BDFX-Business-Report-Key': token }, body: JSON.stringify({ message: 'report' }) }); assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await new Promise(r => server.close(r)); }
});
