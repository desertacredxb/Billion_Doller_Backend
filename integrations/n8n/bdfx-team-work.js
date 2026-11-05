// Work updates belong to the Agent group. This module never reads attendance.
const AGENT_GROUP = '-1004383714191';

function dubaiDate(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 4 * 3600000).toISOString().slice(0, 10) : '';
}

function parseWorkUpdate(update, { now = new Date(), groupId = AGENT_GROUP } = {}) {
  const m = update?.edited_message ?? update?.message;
  if (!m || String(m.chat?.id) !== groupId || !['group', 'supergroup'].includes(m.chat?.type)
      || m.from?.is_bot || !Number.isSafeInteger(m.from?.id) || m.from.id <= 0
      || !Number.isSafeInteger(m.message_id) || m.message_id <= 0 || m.sender_chat || m.forward_origin) return null;
  if (!Number.isSafeInteger(m.date) || m.date <= 0) return null;
  const at = new Date(m.date * 1000);
  if (at > new Date(now.getTime() + 60000) || now - at > 7 * 86400000) return null;
  const text = String(m.text ?? m.caption ?? '').replace(/\u0000/g, '').trim();
  // Only explicit work reports are collected; discussion and IN/OUT stay silent.
  const work = /^(?:\/update(?:@\w+)?(?:\s|$)|(?:daily\s+)?(?:work\s+)?update\s*[:\-]|(?:done|completed|pending|plan|blockers?|meeting)\s*[:\-])/i.test(text);
  if (!work && !update.edited_message) return null;
  const sourceVersion = Number.isSafeInteger(m.edit_date) ? m.edit_date : m.date;
  const eventKey = groupId + ':' + m.message_id;
  return {
    versionKey: eventKey + ':' + sourceVersion,
    eventKey, groupId, messageId: m.message_id, telegramUserId: String(m.from.id),
    employeeName: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').trim().slice(0, 160) || m.from.username || 'Team member',
    dateDubai: dubaiDate(at), eventAt: at.toISOString(), sourceVersion,
    active: work, body: work ? text.slice(0, 10000) : '', truncated: work && text.length > 10000,
    receivedAt: now.toISOString(),
  };
}

function latestWorkEvents(rows, { date, groupId = AGENT_GROUP } = {}) {
  const versions = new Map();
  for (const row of rows) {
    if (row.groupId !== groupId || row.dateDubai !== date || !row.eventKey
        || !Number.isSafeInteger(row.messageId) || row.messageId <= 0 || !/^\d+$/.test(row.telegramUserId || '')
        || !Number.isSafeInteger(row.sourceVersion) || !Number.isFinite(new Date(row.eventAt).getTime())) continue;
    const old = versions.get(row.eventKey);
    if (!old || row.sourceVersion > old.sourceVersion
        || row.sourceVersion === old.sourceVersion && new Date(row.receivedAt) > new Date(old.receivedAt)) versions.set(row.eventKey, row);
  }
  return [...versions.values()].filter(row => row.active === true && row.body).sort((a, b) => a.eventAt.localeCompare(b.eventAt) || a.messageId - b.messageId);
}

function buildWorkReport(rows, roster, { date, captureStartedAt, groupId = AGENT_GROUP, pageLimit = 3500 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || pageLimit < 1000 || pageLimit > 3800) throw new Error('INVALID_WORK_REPORT');
  const events = latestWorkEvents(rows, { date, groupId });
  const staff = new Map();
  for (const person of roster) {
    if (person.groupId === groupId && person.active === true && person.membershipVerified === true
        && /^\d+$/.test(person.telegramUserId || '') && (!person.firstReportDate || person.firstReportDate <= date)) {
      staff.set(person.telegramUserId, { name: person.employeeName || 'Team member', events: [] });
    }
  }
  const rosterVerified = staff.size > 0;
  for (const event of events) {
    if (!staff.has(event.telegramUserId)) staff.set(event.telegramUserId, { name: event.employeeName, events: [] });
    staff.get(event.telegramUserId).events.push(event);
    staff.get(event.telegramUserId).name = event.employeeName;
  }
  const captureDate = dubaiDate(captureStartedAt);
  const partial = !captureDate || date <= captureDate;
  const header = 'BDFX — TEAM WORK REPORT\n' + date + ' · Dubai\n';
  const coverage = !captureDate ? 'Capture is not active. No complete-day claim.'
    : partial ? 'Partial day: collection started during this day.' : 'Recorded work updates for this Dubai date.';
  const scope = rosterVerified ? 'Verified roster plus members with recorded updates.' : 'Roster not verified: showing recorded contributors only.';
  const blocks = [coverage + '\n' + scope + '\nUpdates: ' + events.length + ' · Contributors: ' + new Set(events.map(e => e.telegramUserId)).size];
  if (!staff.size) blocks.push('No recorded work updates. This does not mark anyone absent.');
  const channel = groupId.replace(/^-100/, '');
  for (const [id, person] of staff) {
    if (!person.events.length) {
      blocks.push(person.name + '\n' + (partial ? 'No recorded update in captured period.' : 'No work update recorded.'));
      continue;
    }
    for (const event of person.events) {
      const time = new Date(new Date(event.eventAt).getTime() + 4 * 3600000).toISOString().slice(11, 16);
      const shortened = event.body.length > 1400 || event.truncated;
      blocks.push(person.name + ' · ' + time + '\n' + event.body.slice(0, 1400)
        + (shortened ? '\n[Excerpt — open source for the full update]' : '')
        + '\nSource: https://t.me/c/' + channel + '/' + event.messageId);
    }
  }
  const pages = [];
  let body = header;
  for (const block of blocks) {
    if (body.length + block.length + 2 > pageLimit) { pages.push(body.trim()); body = header; }
    body += '\n' + block + '\n';
  }
  if (body.trim() !== header.trim()) pages.push(body.trim());
  return pages.map((text, i) => ({ reportKey: groupId + ':' + date + ':' + (i + 1), groupId, dateDubai: date,
    page: i + 1, pages: pages.length, text: text + '\nPage ' + (i + 1) + '/' + pages.length,
    html: (text + '\nPage ' + (i + 1) + '/' + pages.length).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }));
}

module.exports = { AGENT_GROUP, dubaiDate, parseWorkUpdate, latestWorkEvents, buildWorkReport };
