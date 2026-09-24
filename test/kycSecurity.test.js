const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const mongoose = require('mongoose');
const User = require('../models/User');
const IB = require('../models/Broker.model');

// Exercise the real Express routes/controllers without external mail, upload or KYC calls.
const emails = [];
let notifyKyc = async () => {};
function stubModule(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stubModule('../utils/sendEmail', async mail => { emails.push(mail); });
stubModule('../controllers/sumsubController', {
  notify: (...args) => notifyKyc(...args),
  createVerificationLink: (req, res) => res.sendStatus(503),
  getVerificationStatus: (req, res) => res.json({ status: 'not_started', userId: req.user.id }),
});
const passThrough = () => (req, res, next) => next();
stubModule('../middleware/cloudinaryUploader', {
  single: passThrough,
  uploadKycDocuments: fields => {
    const parse = multer({ storage: multer.memoryStorage() }).fields(fields);
    return (req, res, next) => parse(req, res, error => {
      if (error) return res.status(400).json({ message: 'Invalid upload fields.' });
      for (const files of Object.values(req.files || {})) {
        for (const file of files) file.path = `https://example.com/uploads/${file.originalname}`;
      }
      next();
    });
  },
});

const authRoutes = require('../routes/authRoutes');
const ibRoutes = require('../routes/IBRoutes');
const { updateDocuments } = require('../controllers/authController');
const userId = '507f1f77bcf86cd799439011';
const account = {
  _id: userId, email: 'owner@example.com', fullName: 'Owner', phone: '+447911123456',
  isVerified: true, isKycVerified: false, kycAutomation: { status: 'not_started' },
};
const ibForm = {
  email: account.email, existingClientBase: 'Yes', offerEducation: 'No',
  expectedClientsNext3Months: '0-10', expectedCommissionDirect: '2',
  expectedCommissionSubIB: '0', yourShare: '1', clientShare: '1',
};
let server;
let baseUrl;
let token;

before(async () => {
  process.env.JWT_SECRET = 'security-tests-only-signing-key';
  token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/ib', ibRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  emails.length = 0;
  notifyKyc = async () => {};
  process.env.BDFX_KYC_AUTOMATION_ENABLED = 'true';
  process.env.BDFX_KYC_RELEASE_APPROVED = 'true';
  process.env.SUMSUB_MODE = 'production';
  process.env.SUMSUB_CLIENT_ID = 'test-client';
  process.env.SUMSUB_LEVEL_NAME = 'test-production-level';
  delete process.env.BDFX_ADMIN_USER_IDS;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function request(path, body, { method = 'PUT', authenticated = true } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test('profile and IB routes reject unauthenticated callers before accessing users', async t => {
  const lookup = t.mock.method(User, 'findById', async () => { throw new Error('unexpected user lookup'); });
  assert.equal((await request(`/api/auth/update-profile/${account.email}`, { fullName: 'Attacker' }, { authenticated: false })).status, 401);
  assert.equal((await request('/api/ib/register', ibForm, { method: 'POST', authenticated: false })).status, 401);
  assert.equal(lookup.mock.callCount(), 0);
});

test('KYC status route requires an authenticated session', async t => {
  t.mock.method(User, 'findById', async () => account);
  assert.equal((await fetch(`${baseUrl}/api/auth/kyc/status`)).status, 401);
  const response = await fetch(`${baseUrl}/api/auth/kyc/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).userId, userId);
});

test('signed-in users cannot update or submit IB applications for another email', async t => {
  t.mock.method(User, 'findById', async id => { assert.equal(id, userId); return account; });
  const update = t.mock.method(User, 'findOneAndUpdate', async () => { throw new Error('unexpected write'); });
  const ibLookup = t.mock.method(IB, 'findOne', async () => { throw new Error('unexpected IB lookup'); });
  assert.equal((await request('/api/auth/update-profile/victim@example.com', { fullName: 'Attacker' })).status, 403);
  assert.equal((await request('/api/ib/register', { ...ibForm, email: 'victim@example.com' }, { method: 'POST' })).status, 403);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(ibLookup.mock.callCount(), 0);
});

test('profile allowlist rejects approval, credential, identity and operator injection', async t => {
  t.mock.method(User, 'findById', async () => account);
  const update = t.mock.method(User, 'findOneAndUpdate', async () => { throw new Error('unexpected write'); });
  for (const payload of [
    { isKycVerified: true }, { isApprovedIB: true }, { isVerified: true },
    { kycAutomation: { status: 'approved', provider: 'sumsub', processedAt: new Date().toISOString() } },
    { 'kycAutomation.status': 'approved' }, { password: 'new-password' },
    { email: 'other@example.com' }, { country: 'Canada' }, { nationality: 'Canada' },
    { fullName: 'Allowed', commission: 999 }, { $set: { isApprovedIB: true } },
    { address: { $ne: null } }, [], {},
  ]) {
    assert.equal((await request(`/api/auth/update-profile/${account.email}`, payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal(update.mock.callCount(), 0);
});

test('profile form fields remain editable only on the token owner account', async t => {
  t.mock.method(User, 'findById', async () => account);
  const update = t.mock.method(User, 'findOneAndUpdate', async (filter, change, options) => {
    assert.deepEqual(filter, { _id: userId });
    assert.deepEqual(change, { $set: { fullName: 'Updated Owner', phone: '+447911123456', accountType: 'Individual', address: 'New address' } });
    assert.equal(options.runValidators, true);
    return { ...account, ...change.$set };
  });
  const response = await request(`/api/auth/update-profile/${account.email.toUpperCase()}`, {
    fullName: ' Updated Owner ', phone: '+44 7911 123456', accountType: 'Individual', address: 'New address',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.fullName, 'Updated Owner');
  assert.equal(update.mock.callCount(), 1);
});

test('IB registration ignores submitted KYC flags and requires stored provider evidence', async t => {
  let storedUser = account;
  t.mock.method(User, 'findById', async () => storedUser);
  t.mock.method(IB, 'findOne', async () => null);
  const saved = [];
  t.mock.method(IB.prototype, 'save', async function () { saved.push(this.toObject()); return this; });
  const approve = t.mock.method(User, 'updateOne', async () => { throw new Error('unexpected approval'); });
  const body = { ...ibForm, isKycVerified: true, isApprovedIB: true,
    kycAutomation: { status: 'approved', provider: 'sumsub', reviewId: 'forged', processedAt: new Date().toISOString() } };
  assert.equal((await request('/api/ib/register', body, { method: 'POST' })).status, 201);
  storedUser = { ...account, isKycVerified: true, kycAutomation: { status: 'approved' } };
  assert.equal((await request('/api/ib/register', body, { method: 'POST' })).status, 201);
  assert.equal(saved.length, 2);
  assert.ok(saved.every(ib => ib.status === 'pending' && !ib.referralCode));
  assert.equal(approve.mock.callCount(), 0);
});

test('an authenticated account with processed production Sumsub approval can become an IB', async t => {
  t.mock.method(User, 'findById', async () => ({ ...account, isKycVerified: true,
    kycAutomation: { status: 'approved', provider: 'sumsub', reviewId: 'review-1', processedAt: new Date() } }));
  t.mock.method(IB, 'findOne', async filter => { assert.deepEqual(filter, { email: account.email }); return null; });
  t.mock.method(IB.prototype, 'save', async function () { return this; });
  const approve = t.mock.method(User, 'updateOne', async (filter, change) => {
    assert.deepEqual(filter, { _id: userId });
    assert.deepEqual(change, { $set: { isApprovedIB: true } });
  });
  const response = await request('/api/ib/register', { ...ibForm, email: account.email.toUpperCase() }, { method: 'POST' });
  assert.equal(response.status, 201);
  assert.match((await response.json()).referralCode, /^IB[A-F0-9]{10}$/);
  assert.equal(approve.mock.callCount(), 1);
});

test('IB auto-approval remains blocked until release approval is explicitly enabled', async t => {
  delete process.env.BDFX_KYC_RELEASE_APPROVED;
  t.mock.method(User, 'findById', async () => ({ ...account, isKycVerified: true,
    kycAutomation: { status: 'approved', provider: 'sumsub', reviewId: 'review-1', processedAt: new Date() } }));
  t.mock.method(IB, 'findOne', async () => null);
  let saved;
  t.mock.method(IB.prototype, 'save', async function () { saved = this; return this; });
  const approve = t.mock.method(User, 'updateOne', async () => { throw new Error('unexpected approval'); });
  const response = await request('/api/ib/register', ibForm, { method: 'POST' });
  assert.equal(response.status, 201);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.referralCode, undefined);
  assert.equal(approve.mock.callCount(), 0);
});

test('manual KYC and IB decisions stay blocked when automation configuration is incomplete', async t => {
  delete process.env.SUMSUB_MODE;
  delete process.env.SUMSUB_CLIENT_ID;
  process.env.BDFX_ADMIN_USER_IDS = userId;
  t.mock.method(User, 'findById', async () => account);
  const lookup = t.mock.method(User, 'findOne', async () => { throw new Error('manual route must be blocked'); });
  for (const [path, method] of [
    [`/api/auth/${account.email}/verify-kyc`, 'PUT'], [`/api/auth/reject/${account.email}`, 'POST'],
    [`/api/ib/${account.email}/approve`, 'PUT'], [`/api/ib/${account.email}/reject`, 'PUT'],
  ]) {
    assert.equal((await request(path, { status: true }, { method, authenticated: false })).status, 401);
    assert.equal((await request(path, { status: true }, { method })).status, 409);
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('signup requires email verification without the deferred WhatsApp OTP gate', async t => {
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(bcrypt, 'hash', async () => 'test-password-hash');
  let saved;
  t.mock.method(User.prototype, 'save', async function () { saved = this; return this; });
  const response = await request('/api/auth/register', {
    fullName: 'New User', email: 'new@example.com', phone: '+447911123456',
    nationality: 'United Kingdom', state: 'England', city: 'London', password: 'test-password',
    isVerified: true,
  }, { method: 'POST', authenticated: false });
  assert.equal(response.status, 200);
  assert.equal(saved.isVerified, false);
  assert.match(saved.otp, /^\d{6}$/);
  assert.ok(saved.otpExpires > new Date());
  assert.equal(emails[0].subject, 'Verify Your Email Address - OTP Code');
  assert.ok(emails[0].html.includes(saved.otp));
  assert.equal((await request('/api/auth/phone-otp/request', {}, { method: 'POST', authenticated: false })).status, 404);
  assert.equal((await request('/api/auth/phone-otp/verify', {}, { method: 'POST', authenticated: false })).status, 404);
});

test('email OTP completion issues a token compatible with protected profile routes', async t => {
  const user = { ...account, isVerified: false, otp: '123456', otpExpires: new Date(Date.now() + 60000), save: async () => {} };
  t.mock.method(User, 'findOne', async () => user);
  const response = await request('/api/auth/verify-otp', { email: account.email, otp: '123456' }, { method: 'POST', authenticated: false });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(jwt.verify(result.token, process.env.JWT_SECRET).id, userId);
  assert.equal(user.isVerified, true);
});

function mockIntake(t, queueKycIntake) {
  const Module = require('node:module');
  const originalLoad = Module._load;
  // The intake service is an external boundary for these controller security tests.
  t.mock.method(Module, '_load', function (path, ...args) {
    if (path === '../services/kycIntake') return { queueKycIntake };
    return originalLoad.call(this, path, ...args);
  });
}

function uploadRequest() {
  return { params: { email: account.email }, user: { id: userId },
    body: { idProof1DocType: 'Passport', idProof1DocNumber: 'TEST123', idProof1IssuingCountry: 'GBR' },
    files: { idProof1Image: [{ path: 'https://example.com/test-id.jpg' }] } };
}

function responseRecorder() {
  return { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('failed enqueue is surfaced and retry queues the stored ID without replacing it', async t => {
  let storedUser = { ...account, hasSubmittedDocuments: false };
  t.mock.method(User, 'findOne', async () => storedUser);
  const persist = t.mock.method(User, 'findOneAndUpdate', async (filter, change) => {
    assert.equal(filter._id, userId);
    storedUser = { ...account, hasSubmittedDocuments: true, idProof1: change.$set.idProof1 };
    return storedUser;
  });
  let attempts = 0;
  mockIntake(t, async accepted => {
    assert.equal(accepted, storedUser);
    assert.equal(accepted.idProof1.docNumber, 'TEST123');
    if (++attempts === 1) throw new Error('private queue diagnostic');
  });
  t.mock.method(console, 'error', () => {});
  const first = responseRecorder();
  await updateDocuments(uploadRequest(), first);
  assert.equal(first.statusCode, 503);
  assert.equal(first.body.retryable, true);
  assert.equal(JSON.stringify(first.body).includes('private queue diagnostic'), false);
  assert.equal(storedUser.hasSubmittedDocuments, true);
  const retry = responseRecorder();
  await updateDocuments({ params: { email: account.email }, body: {} }, retry);
  assert.equal(retry.statusCode, 202);
  assert.equal(retry.body.verificationStatus, 'pending');
  assert.equal(attempts, 2);
  assert.equal(persist.mock.callCount(), 1);
});

test('provider-requested replacement clears review proof and retains applicant binding', async t => {
  const storedUser = { ...account, hasSubmittedDocuments: true,
    idProof1: { backImage: 'https://example.com/old-id-back.jpg' },
    kycAutomation: { status: 'action_required', applicantId: 'applicant-1', provider: 'sumsub', reviewId: 'old-review', processedAt: new Date() } };
  t.mock.method(User, 'findOne', async () => storedUser);
  t.mock.method(User, 'findOneAndUpdate', async (filter, change) => {
    assert.equal(filter['kycAutomation.status'], 'action_required');
    assert.equal(change.$set['kycAutomation.status'], 'not_started');
    assert.equal(change.$set['kycAutomation.reviewId'], '');
    assert.equal(change.$set.idProof1.backImage, null);
    assert.equal(Object.hasOwn(change.$unset, 'kycAutomation.processedAt'), true);
    assert.equal(Object.hasOwn(change.$unset, 'kycAutomation.provider'), true);
    assert.equal(Object.hasOwn(change.$set, 'kycAutomation.applicantId'), false);
    assert.equal(Object.hasOwn(change.$unset, 'kycAutomation.applicantId'), false);
    return { ...storedUser, idProof1: change.$set.idProof1,
      kycAutomation: { status: 'not_started', applicantId: 'applicant-1' } };
  });
  let queued = false;
  mockIntake(t, async accepted => { queued = true; assert.equal(accepted.kycAutomation.applicantId, 'applicant-1'); });
  const response = responseRecorder();
  await updateDocuments(uploadRequest(), response);
  assert.equal(response.statusCode, 202);
  assert.equal(queued, true);
});

test('documents cannot replace a pending or final provider decision', async t => {
  let status;
  t.mock.method(User, 'findOne', async () => ({ ...account, hasSubmittedDocuments: true, kycAutomation: { status } }));
  const persist = t.mock.method(User, 'findOneAndUpdate', async () => { throw new Error('unexpected document write'); });
  mockIntake(t, async () => { throw new Error('unexpected enqueue'); });
  for (status of ['pending', 'approved', 'rejected']) {
    const response = responseRecorder();
    await updateDocuments(uploadRequest(), response);
    assert.equal(response.statusCode, 409);
  }
  assert.equal(persist.mock.callCount(), 0);
});

test('a concurrent review transition prevents replacing documents or starting intake', async t => {
  t.mock.method(User, 'findOne', async () => ({ ...account, hasSubmittedDocuments: true, kycAutomation: { status: 'action_required' } }));
  t.mock.method(User, 'findOneAndUpdate', async () => null);
  mockIntake(t, async () => { throw new Error('unexpected enqueue'); });
  const response = responseRecorder();
  await updateDocuments(uploadRequest(), response);
  assert.equal(response.statusCode, 409);
});

test('authenticated document route accepts one front and optional back, rejects a second ID or missing front', async t => {
  t.mock.method(User, 'findById', id => {
    assert.equal(id, userId);
    return Promise.resolve(account);
  });
  t.mock.method(User, 'findOne', async () => ({ ...account, hasSubmittedDocuments: false }));
  let acceptedProof;
  const persist = t.mock.method(User, 'findOneAndUpdate', async (filter, change) => {
    acceptedProof = change.$set.idProof1;
    return { ...account, hasSubmittedDocuments: true, idProof1: acceptedProof };
  });
  mockIntake(t, async accepted => assert.equal(accepted.idProof1, acceptedProof));

  const sendMultipart = async files => {
    const body = new FormData();
    body.set('idProof1DocType', 'National ID Card');
    body.set('idProof1DocNumber', 'TEST123');
    body.set('idProof1IssuingCountry', 'GBR');
    for (const [field, name] of files) body.append(field, new Blob(['test-image'], { type: 'image/jpeg' }), name);
    return fetch(`${baseUrl}/api/auth/documents/${account.email}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body,
      signal: AbortSignal.timeout(5000),
    });
  };

  assert.equal((await sendMultipart([['idProof1Image', 'front.jpg'], ['idProof1BackImage', 'back.jpg']])).status, 202);
  assert.equal(acceptedProof.image, 'https://example.com/uploads/front.jpg');
  assert.equal(acceptedProof.backImage, 'https://example.com/uploads/back.jpg');
  // The real schema preserves the back URL under the first ID.
  assert.equal(new User({ idProof1: acceptedProof }).idProof1.backImage, acceptedProof.backImage);
  assert.equal((await sendMultipart([['idProof1BackImage', 'back.jpg']])).status, 400);
  assert.equal((await sendMultipart([['idProof1Image', 'front.jpg'], ['idProof2Image', 'other-id.jpg']])).status, 400);
  assert.equal((await sendMultipart([['idProof1Image', 'front.jpg'], ['idProof1BackImage', 'back.jpg'], ['idProof1BackImage', 'extra.jpg']])).status, 400);
  assert.equal(persist.mock.callCount(), 1);
});

test('UAE refusal, pending IB rejection and durable notice use one transaction with retryable failures', async t => {
  const stored = { ...account, hasSubmittedDocuments: false, kycAutomation: { status: 'not_started' } };
  const session = { testSession: true };
  t.mock.method(User, 'findOne', async () => stored);
  const transaction = t.mock.method(mongoose.connection, 'transaction', async callback => callback(session));
  t.mock.method(User, 'findOneAndUpdate', async (filter, change, options) => {
    assert.equal(options.session, session);
    assert.deepEqual(filter['kycAutomation.status'], { $nin: ['pending', 'approved', 'rejected'] });
    assert.equal(change.$set.isApprovedIB, false);
    return { ...stored, isKycVerified: false, kycAutomation: { status: change.$set['kycAutomation.status'],
      reviewedAt: change.$set['kycAutomation.reviewedAt'], submittedAt: change.$set['kycAutomation.submittedAt'] } };
  });
  const rejectIb = t.mock.method(IB, 'updateMany', async (filter, change, options) => {
    assert.equal(options.session, session);
    assert.deepEqual(filter, { email: account.email, status: 'pending' });
    assert.deepEqual(change, { $set: { status: 'rejected' } });
  });
  let failNotice = true;
  notifyKyc = async (user, status, reason, options) => {
    assert.equal(options.session, session);
    assert.equal(options.eventKey, `intake-uae:${userId}:${reason}`);
    assert.equal(status, 'rejected');
    assert.equal(user.kycAutomation.status, 'rejected');
    assert.ok(user.kycAutomation.reviewedAt instanceof Date);
    assert.ok(user.kycAutomation.submittedAt instanceof Date);
    if (failNotice) throw new Error('private outbox failure');
  };
  t.mock.method(console, 'error', () => {});
  const upload = uploadRequest();
  upload.body.idProof1IssuingCountry = 'United Arab Emirates';
  const failed = responseRecorder();
  await updateDocuments(upload, failed);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.retryable, true);
  assert.equal(JSON.stringify(failed.body).includes('private outbox failure'), false);
  // No mutation of the pre-transaction document leaves a false terminal state in memory.
  assert.equal(stored.kycAutomation.status, 'not_started');
  failNotice = false;
  const retried = responseRecorder();
  await updateDocuments(upload, retried);
  assert.equal(retried.statusCode, 403);
  assert.equal(transaction.mock.callCount(), 2);
  assert.equal(rejectIb.mock.callCount(), 2);
  for (const country of ['AE', 'ARE', 'UAE']) {
    upload.body.idProof1IssuingCountry = country;
    const response = responseRecorder();
    await updateDocuments(upload, response);
    assert.equal(response.statusCode, 403, country);
  }
});
