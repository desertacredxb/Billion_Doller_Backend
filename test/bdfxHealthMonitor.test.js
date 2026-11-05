const test = require('node:test'), assert = require('node:assert/strict');
const { healthSnapshot, planHealthNotice, confirmHealthDelivery } = require('../integrations/n8n/bdfx-health-monitor');
const at = new Date('2026-11-05T01:00:00Z');
const good = () => healthSnapshot({ statusCode: 200, body: { status: 'ok', database: 'connected' } }, { statusCode: 200, body: '<title>Billion Dollar FX</title>' }, at);
const bad = () => healthSnapshot({ statusCode: 503, body: { secret: 'PRIVATE' } }, { error: { message: 'PRIVATE' } }, at);
test('health failures expose only fixed service statuses and never raw provider errors', () => {
  assert.equal(good().healthy, true); assert.equal(bad().healthy, false);
  assert.equal(JSON.stringify(bad()).includes('PRIVATE'), false);
  assert.equal(healthSnapshot({ statusCode: 200, body: { status: 'ok', database: 'disconnected' } }, { statusCode: 200, body: 'Billion Dollar FX' }, at).healthy, false);
});
test('unchanged healthy checks are silent, new failures alert once and verified recovery is reported', () => {
  const state = {}; assert.equal(planHealthNotice(state, good(), { now: at }), null);
  const alert = planHealthNotice(state, bad(), { now: at }); assert.equal(alert.kind, 'alert');
  assert.equal(planHealthNotice(state, bad(), { now: at }), null);
  const recovery = planHealthNotice(state, good(), { now: at }); assert.equal(recovery.kind, 'recovery');
  assert.equal(planHealthNotice(state, good(), { now: at }), null);
});
test('uncertain sends are not blindly retried, and only accepted alerts can produce six-hour reminders', () => {
  const state = {}; planHealthNotice(state, bad(), { now: at });
  const later = new Date(at.getTime() + 7 * 3600000);
  state.healthDelivery = { status: 'unconfirmed', at: at.toISOString() };
  assert.equal(planHealthNotice(state, bad(), { now: later }), null);
  state.healthDelivery.status = 'sent'; assert.equal(planHealthNotice(state, bad(), { now: later }).kind, 'reminder');
});
test('preview does not change state and delivery tests cannot overwrite the production health state', () => {
  const state = {}; assert.equal(planHealthNotice(state, bad(), { mode: 'preview', now: at }), null); assert.deepEqual(state, {});
  assert.equal(planHealthNotice(state, good(), { mode: 'test', now: at }).kind, 'test'); assert.deepEqual(state, {});
});
test('receipts require the exact bot, group and message body', () => {
  const notice = planHealthNotice({}, good(), { mode: 'test', now: at });
  const cfg = { groupId: '-12345', botId: '999', now: at };
  const receipt = { ok: true, result: { chat: { id: -12345 }, from: { id: 999, is_bot: true }, message_id: 1, text: notice.text } };
  assert.equal(confirmHealthDelivery(notice, receipt, cfg).status, 'sent');
  assert.equal(confirmHealthDelivery(notice, receipt, { ...cfg, groupId: '-98765' }).status, 'unconfirmed');
  assert.equal(confirmHealthDelivery(notice, { error: 'PRIVATE' }, cfg).status, 'unconfirmed');
});
