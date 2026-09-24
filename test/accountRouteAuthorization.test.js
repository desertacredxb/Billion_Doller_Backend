const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Account = require('../models/account.model');

// Test the real route and access-control chain. External provider handlers are
// replaced before import, so no balance, payout, account or message can change.
const calls = [];
function stub(path, names) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: Object.fromEntries(
    names.map(name => [name, (req, res) => { calls.push(name); res.json({ handled: name }); }]),
  ) };
}
stub('../controllers/mt5Controller', ['registerUserWithMT5', 'getMT5User', 'changeMT5Password', 'updateUserMT5balance', 'getMT5DealsController', 'getMT5DealsTotalController', 'getMT5AccountController', 'getMT5SymbolListController']);
stub('../controllers/mt5WebhookController', ['receiveIbCommissionWebhook']);
stub('../controllers/moneyplant.controller', ['registerUserWithMoneyPlant', 'getAccountSummary', 'updatePassword', 'addBalance', 'getTransactions', 'getDeals']);
stub('../controllers/paymentAdmin.controller', ['reconcileOrders', 'listWithdrawals', 'getDepositsByAccount', 'getWithdrawalsByAccount', 'listAllDeposits', 'listAllWithdrawals']);
stub('../controllers/payout.controller', ['createPayoutRequest', 'approvePayoutReq', 'rejectPayoutRequest']);
stub('../controllers/paymentOrder.controller', ['createCregisCheckout']);
stub('../controllers/payments/digipay.controller', ['handleDigipayDeposit', 'handlePaymentCallback']);
stub('../controllers/payments/rameePay.controller', ['handleRameeDeposit', 'handleRameeCallback']);
stub('../controllers/payments/crypto.controller', ['handleCryptoDeposit', 'handleCryptoCallback']);
stub('../controllers/payments/trustpay24.controller', ['handleTrustpay24Deposit', 'handleTrustpay24Callback']);
stub('../controllers/payments/truepay9.controller', ['handleTruepay9Callback']);
stub('../controllers/payments/cregis.controller', ['handleCregisCallback']);
stub('../controllers/payments/manualPayment.controller', ['handleManualPaymentRequest']);
for (const path of ['../middleware/withdrawalLimiter', '../middleware/checkMargin']) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: (req, res, next) => next() };
}

const ownerId = '507f1f77bcf86cd799439011';
const otherId = '507f1f77bcf86cd799439012';
const adminId = '507f1f77bcf86cd799439013';
function query(value) {
  return { select() { return this; }, lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
let server, baseUrl;
before(async () => {
  process.env.JWT_SECRET = 'account-route-tests-only';
  const app = express();
  app.use(express.json());
  app.use('/api/mt5', require('../routes/mt5Routes'));
  app.use('/api/moneyplant', require('../routes/moneyplant.routes'));
  app.use('/api/payment', require('../routes/paymentRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(t => {
  calls.length = 0;
  process.env.BDFX_ADMIN_USER_IDS = adminId;
  t.mock.method(User, 'findById', id => query([ownerId, otherId, adminId].includes(String(id))
    ? { _id: id, email: `${id}@example.invalid`, fullName: 'Test account', isVerified: true } : null));
  t.mock.method(Account, 'findOne', filter => query(Number(filter.accountNo) === 12345
    ? { accountNo: 12345, user: ownerId } : null));
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
async function request(path, { method = 'GET', body, userId, claims = {} } = {}) {
  const token = userId ? jwt.sign({ id: userId, ...claims }, process.env.JWT_SECRET) : null;
  return fetch(baseUrl + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
}

test('anonymous callers cannot reach account, balance, payout or payment-list handlers', async () => {
  for (const [method, path, body] of [
    ['POST', '/api/mt5/register', { email: `${ownerId}@example.invalid` }],
    ['GET', '/api/mt5/user?login=12345'],
    ['POST', '/api/mt5/change_password', { login: 12345 }],
    ['POST', '/api/mt5/update_balance', { login: 12345 }],
    ['POST', '/api/moneyplant/add-balance', { accountno: 12345 }],
    ['POST', '/api/payment/request', { accountNo: 12345 }],
    ['POST', '/api/payment/approve/example'],
    ['GET', '/api/payment/withdrawals'],
    ['GET', '/api/payment/deposit/12345'],
  ]) assert.equal((await request(path, { method, body })).status, 401, path);
  assert.deepEqual(calls, []);
});

test('another signed-in user cannot read, deposit to, or mutate the owner account', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/mt5/user?login=12345'],
    ['POST', '/api/mt5/change_password', { login: 12345 }],
    ['POST', '/api/moneyplant/checkBalance', { accountno: 12345 }],
    ['POST', '/api/payment/deposit', { merchant_user_id: 12345 }],
    ['POST', '/api/payment/cregis/deposit', { accountNo: 12345 }],
    ['POST', '/api/payment/request_v2', { accountNo: 12345 }],
    ['GET', '/api/payment/withdrawal/12345'],
  ]) assert.equal((await request(path, { method, body, userId: otherId })).status, 403, path);
  assert.deepEqual(calls, []);
});

test('JWT role claims cannot authorize admin payment or balance functions', async () => {
  for (const [method, path] of [
    ['POST', '/api/mt5/update_balance'], ['POST', '/api/moneyplant/add-balance'],
    ['POST', '/api/payment/reconcile-orders'], ['POST', '/api/payment/approve/example'],
    ['POST', '/api/payment/reject/example'], ['GET', '/api/payment/deposit'],
    ['GET', '/api/payment/withdrawal'],
  ]) assert.equal((await request(path, { method, userId: ownerId,
    claims: { role: 'Admin', isAdmin: true }, body: method === 'POST' ? { accountNo: 12345 } : undefined })).status, 403, path);
  assert.deepEqual(calls, []);
});

test('authorized owner can read their account and submit their own request', async () => {
  assert.equal((await request('/api/mt5/account?login=12345', { userId: ownerId })).status, 200);
  assert.equal((await request('/api/payment/request', { method: 'POST', userId: ownerId, body: { accountNo: 12345 } })).status, 200);
  assert.deepEqual(calls, ['getMT5AccountController', 'createPayoutRequest']);
});

test('verified allowlisted admin can reach admin handlers; empty allowlist denies', async () => {
  assert.equal((await request('/api/payment/withdrawals', { userId: adminId })).status, 200);
  process.env.BDFX_ADMIN_USER_IDS = '';
  assert.equal((await request('/api/payment/withdrawals', { userId: adminId })).status, 403);
  assert.deepEqual(calls, ['listWithdrawals']);
});

test('missing and object-shaped account identifiers never reach provider handlers', async () => {
  for (const body of [{}, { accountNo: { $ne: null } }, { accountNo: '12345x' }]) {
    assert.equal((await request('/api/payment/request', { method: 'POST', userId: ownerId, body })).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('customer registration cannot request administrator trading accounts', async () => {
  for (const path of ['/api/mt5/register', '/api/moneyplant/register']) {
    assert.equal((await request(path, { method: 'POST', userId: ownerId,
      body: { email: `${ownerId}@example.invalid`, Utype: 'ADMIN' } })).status, 403);
    assert.equal((await request(path, { method: 'POST', userId: otherId,
      body: { email: `${ownerId}@example.invalid`, Utype: 'CLIENT' } })).status, 403);
  }
  assert.deepEqual(calls, []);
});
