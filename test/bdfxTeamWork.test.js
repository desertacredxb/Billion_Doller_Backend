const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_GROUP, dubaiDate, parseWorkUpdate, latestWorkEvents, buildWorkReport } = require('../integrations/n8n/bdfx-team-work');
const now = new Date('2026-11-05T18:00:00Z');
function message(text, id = 1) { return { message: { message_id: id, date: 1793898000, chat: { id: Number(AGENT_GROUP), type: 'supergroup' }, from: { id: 100 + id, first_name: 'Test ' + id }, text } }; }
function event(text, id = 1) { return parseWorkUpdate(message(text, id), { now }); }
test('Agent updates never capture attendance, other groups, bots, forwards or ordinary discussion', () => {
  for (const text of ['IN', 'out', 'Good morning', '@BDFXAccountsReportBot please help']) assert.equal(event(text), null);
  for (const modify of [u => u.message.chat.id = -1004344813370, u => u.message.from.is_bot = true,
    u => u.message.forward_origin = { type: 'user' }, u => u.message.sender_chat = { id: -5 }]) {
    const u = message('/update Done: example'); modify(u); assert.equal(parseWorkUpdate(u, { now }), null);
  }
  assert.equal(event('/update Done: example').body, '/update Done: example');
});
test('Dubai dates use the original message time, including at the midnight boundary', () => {
  assert.equal(dubaiDate(null), '');
  assert.equal(dubaiDate(undefined), '');
  assert.equal(dubaiDate('2026-11-04T20:00:00Z'), '2026-11-05');
  const u = message('Done: example'); u.message.date = Date.parse('2026-11-04T19:59:59Z') / 1000;
  assert.equal(parseWorkUpdate(u, { now }).dateDubai, '2026-11-04');
});
test('out-of-order edits, repeats and withdrawn updates resolve to the latest version', () => {
  const a = event('Done: original');
  const u = message('Pending: corrected'); u.edited_message = { ...u.message, edit_date: u.message.date + 10 }; delete u.message;
  const b = parseWorkUpdate(u, { now });
  assert.deepEqual(latestWorkEvents([b, a, b], { date: '2026-11-05' }), [b]);
  u.edited_message.text = 'ordinary chat'; u.edited_message.edit_date += 10;
  const withdrawn = parseWorkUpdate(u, { now }); assert.equal(withdrawn.active, false);
  assert.equal(latestWorkEvents([b, withdrawn, a], { date: '2026-11-05' }).length, 0);
});
test('reports state collection gaps, never fabricate absences, hours or unreported completed work', () => {
  const pages = buildWorkReport([], [], { date: '2026-11-05' });
  assert.match(pages[0].text, /Capture is not active/); assert.match(pages[0].text, /does not mark anyone absent/);
  const r = [{ groupId: AGENT_GROUP, telegramUserId: '10', employeeName: 'Expected member', active: true, membershipVerified: true, firstReportDate: '2026-11-05' }];
  const full = buildWorkReport([], r, { date: '2026-11-06', captureStartedAt: now });
  assert.match(full[0].text, /Expected member\nNo work update recorded/);
  assert.doesNotMatch(full[0].text, /Absent|9 hours/);
});
test('all contributors and source links survive pagination and markup is escaped', () => {
  const rows = Array.from({ length: 45 }, (_, i) => event('Done: <item & proof> ' + 'x'.repeat(250), i + 1));
  const pages = buildWorkReport(rows, [], { date: '2026-11-05', captureStartedAt: '2026-11-04T10:00:00Z' });
  assert.ok(pages.length > 1);
  for (let i = 1; i <= 45; i++) assert.ok(pages.some(p => p.text.includes('Source: https://t.me/c/4383714191/' + i + '\n')));
  assert.ok(pages.every(p => p.text.length < 3800 && !p.html.includes('<item')));
  assert.ok(pages.some(p => p.html.includes('&lt;item &amp; proof&gt;')));
});
