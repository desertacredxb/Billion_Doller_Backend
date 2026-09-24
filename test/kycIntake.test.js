const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createKycIntakeService, intakeKey, validateDocumentUrl, fetchDocument,
  multipartDocument, MAX_DOCUMENT_BYTES } = require('../services/kycIntake');
const { createSumsubApi, providerReady } = require('../services/sumsubApi');
const { normalizeCountry } = require('../utils/kycCountries');

const env = {
  BDFX_KYC_AUTOMATION_ENABLED: 'true', BDFX_KYC_RELEASE_APPROVED: 'true', SUMSUB_MODE: 'production',
  SUMSUB_LEVEL_NAME: 'test-level', SUMSUB_CLIENT_ID: 'test-client', SUMSUB_APP_TOKEN: 'test-token',
  SUMSUB_SECRET_KEY: 'test-secret', SUMSUB_WEBHOOK_SECRET: 'test-webhook', CLOUDINARY_CLOUD_NAME: 'test-cloud',
};
const front = 'https://res.cloudinary.com/test-cloud/image/upload/v123/Billio-dollar-FX/test_front.png';
const back = 'https://res.cloudinary.com/test-cloud/image/upload/v124/Billio-dollar-FX/test_back.png';
const file = { buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]), mime: 'image/png' };
const get = (row, path) => path.split('.').reduce((value, part) => value?.[part], row);
function set(row, path, value) {
  const parts = path.split('.');
  let target = row;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  target[parts.at(-1)] = structuredClone(value);
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, wanted]) => {
    if (key === '$or') return wanted.some(item => matches(row, item));
    const actual = get(row, key);
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      return Object.entries(wanted).every(([op, value]) => {
        if (op === '$in') return value.includes(actual);
        if (op === '$ne') return actual !== value;
        if (op === '$exists') return (actual !== undefined) === value;
        if (op === '$lte') return actual <= value;
        if (op === '$gt') return actual > value;
        if (op === '$type') return typeof actual === value;
        throw new Error(`Unsupported test query ${op}`);
      });
    }
    return wanted === null ? actual == null : actual === wanted;
  });
}
function memoryModel(rows, operations = [], name = '') {
  function apply(row, update, inserted = false) {
    if (inserted) for (const [key, value] of Object.entries(update.$setOnInsert || {})) set(row, key, value);
    for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
    for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, (get(row, key) || 0) + value);
  }
  return {
    async updateOne(filter, update, options = {}) {
      operations.push({ name, method: 'updateOne', filter, options });
      let row = rows.find(item => matches(item, filter));
      let inserted = false;
      if (!row && options.upsert) { row = {}; rows.push(row); inserted = true; }
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      apply(row, update, inserted);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update, options = {}) {
      operations.push({ name, method: 'updateMany', filter, options });
      const matched = rows.filter(item => matches(item, filter));
      for (const row of matched) apply(row, update);
      return { matchedCount: matched.length, modifiedCount: matched.length };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      operations.push({ name, method: 'findOneAndUpdate', filter, options });
      const row = rows.find(item => matches(item, filter));
      if (!row) return null;
      apply(row, update);
      return structuredClone(row);
    },
    async findById(id) { return structuredClone(rows.find(item => item._id === id)); },
    find(filter) { return { limit: async count => structuredClone(rows.filter(item => matches(item, filter)).slice(0, count)) }; },
  };
}
function harness(options = {}) {
  const users = [{ _id: 'a'.repeat(24), email: 'synthetic@example.invalid', isVerified: true,
    isKycVerified: false, hasSubmittedDocuments: true,
    idProof1: { image: front, backImage: options.backImage || null, issuingCountry: 'India', docType: 'National ID Card' },
    kycAutomation: { status: 'not_started' } }];
  const jobs = [], calls = [], notices = [], downloads = [], operations = [];
  const brokers = [
    { _id: 'pending-ib', email: users[0].email, status: 'pending' },
    { _id: 'another-pending-ib', email: users[0].email, status: 'pending' },
    { _id: 'approved-ib', email: users[0].email, status: 'approved' },
    { _id: 'unrelated-ib', email: 'other@example.invalid', status: 'pending' },
  ];
  const session = { testSession: true };
  let transactionCount = 0;
  let timestamp = new Date('2026-09-24T12:00:00Z');
  const applicant = { id: 'b'.repeat(24), externalUserId: users[0]._id, clientId: env.SUMSUB_CLIENT_ID, type: 'individual', ...options.applicant };
  const api = {
    async fetchApplicant() { calls.push('applicant'); return applicant; },
    async fetchApplicantByExternalUserId() { calls.push('lookup'); return applicant; },
    async fetchReviewStatus() { calls.push('status'); return { reviewStatus: 'init', levelName: options.levelName || env.SUMSUB_LEVEL_NAME }; },
    async sumsubRequest(method, path, data, headers) {
      calls.push({ method, path, data, headers });
      if (path.endsWith('/info/idDoc')) {
        if (options.uploadFailure) throw new Error('Synthetic connection loss');
        return { idDocType: 'ID_CARD', country: options.providerCountry || 'IND' };
      }
      if (options.pendingFailure) throw Object.assign(new Error('Synthetic incomplete steps'), { response: { status: 409 } });
      return { ok: 1 };
    },
    ...options.api,
  };
  const IBModel = memoryModel(brokers, operations, 'IB');
  const updateIBs = IBModel.updateMany;
  IBModel.updateMany = async (...args) => {
    const result = await updateIBs(...args);
    if (options.ibFailure?.()) throw new Error('Synthetic IB write failure');
    return result;
  };
  const service = createKycIntakeService({ IntakeModel: memoryModel(jobs, operations, 'Intake'), UserModel: memoryModel(users, operations, 'User'), IBModel,
    transaction: async work => {
      transactionCount += 1;
      const tables = [users, brokers, jobs, notices];
      const snapshots = tables.map(rows => structuredClone(rows));
      try { return await work(session); }
      catch (error) {
        tables.forEach((rows, index) => rows.splice(0, rows.length, ...snapshots[index]));
        throw error;
      }
    },
    env: { ...env, ...options.env }, api, now: () => timestamp,
    download: async url => { downloads.push(url); return file; },
    notice: async (...args) => { if (options.noticeFailure?.()) throw new Error('Synthetic notice outage'); notices.push(args); },
  });
  return { ...service, api, users, brokers, jobs, calls, notices, downloads, operations, session,
    get transactionCount() { return transactionCount; }, advance: () => { timestamp = new Date(timestamp.getTime() + 3600001); } };
}

test('production release guard is explicit and disabled by default', async () => {
  assert.equal(providerReady({}), false);
  assert.equal(providerReady({ ...env, BDFX_KYC_RELEASE_APPROVED: undefined }), false);
  const h = harness({ env: { BDFX_KYC_RELEASE_APPROVED: 'false' } });
  await h.queueKycIntake(h.users[0]);
  assert.equal(h.jobs.length, 1);
  assert.deepEqual(await h.processKycIntakes(), { claimed: 0, disabled: true });
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 0);
});

test('countries normalize globally and reject invented codes', () => {
  for (const country of ['AE', 'ARE', 'UAE', 'United Arab Emirates']) assert.equal(normalizeCountry(country), 'ARE');
  assert.equal(normalizeCountry('Fiji'), 'FJI');
  assert.equal(normalizeCountry('de'), 'DEU');
  assert.equal(normalizeCountry('ZZZ'), null);
});

test('document URL policy rejects alternate hosts, folders, redirects and credentials', () => {
  assert.equal(validateDocumentUrl(front, env), front);
  for (const value of [front.replace('res.cloudinary.com', '127.0.0.1'), front.replace('test-cloud', 'another-cloud'),
    front.replace('Billio-dollar-FX', 'another-folder'), front.replace('/upload/', '/fetch/'),
    front.replace('https:', 'http:'), front + '?redirect=http://127.0.0.1', front.replace('https://', 'https://user:pass@')]) {
    assert.throws(() => validateDocumentUrl(value, env));
  }
});

test('download validates media signature and enforces a streaming 10 MiB cap', async () => {
  let config;
  const http = { get: async (url, settings) => {
    config = settings; return { headers: { 'content-type': 'image/png' }, data: Readable.from([file.buffer]) };
  } };
  assert.deepEqual((await fetchDocument(front, { env, http })).buffer, file.buffer);
  assert.equal(config.maxRedirects, 0);
  await assert.rejects(fetchDocument(front, { env, http: { get: async () => ({ headers: { 'content-type': 'image/png' },
    data: Readable.from([Buffer.from('<html>')]) }) } }), { code: 'DOCUMENT_INVALID' });
  await assert.rejects(fetchDocument(front, { env, http: { get: async () => ({ headers: { 'content-type': 'image/png' },
    data: Readable.from([file.buffer, Buffer.alloc(MAX_DOCUMENT_BYTES)]) }) } }), { code: 'DOCUMENT_INVALID' });
});

test('provider HMAC covers exact multipart bytes and query string', async () => {
  let captured;
  const api = createSumsubApi({ env, now: () => 1700000000000, http: { request: async config => {
    captured = config; return { data: { ok: 1 } };
  } } });
  const data = multipartDocument({ idDocType: 'ID_CARD', country: 'IND' }, file);
  const path = '/resources/applicants/example/info/idDoc?test=1';
  await api.sumsubRequest('POST', path, data.body, data.headers);
  assert.equal(captured.data, data.body);
  const expected = crypto.createHmac('sha256', env.SUMSUB_SECRET_KEY).update('1700000000POST' + path).update(data.body).digest('hex');
  assert.equal(captured.headers['X-App-Access-Sig'], expected);
  assert.equal(captured.headers['content-type'], data.headers['content-type']);
  assert.equal(captured.maxRedirects, 0);
});

test('duplicate enqueue and concurrent workers upload each side once and request real review without approval', async () => {
  const h = harness({ backImage: back });
  const first = await h.queueKycIntake(h.users[0]);
  assert.deepEqual(await h.queueKycIntake(h.users[0]), first);
  assert.equal(first.intakeKey, intakeKey(h.users[0]._id, front, back));
  await Promise.all([h.processKycIntakes(), h.processKycIntakes()]);
  const uploads = h.calls.filter(call => call.path?.endsWith('/info/idDoc'));
  assert.equal(uploads.length, 2);
  assert.match(uploads[0].data.toString(), /FRONT_SIDE/);
  assert.match(uploads[1].data.toString(), /BACK_SIDE/);
  assert.equal(h.calls.filter(call => call.path?.endsWith('/status/pending')).length, 1);
  assert.equal(h.users[0].kycAutomation.applicantId, 'b'.repeat(24));
  assert.ok(h.users[0].kycAutomation.submittedAt instanceof Date);
  assert.equal(h.users[0].isKycVerified, false);
  assert.equal(h.jobs[0].state, 'done');
  assert.equal(h.notices.length, 1);
});

test('applicant ownership mismatch prevents upload and binding', async () => {
  for (const applicant of [{ clientId: 'other' }, { externalUserId: 'other' }, { type: 'company' }, { sandboxMode: true }]) {
    const h = harness({ applicant });
    await h.processKycIntakes();
    assert.equal(h.downloads.length, 0);
    assert.equal(h.users[0].kycAutomation.applicantId, undefined);
    assert.equal(h.users[0].kycAutomation.status, 'action_required');
    assert.equal(h.jobs[0].lastErrorCode, 'applicant_binding_mismatch');
  }
});

test('upload timeout becomes action required and never retries a possibly accepted image', async () => {
  const h = harness({ uploadFailure: true });
  await h.processKycIntakes();
  h.advance();
  await h.processKycIntakes();
  assert.equal(h.calls.filter(call => call.path?.endsWith('/info/idDoc')).length, 1);
  assert.equal(h.jobs[0].uploadState, 'ambiguous');
  assert.equal(h.jobs[0].state, 'action_required');
  assert.equal(h.calls.filter(call => call.path?.endsWith('/status/pending')).length, 0);
});

test('crash during upload is fenced on lease recovery and not replayed', async () => {
  const h = harness();
  await h.queueKycIntake(h.users[0]);
  Object.assign(h.jobs[0], { state: 'processing', uploadState: 'uploading', leaseToken: 'dead-worker', leaseExpiresAt: new Date(0) });
  await h.processKycIntakes();
  assert.equal(h.calls.length, 0);
  assert.equal(h.jobs[0].state, 'action_required');
  assert.equal(h.jobs[0].uploadState, 'ambiguous');
});

test('additional provider requirements offer action-required fallback without another upload', async () => {
  const h = harness({ pendingFailure: true });
  await h.processKycIntakes();
  assert.equal(h.users[0].kycAutomation.status, 'action_required');
  assert.equal(h.jobs[0].lastErrorCode, 'additional_verification_required');
  h.advance();
  await h.processKycIntakes();
  assert.equal(h.downloads.length, 1);
});

test('a fast RETRY webhook is not overwritten by intake completion', async () => {
  const h = harness();
  const request = h.api.sumsubRequest;
  h.api.sumsubRequest = async (...args) => {
    if (args[1].endsWith('/status/pending')) {
      h.users[0].kycAutomation.status = 'action_required';
      h.users[0].kycAutomation.reason = 'Synthetic review retry';
      return { ok: 1 };
    }
    return request(...args);
  };
  await h.processKycIntakes();
  assert.equal(h.users[0].kycAutomation.status, 'action_required');
  assert.equal(h.users[0].kycAutomation.reason, 'Synthetic review retry');
  assert.equal(h.jobs[0].state, 'cancelled');
  assert.equal(h.notices.length, 0);
});

test('UAE provider result is refused and notice-outage retry preserves the refusal without uploading again', async () => {
  let failed = false;
  const h = harness({ providerCountry: 'ARE', noticeFailure: () => { if (failed) return false; failed = true; return true; } });
  await h.processKycIntakes();
  assert.equal(h.users[0].kycAutomation.status, 'pending');
  assert.equal(h.brokers[0].status, 'pending');
  assert.equal(h.brokers[1].status, 'pending');
  assert.equal(h.users[0].kycAutomation.reviewedAt, undefined);
  assert.equal(h.jobs[0].state, 'retry');
  h.advance();
  await h.processKycIntakes();
  assert.equal(h.jobs[0].state, 'rejected');
  assert.equal(h.users[0].kycAutomation.status, 'rejected');
  assert.equal(h.brokers[0].status, 'rejected');
  assert.equal(h.brokers[1].status, 'rejected');
  assert.equal(h.brokers[2].status, 'approved');
  assert.equal(h.brokers[3].status, 'pending');
  assert.equal(h.transactionCount, 2);
  assert.equal(h.notices[0][4].session, h.session);
  for (const name of ['User', 'IB', 'Intake']) {
    assert.ok(h.operations.some(operation => operation.name === name && operation.options.session === h.session));
  }
  assert.equal(h.notices.length, 1);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.users[0].isKycVerified, false);
});

test('IB refusal write failure rolls back User and notice and retries without another upload', async () => {
  let failed = false;
  const h = harness({ providerCountry: 'ARE', ibFailure: () => { if (failed) return false; failed = true; return true; } });
  await h.processKycIntakes();
  assert.equal(h.users[0].kycAutomation.status, 'pending');
  assert.equal(h.brokers[0].status, 'pending');
  assert.equal(h.notices.length, 0);
  assert.equal(h.jobs[0].state, 'retry');
  h.advance();
  await h.processKycIntakes();
  assert.equal(h.users[0].kycAutomation.status, 'rejected');
  assert.equal(h.brokers[0].status, 'rejected');
  assert.equal(h.notices.length, 1);
  assert.equal(h.downloads.length, 1);
});

test('an existing applicant on a different level is not uploaded or sent for the wrong checks', async () => {
  const h = harness({ levelName: 'old-unrelated-level' });
  await h.processKycIntakes();
  assert.equal(h.downloads.length, 0);
  assert.equal(h.calls.filter(call => call.path?.endsWith('/status/pending')).length, 0);
  assert.equal(h.users[0].kycAutomation.status, 'action_required');
  assert.equal(h.jobs[0].lastErrorCode, 'verification_level_mismatch');
});

test('a replaced document cancels stale queue work', async () => {
  const h = harness();
  await h.queueKycIntake(h.users[0]);
  h.users[0].idProof1.image = back;
  await h.processKycIntakes();
  assert.equal(h.jobs[0].state, 'cancelled');
  assert.equal(h.calls.length, 0);
});

test('bounded legacy recovery excludes action-required and final records', async () => {
  const h = harness();
  for (const [index, status] of ['action_required', 'rejected', 'approved'].entries()) {
    h.users.push({ ...structuredClone(h.users[0]), _id: String(index).repeat(24), kycAutomation: { status } });
  }
  await h.processKycIntakes();
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].state, 'done');
});
