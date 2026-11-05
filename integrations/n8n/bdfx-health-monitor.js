function healthSnapshot(backend, website, now = new Date()) {
  const body = backend?.body;
  const databaseHealthy = backend?.statusCode === 200 && body?.status === 'ok' && body?.database === 'connected';
  // The scheduled website probe is HEAD against the fixed HTTPS homepage.
  const websiteHealthy = website?.statusCode === 200;
  const status = response => Number.isInteger(response?.statusCode) ? 'HTTP ' + response.statusCode : 'Request unavailable';
  const checks = [
    { name: 'Backend / database', ok: databaseHealthy, detail: databaseHealthy ? 'OK' : status(backend) },
    { name: 'Website', ok: websiteHealthy, detail: websiteHealthy ? 'OK' : status(website) },
  ];
  return { checkedAt: now.toISOString(), healthy: checks.every(c => c.ok), signature: checks.map(c => c.ok ? 'ok' : c.detail).join('|'), checks };
}

function planHealthNotice(state, snapshot, { mode = 'scheduled', now = new Date() } = {}) {
  if (!['scheduled', 'preview', 'test'].includes(mode) || !snapshot?.signature || !Array.isArray(snapshot.checks)) throw new Error('INVALID_HEALTH_CHECK');
  if (mode === 'preview') return null;
  const prior = state.healthObservation;
  const changed = !prior || prior.signature !== snapshot.signature;
  const reminder = !snapshot.healthy && !changed && state.healthDelivery?.status === 'sent'
    && now - new Date(state.healthDelivery.at) >= 6 * 3600000;
  const recovery = snapshot.healthy && prior && !prior.healthy;
  if (mode === 'scheduled') {
    state.healthObservation = { signature: snapshot.signature, healthy: snapshot.healthy, checkedAt: snapshot.checkedAt };
    if (!recovery && snapshot.healthy || !changed && !reminder) return null;
  }
  const local = new Date(now.getTime() + 4 * 3600000).toISOString();
  const kind = mode === 'test' ? 'test' : recovery ? 'recovery' : reminder ? 'reminder' : 'alert';
  const heading = kind === 'test' ? 'BDFX SYSTEM ALERT — DELIVERY TEST' : recovery ? 'BDFX SYSTEM — RECOVERED' : 'BDFX SYSTEM — CHECK REQUIRED';
  const text = [heading, ...snapshot.checks.map(c => c.name + ': ' + c.detail),
    'Checked: ' + local.slice(0, 10) + ' ' + local.slice(11, 19) + ' Dubai',
    kind === 'test' ? 'Test notification only. The service statuses above are actual checks.'
      : snapshot.healthy ? 'The monitor can verify both services again.' : 'The monitor could not verify normal service. Please check the affected service.',
    'Automatic checks: every 5 minutes. Repeated unchanged alerts: at most every 6 hours.'].join('\n');
  return { kind, text, checkedAt: snapshot.checkedAt, signature: snapshot.signature };
}

function confirmHealthDelivery(expected, response, { groupId, botId, now = new Date() } = {}) {
  const m = response?.result ?? response;
  const sent = response?.ok !== false && String(m?.chat?.id) === String(groupId) && m?.from?.is_bot === true
    && String(m.from.id) === String(botId) && m.text === expected.text && Number.isSafeInteger(m.message_id) && m.message_id > 0;
  return { status: sent ? 'sent' : 'unconfirmed', kind: expected.kind, signature: expected.signature,
    messageId: sent ? m.message_id : null, at: now.toISOString() };
}

module.exports = { healthSnapshot, planHealthNotice, confirmHealthDelivery };
