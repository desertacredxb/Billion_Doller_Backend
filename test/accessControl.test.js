const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Account = require('../models/account.model');
const IB = require('../models/Broker.model');
const { createAccessControl } = require('../middleware/accessControl');

let uploadCalls = 0;
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../utils/sendEmail', async () => { throw new Error('Unexpected external mail'); });
stub('../controllers/sumsubController', {
  notify: async () => {}, createVerificationLink: (req, res) => res.sendStatus(503),
  getVerificationStatus: (req, res) => res.json({ status: 'not_started' }),
});
stub('../middleware/cloudinaryUploader', {
  single: () => (req, res, next) => { uploadCalls += 1; next(); },
  uploadKycDocuments: () => (req, res, next) => { uploadCalls += 1; next(); },
});
const auth = require('../middleware/authMiddleware');
const authRoutes = require('../routes/authRoutes');
const ibRoutes = require('../routes/IBRoutes');
const ownerId = 'a'.repeat(24), otherId = 'b'.repeat(24);
const owner = { _id: ownerId, email: 'Owner@example.invalid', fullName: 'Synthetic Owner', isVerified: true };
const secret = 'only-a-synthetic-test-signing-key';
let server, base;

before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.get('/claims', auth, (req, res) => res.json(req.user));
  app.use('/api/auth', authRoutes);
  app.use('/api/ib', ibRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  delete process.env.BDFX_ADMIN_USER_IDS;
  process.env.BDFX_KYC_AUTOMATION_ENABLED = 'true';
  uploadCalls = 0;
});

function request(path, { method = 'GET', body, claims = { id: ownerId }, algorithm = 'HS256', authenticated = true } = {}) {
  return fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${jwt.sign(claims, secret, { algorithm })}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
}
const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

test('JWT accepts only HS256 and valid subject IDs and discards privilege claims', async () => {
  assert.equal((await request('/claims', { algorithm: 'HS384' })).status, 401);
  assert.equal((await request('/claims', { claims: { id: 'not-an-id' } })).status, 401);
  assert.equal((await request('/claims', { claims: { id: ownerId, sub: otherId } })).status, 401);
  const accepted = await request('/claims', { claims: { id: ownerId, role: 'admin', isAdmin: true, email: 'victim@example.invalid' } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { id: ownerId });
});

test('empty admin allowlist denies valid users and signed admin claims', async t => {
  t.mock.method(User, 'findById', async () => ({ ...owner, isAdmin: true, role: 'admin' }));
  const result = await request('/api/auth/admin/session', { claims: { id: ownerId, isAdmin: true, role: 'admin' } });
  assert.equal(result.status, 403);
});

test('only an existing verified allowlisted user receives the minimal admin session', async t => {
  process.env.BDFX_ADMIN_USER_IDS = `invalid, ${ownerId.toUpperCase()}`;
  let stored = { ...owner, password: 'hidden', otp: 'hidden' };
  t.mock.method(User, 'findById', async () => stored);
  const granted = await request('/api/auth/admin/session');
  assert.equal(granted.status, 200);
  assert.deepEqual(await granted.json(), { isAdmin: true, user: { id: ownerId, email: owner.email, fullName: owner.fullName } });
  stored = { ...owner, isVerified: false };
  assert.equal((await request('/api/auth/admin/session')).status, 401);
  stored = null;
  assert.equal((await request('/api/auth/admin/session')).status, 401);
});

test('admin lists and destructive or approval routes reject ordinary principals before controller access', async t => {
  t.mock.method(User, 'findById', async () => owner);
  const lookup = t.mock.method(User, 'findOne', async () => { throw new Error('Controller should not run'); });
  for (const [path, method] of [
    ['/api/auth/users', 'GET'], ['/api/auth/unverified', 'GET'], ['/api/ib', 'GET'],
    [`/api/auth/delete/${owner.email}`, 'DELETE'], [`/api/auth/bank-approve/${owner.email}`, 'PATCH'],
    [`/api/auth/${owner.email}/verify-kyc`, 'PUT'], [`/api/auth/reject/${owner.email}`, 'POST'],
    [`/api/ib/${owner.email}/approve`, 'PUT'], [`/api/ib/${owner.email}/reject`, 'PUT'],
    ['/api/ib/update-commission', 'POST'], ['/api/ib/update-commission-v1', 'POST'],
  ]) assert.equal((await request(path, { method, ...(method !== 'GET' ? { body: { email: owner.email, status: true } } : {}) })).status, 403, path);
  assert.equal(lookup.mock.callCount(), 0);
});

test('owner checks precede uploads and reject cross-user lookup, bank and password actions', async t => {
  t.mock.method(User, 'findById', async () => owner);
  for (const [path, method] of [
    ['/api/auth/user/victim@example.invalid', 'GET'], ['/api/auth/profile-image/victim@example.invalid', 'PUT'],
    ['/api/auth/documents/victim@example.invalid', 'PUT'], ['/api/auth/bank/victim@example.invalid', 'PUT'],
    ['/api/auth/change-password/victim@example.invalid', 'PUT'],
  ]) assert.equal((await request(path, { method, ...(method !== 'GET' ? { body: {} } : {}) })).status, 403, path);
  assert.equal(uploadCalls, 0);
  assert.equal((await request(`/api/auth/profile-image/${owner.email.toUpperCase()}`, { method: 'PUT', body: {} })).status, 400);
  assert.equal(uploadCalls, 1);
});

test('an allowlisted admin can read client details for the admin IB view without returning credentials', async t => {
  process.env.BDFX_ADMIN_USER_IDS = ownerId;
  t.mock.method(User, 'findById', async () => owner);
  t.mock.method(User, 'findOne', filter => {
    assert.equal(filter.email, 'client@example.invalid');
    return { select() { return this; }, populate: async () => ({ _id: otherId,
      email: filter.email, password: 'hidden-password', resetOtp: 'hidden-code',
      accounts: [{ accountNo: 1234, mt5Password: 'hidden-trading-password' }] }) };
  });
  const result = await request('/api/auth/user/client@example.invalid');
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.email, 'client@example.invalid');
  assert.deepEqual(body.accounts, [{ accountNo: 1234 }]);
  assert.equal(JSON.stringify(body).includes('hidden-'), false);
});

test('email guards reject operator objects and normalize only owner matches', async () => {
  const controls = createAccessControl();
  const req = { principal: { id: ownerId, email: owner.email, isAdmin: false }, body: { email: { $ne: '' } } };
  let passed = false;
  const denied = response();
  controls.requireOwnerEmail('body', 'email')(req, denied, () => { passed = true; });
  assert.equal(denied.code, 400);
  assert.equal(passed, false);
  req.body.email = ` ${owner.email.toUpperCase()} `;
  controls.requireOwnerEmail('body', 'email')(req, response(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(req.body.email, owner.email);
});

test('account aliases must agree and destination ownership is checked against Account.user', async () => {
  let lookups = 0;
  const controls = createAccessControl({ AccountModel: { findOne: async () => {
    lookups += 1; return { _id: 'account-id', accountNo: 1234, user: otherId, userType: 'ADMIN' };
  } } });
  const check = controls.requireAccountOwner('body', ['accountno', 'login']);
  const req = { principal: { id: ownerId, email: owner.email, isAdmin: false }, body: { accountno: 1234, login: 5678 } };
  const conflicting = response();
  await check(req, conflicting, () => assert.fail('Conflicting aliases passed'));
  assert.equal(conflicting.code, 400);
  assert.equal(lookups, 0);
  req.body.login = 1234;
  const denied = response();
  await check(req, denied, () => assert.fail('Foreign account passed'));
  assert.equal(denied.code, 403);
  req.principal.isAdmin = true;
  let passed = false;
  await check(req, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test('User JSON, object and plain DTOs redact authentication and nested trading credentials', () => {
  const privateFields = { password: 'hidden-password', otp: 'hidden-otp', otpExpires: new Date(),
    resetOtp: 'hidden-reset', resetOtpExpires: new Date() };
  const accounts = [{ accountNo: 1234, moneyPlantPassword: 'hidden-mp', mt5Password: 'hidden-mt5', mt5InvestorPassword: 'hidden-investor' }];
  const user = new User({ ...owner, ...privateFields });
  user.accounts = accounts;
  for (const dto of [user.toJSON(), user.toObject(), User.toSafeObject({ ...owner, ...privateFields, accounts })]) {
    for (const name of Object.keys(privateFields)) assert.equal(Object.hasOwn(dto, name), false, name);
    assert.deepEqual(dto.accounts.map(account => Object.keys(account)), [['accountNo']]);
    assert.equal(JSON.stringify(dto).includes('hidden-'), false);
  }
  for (const name of Object.keys(privateFields)) assert.equal(User.schema.path(name).options.select, false);
});

test('login explicitly loads credentials for comparison but returns a redacted user', async t => {
  t.mock.method(User, 'findOne', async (filter, projection) => {
    assert.match(projection, /\+password/);
    return { ...owner, password: 'synthetic-hash', otp: null, resetOtp: 'hidden-reset' };
  });
  t.mock.method(bcrypt, 'compare', async (password, hash) => password === 'synthetic-password' && hash === 'synthetic-hash');
  const result = await request('/api/auth/login', { method: 'POST', authenticated: false,
    body: { email: owner.email, password: 'synthetic-password' } });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(jwt.verify(body.token, secret).id, ownerId);
  assert.equal(Object.hasOwn(body.user, 'password'), false);
  assert.equal(Object.hasOwn(body.user, 'resetOtp'), false);
});

test('IB financial routes reject cross-user email and foreign withdrawal destinations before provider calls', async t => {
  t.mock.method(User, 'findById', async () => owner);
  t.mock.method(Account, 'findOne', async () => ({ _id: 'account-id', accountNo: 1234, user: otherId }));
  for (const path of ['/api/ib/update-commission-v2', '/api/ib/update-commission-v3', '/api/ib/withdrawalIBamount', '/api/ib/withdrawalIBamountV2']) {
    const result = await request(path, { method: 'POST', body: { email: 'victim@example.invalid', accountno: 1234, amount: 10 } });
    assert.equal(result.status, 403, path);
  }
  assert.equal((await request('/api/ib/withdrawalIBamountV2', { method: 'POST', body: { email: owner.email, accountno: 1234, amount: 10 } })).status, 403);
});

test('IB clients are server scoped and serialize only safe summaries with unavailable totals', async t => {
  t.mock.method(User, 'findById', async () => owner);
  t.mock.method(IB, 'findOne', async filter => {
    assert.deepEqual(filter, { email: owner.email, status: 'approved' }); return { _id: 'ib-owner' };
  });
  t.mock.method(User, 'find', filter => {
    assert.deepEqual(filter, { referredByIB: 'ib-owner' });
    return { select() { return this; }, populate(options) { assert.equal(options.select, 'accountNo user'); return this; },
      sort: async () => [{ _id: otherId, fullName: 'Referred Client', email: 'client@example.invalid',
        password: 'hidden-password', bankName: 'hidden-bank', idProof1: { image: 'hidden-document' },
        accounts: [{ accountNo: 1234, mt5Password: 'hidden-mt5' }] }] };
  });
  const result = await request('/api/ib/clients?email=victim@example.invalid');
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.clients[0].accounts, [{ accountNo: 1234 }]);
  assert.equal(body.clients[0].totalDeposit, null);
  assert.equal(body.clients[0].symbolLots, null);
  assert.equal(JSON.stringify(body).includes('hidden-'), false);
});
