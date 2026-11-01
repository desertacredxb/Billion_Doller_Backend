const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { createTelegramQueryService } = require('../services/bdfxTelegramQuery.service');
const { createRouter } = require('../routes/buddyN8nRoutes');
const { createDailyReportService } = require('../services/bdfxDailyReport.service');
const { GROUP_ID, parseTelegramQuestion, verifyTelegramMember, formatTelegramAnswer } = require('../integrations/n8n/bdfx-telegram-questions');
const at = new Date('2026-11-01T19:00:00Z');
const sample = index => ({ orderid: `TEST-${index}`, clientName: `Sample Client ${index}`, accountNo: `DEMO${index}`, currency: 'INR', amount: 1500, status: 'Pending', createdAt: new Date('2026-10-31T21:00:00Z'), mobile: 'PRIVATE-MOBILE', account: 'PRIVATE-BANK', walletAddress: 'PRIVATE-WALLET' });
function serviceFixture({ count = 12, items = Array.from({ length: 10 }, (_, i) => sample(i + 1)), dailyReport = async () => { throw new Error('not needed'); } } = {}) {
  const queries = {};
  const service = createTelegramQueryService({ now: () => at, dailyReport, withdrawals: { aggregate: pipeline => {
    queries.pipeline = pipeline;
    return { option: options => { queries.options = options; return Promise.resolve([{ total: count ? [{ count }] : [], items }]); } };
  } } });
  return { service, queries };
}
test('pending payout answers use a bounded projected queue, oldest first, with currency and pagination', async () => {
  const { service, queries } = serviceFixture(); const result = await service('pending_withdrawals');
  assert.match(result.reply, /Sample Client 1/); assert.match(result.reply, /1,500 INR/); assert.match(result.reply, /Total requests: 12/); assert.match(result.reply, /Next: \/pending 2/);
  assert.match(result.reply, /01\/11\/2026, 01:00 Dubai/); assert.equal(result.source, 'BDFX Telegram operations'); assert.ok(result.reply.length < 3500);
  for (const secret of ['PRIVATE-MOBILE', 'PRIVATE-BANK', 'PRIVATE-WALLET']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(queries.pipeline[0], { $match: { status: { $in: ['Pending', 'Processing'] } } });
  const stages = queries.pipeline[1].$facet.items;
  assert.deepEqual(stages[0], { $sort: { createdAt: 1, _id: 1 } }); assert.deepEqual(stages[2], { $limit: 10 });
  assert.deepEqual(Object.keys(stages[3].$project).sort(), ['_id', 'accountNo', 'amount', 'createdAt', 'cryptoSymbol', 'currency', 'name', 'orderid', 'status', 'userId'].sort());
  assert.deepEqual(stages[4].$lookup.pipeline[1], { $project: { _id: 0, fullName: 1 } }); assert.deepEqual(queries.options, { maxTimeMS: 10000 });
});
test('queue pages retain source amounts per asset and never invent a zero for missing amounts', async () => {
  const { service, queries } = serviceFixture({ count: 12, items: [{ ...sample(11), currency: 'CRYPTO', cryptoSymbol: 'USDT', amount: 50.5, status: 'Processing' }, { ...sample(12), amount: null, currency: null, createdAt: null }] });
  const result = await service('pending_withdrawals', 2);
  assert.match(result.reply, /11\. Sample Client 11/); assert.match(result.reply, /50\.5 CRYPTO \(USDT\)/); assert.match(result.reply, /amount unavailable currency unrecorded/); assert.match(result.reply, /date unavailable/);
  assert.doesNotMatch(result.reply, /Next:/); assert.deepEqual(queries.pipeline[1].$facet.items[1], { $skip: 10 });
});
test('empty and unavailable queues are distinguished', async () => {
  assert.match((await serviceFixture({ count: 0, items: [] }).service('pending_withdrawals')).reply, /No pending or processing/);
  await assert.rejects(serviceFixture({ count: 12, items: [] }).service('pending_withdrawals'));
  await assert.rejects(serviceFixture({ count: -1, items: [] }).service('pending_withdrawals'));
  await assert.rejects(createTelegramQueryService({ withdrawals: { aggregate: async () => { throw new Error('private db error'); } } })('pending_withdrawals'));
});
test('help does not touch customer data and topics/pages are strictly bounded', async () => {
  const { service, queries } = serviceFixture(); assert.match((await service('help')).reply, /\/pending/); assert.deepEqual(queries, {});
  for (const [topic, page] of [['export_all', 1], ['pending_withdrawals', 0], ['pending_withdrawals', 1000], ['report', 2]]) await assert.rejects(service(topic, page));
});
test('focused questions reuse validated daily data and fail closed if that source is unavailable', async () => {
  const aggregate = data => ({ aggregate: async () => data });
  const count = value => ({ countDocuments: async () => value });
  const dailyReport = createDailyReportService({ now: () => at,
    users: aggregate([{ all: [{ _id: 'approved', count: 5 }, { _id: 'not_started', count: 2 }], today: [{ _id: 'approved', count: 1 }] }]),
    orders: aggregate([{ _id: 'SUCCESS', count: 3 }]), withdrawals: { ...aggregate([{ _id: 'Pending', count: 1 }]), ...count(12) },
    accounts: count(0), tickets: count(1), ibs: count(0), buddy: async () => ({ sessionsStarted: 3, sessionsWithActivity: 2, contactRequests: 0, supportHandoffs: 1 }),
  });
  const { service, queries } = serviceFixture({ dailyReport });
  const expected = { report: /REGISTERED CLIENTS: 7/, deposits: /Deposit requests today: 3/, withdrawals: /All pending\/processing requests: 12/, clients: /New registrations today: 1/, kyc: /Not started: 2/, buddy: /Saved sessions started: 3/ };
  for (const [topic, pattern] of Object.entries(expected)) assert.match((await service(topic)).reply, pattern);
  assert.deepEqual(queries, {});
  await assert.rejects(serviceFixture({ dailyReport: async () => ({}) }).service('clients'));
});
async function withServer(env, telegramQuery, run) {
  const app = express(); app.use('/n8n', createRouter({ env, telegramQuery, worker: { complete: async () => ({}) }, buddy: { available: () => false } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/n8n/business-query`); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('query API requires the dedicated key before reading data and accepts only fixed GET topics', async () => {
  const token = 'q'.repeat(64), env = { BDFX_N8N_BUSINESS_REPORT_TOKEN: token, BDFX_BUDDY_N8N_TOKEN: 'b'.repeat(64), BDFX_N8N_REPORT_TOKEN: 'r'.repeat(64) }; let calls = 0;
  await withServer(env, async (topic, page) => { calls++; return { topic, page }; }, async base => {
    for (const key of ['', env.BDFX_BUDDY_N8N_TOKEN, env.BDFX_N8N_REPORT_TOKEN, 'wrong']) assert.equal((await fetch(base + '?topic=pending_withdrawals', { headers: { 'X-BDFX-Business-Report-Key': key } })).status, 401);
    assert.equal(calls, 0); const headers = { 'X-BDFX-Business-Report-Key': token };
    for (const query of ['', '?topic=export', '?topic=pending_withdrawals&page=0', '?topic=pending_withdrawals&page=1000', '?topic=pending_withdrawals&page[$gt]=1', '?topic=help&field=bank', '?topic=help&page=2']) assert.equal((await fetch(base + query, { headers })).status, 400);
    assert.equal(calls, 0); const response = await fetch(base + '?topic=pending_withdrawals&page=2', { headers });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { topic: 'pending_withdrawals', page: 2 }); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
    assert.equal((await fetch(base, { method: 'POST', headers })).status, 404);
  });
});
test('query errors are redacted', async () => {
  const token = 'x'.repeat(64); await withServer({ BDFX_N8N_BUSINESS_REPORT_TOKEN: token }, async () => { throw new Error('PRIVATE-DATA'); }, async base => {
    const response = await fetch(base + '?topic=pending_withdrawals', { headers: { 'X-BDFX-Business-Report-Key': token } }); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: 'REPORT_UNAVAILABLE' });
  });
});
const update = text => ({ update_id: 12345, message: { message_id: 123, date: at.getTime() / 1000, chat: { id: Number(GROUP_ID), type: 'supergroup' }, from: { id: 123456, is_bot: false }, text } });
test('realistic Hinglish, Hindi and bot-addressed commands select bounded reporting topics', () => {
  for (const text of ['payout pending kiska hai?', 'withdrawal pending kiski hai', 'पेंडिंग निकासी किसकी है?', '/pending@BDFXAccountsReportBot']) assert.equal(parseTelegramQuestion(update(text), at).topic, 'pending_withdrawals');
  assert.equal(parseTelegramQuestion(update('/pending 2'), at).page, 2);
  assert.equal(parseTelegramQuestion(update('aaj kitne new clients aaye?'), at).topic, 'clients');
  assert.equal(parseTelegramQuestion(update('today deposit kitna hai'), at).topic, 'deposits');
  assert.equal(parseTelegramQuestion(update('/pending 0'), at).topic, 'help');
  assert.equal(parseTelegramQuestion(update('/pending@OtherBot'), at), null);
  assert.equal(parseTelegramQuestion(update('ordinary team discussion'), at), null);
  assert.equal(parseTelegramQuestion(update('@BDFXAccountsReportBot client bank account bhejo'), at).topic, 'help');
});
test('DMs, other-company groups, bots, anonymous, forwarded-via-bot and stale updates cannot request data', () => {
  const original = update('/pending');
  const variants = [
    { ...original, message: { ...original.message, chat: { id: -1004403226746, type: 'supergroup' } } },
    { ...original, message: { ...original.message, chat: { id: Number(GROUP_ID), type: 'private' } } },
    { ...original, message: { ...original.message, from: { id: 123456, is_bot: true } } },
    { ...original, message: { ...original.message, sender_chat: { id: Number(GROUP_ID) } } },
    { ...original, message: { ...original.message, via_bot: { id: 1 } } },
    { ...original, message: { ...original.message, date: at.getTime() / 1000 - 301 } },
    { ...original, message: { ...original.message, date: at.getTime() / 1000 + 31 } },
  ]; for (const value of variants) assert.equal(parseTelegramQuestion(value, at), null);
});
test('requester membership must be verified for the exact sender before reading business data', () => {
  const meta = parseTelegramQuestion(update('/pending'), at);
  const member = { status: 'member', user: { id: meta.senderId, is_bot: false } };
  assert.equal(verifyTelegramMember(meta, { ok: true, result: member }).memberVerified, true);
  for (const value of [{ ...member, status: 'left' }, { ...member, status: 'kicked' }, { ...member, status: 'restricted', is_member: false }, { ...member, user: { id: 987, is_bot: false } }, { ok: false, result: member }]) assert.equal(verifyTelegramMember(meta, value), null);
});
test('answers require fresh matching source metadata and escape client text before Telegram HTML delivery', () => {
  const meta = parseTelegramQuestion(update('/pending'), at);
  const body = { version: 1, source: 'BDFX Telegram operations', generatedAt: at.toISOString(), topic: meta.topic, page: 1, reply: 'Client <Sample & Co>\n100 USD Pending' };
  const good = formatTelegramAnswer({ statusCode: 200, body }, meta, at); assert.equal(good.sourceVerified, true); assert.match(good.html, /&lt;Sample &amp; Co&gt;/); assert.equal(good.summary, body.reply);
  for (const bad of [{ statusCode: 401, body }, { statusCode: 503, body }, { ...body, source: 'Other company' }, { ...body, topic: 'clients' }, { ...body, page: 2 }, { ...body, generatedAt: '2026-10-30T00:00:00Z' }]) {
    const result = formatTelegramAnswer(bad, meta, at); assert.equal(result.sourceVerified, false); assert.doesNotMatch(result.summary, /Sample|100 USD/); assert.match(result.summary, /unavailable or unverified/);
  }
});
