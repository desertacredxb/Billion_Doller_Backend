const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createKycNoticeService, noticeKey, sendKycEmail } = require('../services/kycNotices');

const productionEnv = () => ({
  BDFX_KYC_AUTOMATION_ENABLED: 'true', BDFX_KYC_RELEASE_APPROVED: 'true', SUMSUB_MODE: 'production', SUMSUB_LEVEL_NAME: 'production-kyc',
  SUMSUB_CLIENT_ID: 'test-client', SUMSUB_APP_TOKEN: 'test-app', SUMSUB_SECRET_KEY: 'test-key',
  SUMSUB_WEBHOOK_SECRET: 'test-webhook',
});
const user = { _id: 'test-user', email: 'test@example.invalid', phone: '+447911123457' };

// Shared in-memory persistence implements the Mongo predicates used by the
// worker; no test opens a database connection or creates a real transport.
function memoryModel() {
  const records = new Map();
  const calls = [];
  const clone = value => structuredClone(value);
  function matches(record, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some(choice => matches(record, choice));
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('$in' in value) return value.$in.includes(record[key]);
        if ('$lte' in value) return record[key] != null && record[key] <= value.$lte;
        if ('$lt' in value) return record[key] != null && record[key] < value.$lt;
        if ('$gt' in value) return record[key] != null && record[key] > value.$gt;
      }
      if (value instanceof Date) return +new Date(record[key]) === +value;
      return record[key] === value;
    });
  }
  function apply(record, update) {
    Object.assign(record, clone(update.$set || {}));
    for (const [key, value] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + value;
  }
  return {
    records, calls,
    async updateOne(filter, update, options = {}) {
      calls.push({ method: 'updateOne', filter, update, options });
      const record = [...records.values()].find(item => matches(item, filter));
      if (record) { apply(record, update); return { modifiedCount: 1 }; }
      if (!options.upsert) return { modifiedCount: 0 };
      records.set(filter._id, clone(update.$setOnInsert));
      return { upsertedCount: 1, modifiedCount: 0 };
    },
    async updateMany(filter, update, options = {}) {
      calls.push({ method: 'updateMany', filter, update, options });
      let modifiedCount = 0;
      for (const record of records.values()) {
        if (matches(record, filter)) { apply(record, update); modifiedCount += 1; }
      }
      return { modifiedCount };
    },
    async findOne(filter, projection, options = {}) {
      calls.push({ method: 'findOne', filter, options });
      const matching = [...records.values()].filter(item => matches(item, filter));
      if (options.sort) matching.sort((left, right) =>
        right.eventAt - left.eventAt || right.eventPriority - left.eventPriority);
      return matching.length ? clone(matching[0]) : null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ method: 'findOneAndUpdate', filter, update, options });
      const record = [...records.values()].filter(item => matches(item, filter))
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0];
      if (!record) return null;
      apply(record, update);
      return clone(record);
    },
  };
}

function harness(overrides = {}) {
  const NoticeModel = overrides.NoticeModel || memoryModel();
  const clock = { value: new Date('2026-09-24T12:00:00Z') };
  const env = overrides.env || productionEnv();
  return {
    NoticeModel, clock, env,
    service: createKycNoticeService({ NoticeModel, env, now: () => new Date(clock.value),
      sendEmail: async () => true, sendWhatsApp: async () => true, ...overrides }),
  };
}

test('deduplicates repeated event/channel enqueue and stores only safe notice data', async () => {
  const { service, NoticeModel } = harness();
  const unsafe = { ...user, idProof1: { number: 'PRIVATE_DOCUMENT' }, otherSecret: 'PRIVATE_VALUE' };
  await Promise.all(Array.from({ length: 5 }, () => service.enqueueKycNotice(unsafe, 'rejected', 'PRIVATE_PROVIDER_COMMENT', 'review-one')));
  assert.equal(NoticeModel.records.size, 2);
  for (const record of NoticeModel.records.values()) {
    assert.equal(record.state, 'queued');
    assert.equal(record.attempts, 0);
    assert.match(record.reason, /could not be verified/);
    assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
  }
  await service.enqueueKycNotice(user, 'rejected', '', 'review-two');
  assert.equal(NoticeModel.records.size, 4);
  assert.notEqual(noticeKey('a', 'pending', 'bc', 'email'), noticeKey('ab', 'pending', 'c', 'email'));
});

test('passes transaction sessions through and propagates transaction errors', async () => {
  const { service, NoticeModel } = harness();
  const session = { transaction: 'fake' };
  await service.enqueueKycNotice(user, 'approved', '', 'review', { session });
  assert.ok(NoticeModel.calls.every(call => call.options.session === session));
  const conflict = Object.assign(new Error('duplicate'), { code: 11000 });
  const failed = harness({ NoticeModel: { ...memoryModel(), updateOne: async () => { throw conflict; } } }).service;
  await assert.rejects(failed.enqueueKycNotice(user, 'approved', '', 'review', { session }), error => error === conflict);
  await failed.enqueueKycNotice(user, 'approved', '', 'review');
});

test('persists failed channel retry across worker instances without resending a successful channel', async () => {
  let emailAttempts = 0;
  let whatsappAttempts = 0;
  const { service, NoticeModel, clock, env } = harness({
    sendEmail: async () => { emailAttempts += 1; throw new Error('PRIVATE_TRANSPORT_ERROR'); },
    sendWhatsApp: async () => { whatsappAttempts += 1; return true; },
  });
  await service.enqueueKycNotice(user, 'approved', '', 'review');
  assert.deepEqual(await service.processKycNotices(), { claimed: 2, sent: 1, retry: 1, disabled: false });
  const email = NoticeModel.records.get(noticeKey(user._id, 'approved', 'review', 'email'));
  assert.equal(email.state, 'retry');
  assert.equal(email.attempts, 1);
  assert.equal(email.lastErrorCode, 'send_failed');
  assert.equal(email.nextAttemptAt.getTime(), clock.value.getTime() + 60000);
  await service.processKycNotices();
  assert.equal(emailAttempts, 1);
  clock.value = new Date(clock.value.getTime() + 60000);
  const restarted = createKycNoticeService({ NoticeModel, env, now: () => new Date(clock.value),
    sendEmail: async () => { emailAttempts += 1; return true; },
    sendWhatsApp: async () => { whatsappAttempts += 1; return true; } });
  await restarted.processKycNotices();
  assert.equal(email.state, 'sent');
  assert.equal(email.attempts, 2);
  assert.equal(emailAttempts, 2);
  assert.equal(whatsappAttempts, 1);
});

test('competing workers atomically claim one eligible channel', async () => {
  let resolveSend;
  let sends = 0;
  const { service, NoticeModel, env, clock } = harness({
    sendEmail: () => { sends += 1; return new Promise(resolve => { resolveSend = resolve; }); },
  });
  await service.enqueueKycNotice({ ...user, phone: '' }, 'approved', '', 'review');
  const first = service.processKycNotices({ limit: 1 });
  await nextTurn();
  const second = createKycNoticeService({ NoticeModel, env, now: () => clock.value,
    sendEmail: async () => { sends += 1; return true; } });
  assert.equal((await second.processKycNotices()).claimed, 0);
  resolveSend(true);
  await first;
  assert.equal(sends, 1);
});

test('reclaims expired leases and fences the old worker from overwriting the new result', async () => {
  let resolveOldSend;
  const { service, NoticeModel, env, clock } = harness({
    sendEmail: () => new Promise(resolve => { resolveOldSend = resolve; }),
  });
  await service.enqueueKycNotice({ ...user, phone: '' }, 'approved', '', 'review');
  const first = service.processKycNotices({ limit: 1 });
  await nextTurn();
  clock.value = new Date(clock.value.getTime() + 120001);
  const nextWorker = createKycNoticeService({ NoticeModel, env, now: () => clock.value, sendEmail: async () => true });
  await nextWorker.processKycNotices();
  resolveOldSend(false);
  assert.equal((await first).retry, 0);
  const email = NoticeModel.records.get(noticeKey(user._id, 'approved', 'review', 'email'));
  assert.equal(email.state, 'sent');
  assert.equal(email.attempts, 2);
  assert.equal(email.lastErrorCode, '');
});

test('persists notices when disabled but dispatches only with complete production configuration', async () => {
  let sends = 0;
  const { service, env, NoticeModel } = harness({ sendEmail: async () => { sends += 1; return true; } });
  env.BDFX_KYC_AUTOMATION_ENABLED = 'false';
  await service.enqueueKycNotice(user, 'pending', '', 'review');
  assert.equal(NoticeModel.records.size, 2);
  const before = NoticeModel.calls.length;
  assert.equal((await service.processKycNotices()).disabled, true);
  assert.equal(NoticeModel.calls.length, before);
  env.BDFX_KYC_AUTOMATION_ENABLED = 'true';
  env.BDFX_KYC_RELEASE_APPROVED = 'false';
  assert.equal((await service.processKycNotices()).disabled, true);
  env.BDFX_KYC_RELEASE_APPROVED = 'true';
  env.SUMSUB_MODE = 'sandbox';
  assert.equal((await service.processKycNotices()).disabled, true);
  env.SUMSUB_MODE = 'production';
  delete env.SUMSUB_WEBHOOK_SECRET;
  assert.equal((await service.processKycNotices()).disabled, true);
  assert.equal(sends, 0);
});

test('skipped transport results are retried and missing recipients are never marked sent', async () => {
  const { service, NoticeModel } = harness({ sendEmail: async () => ({ sent: false, code: 'configuration_unavailable' }), sendWhatsApp: async () => false });
  await service.enqueueKycNotice(user, 'approved', '', 'review');
  await service.processKycNotices();
  assert.ok([...NoticeModel.records.values()].every(record => record.state === 'retry' && record.lastErrorCode === 'configuration_unavailable'));
  await service.enqueueKycNotice({ _id: 'missing-user', email: '\n', phone: '' }, 'pending', '', 'welcome');
  const missing = [...NoticeModel.records.values()].filter(record => !record.recipient);
  assert.equal(missing.length, 2);
  assert.ok(missing.every(record => record.state === 'skipped' && record.attempts === 0));
});

test('resubmission stays distinct from final rejection on both channels', async () => {
  let email;
  let whatsapp;
  const { service } = harness({
    sendEmail: async message => { email = message; return true; },
    sendWhatsApp: async (...args) => { whatsapp = args; return true; },
  });
  const reason = 'Your identity document has expired. Please submit a valid document.';
  await service.enqueueKycNotice(user, 'resubmission', reason, 'review');
  await service.processKycNotices();
  assert.match(email.subject, /needs a new document/);
  assert.match(email.text, /resubmit/);
  assert.doesNotMatch(email.text, /was rejected/);
  assert.deepEqual(whatsapp, [user.phone, 'resubmission', reason]);
});

test('new approval cancels older pending retries on both channels', async () => {
  const sent = [];
  const { service, NoticeModel, clock } = harness({
    sendEmail: async message => { if (message.subject.endsWith('pending')) throw new Error('temporary failure'); sent.push(message.subject); return true; },
    sendWhatsApp: async (phone, status) => { if (status === 'pending') return false; sent.push(status); return true; },
  });
  const submittedAt = new Date(clock.value);
  await service.enqueueKycNotice({ ...user, kycAutomation: { submittedAt } }, 'pending', '', 'pending-event');
  await service.processKycNotices();
  clock.value = new Date(+clock.value + 1000);
  await service.enqueueKycNotice({ ...user, kycAutomation: { submittedAt, reviewedAt: clock.value } }, 'approved', '', 'approved-event', { session: { fake: true } });
  const pending = [...NoticeModel.records.values()].filter(record => record.status === 'pending');
  assert.ok(pending.every(record => record.state === 'cancelled' && record.lastErrorCode === 'superseded'));
  await service.processKycNotices();
  clock.value = new Date(+clock.value + 120000);
  await service.processKycNotices();
  assert.deepEqual(sent, ['BDFX verification approved', 'approved']);
  assert.ok([...NoticeModel.records.values()].every(record => record.subjectKey !== String(user._id)));
});

test('older provider events cancel themselves without cancelling a newer approval', async () => {
  const sent = [];
  const { service, NoticeModel, clock } = harness({
    sendEmail: async message => { sent.push(message.subject); return true; },
    sendWhatsApp: async (phone, status) => { sent.push(status); return true; },
  });
  const olderAt = new Date(+clock.value - 60000);
  await service.enqueueKycNotice({ ...user, kycAutomation: { reviewedAt: clock.value } }, 'approved', '', 'newer-review');
  await service.enqueueKycNotice({ ...user, kycAutomation: { reviewedAt: olderAt } }, 'rejected', '', 'older-review');
  assert.ok([...NoticeModel.records.values()].filter(record => record.status === 'approved').every(record => record.state === 'queued'));
  assert.ok([...NoticeModel.records.values()].filter(record => record.status === 'rejected').every(record => record.state === 'cancelled'));
  await service.processKycNotices();
  assert.deepEqual(sent, ['BDFX verification approved', 'approved']);
});

test('rechecks a claimed notice after supersession and before transport', async () => {
  let sends = 0;
  const { service, NoticeModel, clock } = harness({
    sendEmail: async () => { sends += 1; return true; }, sendWhatsApp: async () => { sends += 1; return true; },
  });
  await service.enqueueKycNotice(user, 'pending', '', 'pending-event');
  const originalFind = NoticeModel.findOne;
  let superseded = false;
  NoticeModel.findOne = async (...args) => {
    if (args[0]._id && !superseded) {
      superseded = true;
      clock.value = new Date(+clock.value + 1000);
      await service.enqueueKycNotice({ ...user, kycAutomation: { reviewedAt: clock.value } }, 'approved', '', 'approved-event');
    }
    return originalFind(...args);
  };
  await service.processKycNotices({ limit: 1 });
  assert.equal(sends, 0);
  assert.ok([...NoticeModel.records.values()].filter(record => record.status === 'pending').every(record => record.state === 'cancelled'));
  await service.processKycNotices();
  assert.equal(sends, 2);
});

test('uses the latest submission time and reviewed-result priority when timestamps tie', async () => {
  const { service, NoticeModel, clock } = harness();
  const earlierReview = new Date(+clock.value - 60000);
  const current = { ...user, kycAutomation: { reviewedAt: earlierReview, submittedAt: clock.value } };
  await service.enqueueKycNotice(current, 'pending', '', 'intake');
  await service.enqueueKycNotice({ ...user, kycAutomation: { reviewedAt: clock.value } }, 'approved', '', 'review');
  const pending = NoticeModel.records.get(noticeKey(user._id, 'pending', 'intake', 'email'));
  assert.equal(+pending.eventAt, +clock.value);
  assert.equal(pending.state, 'cancelled');
  // Replaying the same intake later must not advance its persisted event time.
  clock.value = new Date(+clock.value + 60000);
  await service.enqueueKycNotice(user, 'pending', '', 'intake');
  assert.equal(pending.state, 'cancelled');
  assert.ok([...NoticeModel.records.values()].filter(record => record.status === 'approved').every(record => record.state === 'queued'));
});

test('SMTP uses existing environment credentials with TLS and records only explicit provider acceptance', async () => {
  let options;
  let message;
  let closed = 0;
  const settings = {
    env: { EMAIL_USER: 'sender@example.invalid', EMAIL_PASS: 'test-password' },
    createTransport: value => {
      options = value;
      return { sendMail: async mail => { message = mail; return { accepted: [mail.to] }; }, close: () => { closed += 1; } };
    },
  };
  assert.equal((await sendKycEmail({ to: user.email, subject: 'test', text: 'test' }, settings)).sent, true);
  assert.equal(options.service, 'gmail');
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.auth.user, settings.env.EMAIL_USER);
  assert.equal(message.from, settings.env.EMAIL_USER);
  assert.equal(closed, 1);
  const rejected = { ...settings, createTransport: () => ({ sendMail: async () => ({ accepted: [], rejected: [user.email] }) }) };
  assert.equal((await sendKycEmail({ to: user.email }, rejected)).sent, false);
  const missing = await sendKycEmail({ to: user.email }, { env: {}, createTransport: () => { throw new Error('unexpected transport'); } });
  assert.equal(missing.code, 'configuration_unavailable');
});

test('SMTP propagates failure and requires STARTTLS for a configured non-TLS port', async () => {
  let options;
  let closed = false;
  await assert.rejects(sendKycEmail({ to: user.email }, {
    env: { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '587', SMTP_USER: 'test', SMTP_PASS: 'test', EMAIL_FROM: 'sender@example.invalid' },
    createTransport: value => {
      options = value;
      return { sendMail: async () => { throw new Error('test SMTP failure'); }, close: () => { closed = true; } };
    },
  }), /test SMTP failure/);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(closed, true);
});

test('worker logs only generic failures and does not expose transport or database details', async () => {
  const logs = [];
  const service = createKycNoticeService({ env: productionEnv(),
    NoticeModel: { findOneAndUpdate: async () => { throw new Error('PRIVATE_DATABASE_DETAILS'); } },
    logger: { error: value => logs.push(value) },
  });
  const stop = service.startKycNoticeWorker();
  await nextTurn();
  stop();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes('PRIVATE'), false);
});
