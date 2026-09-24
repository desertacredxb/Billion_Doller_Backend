const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Ticket = require('../models/Ticket');
const Message = require('../models/Reply');
const Broker = require('../models/Broker');
const Deal = require('../models/Deal.model');
const Account = require('../models/account.model');

// These tests exercise the actual HTTP middleware and controllers with only
// database and email boundaries replaced. No provider or client messages run.
const mailId = require.resolve('../utils/sendEmail');
require.cache[mailId] = {
  id: mailId, filename: mailId, loaded: true,
  exports: async () => { throw new Error('Unexpected outbound email'); },
};
const ticketRoutes = require('../routes/ticketRoutes');
const brokerRoutes = require('../routes/brokerRoutes');
const dealRoutes = require('../routes/dealRoutes');

const ownerId = '507f1f77bcf86cd799439011';
const victimId = '507f1f77bcf86cd799439012';
const adminId = '507f1f77bcf86cd799439013';
const ticketId = '607f1f77bcf86cd799439011';
const owner = { _id: ownerId, email: 'owner@example.com', isVerified: true };
const admin = { _id: adminId, email: 'admin@example.com', isVerified: true };
let baseUrl;
let server;
let ownerToken;
let adminToken;

function query(result) {
  return {
    select() { return this; }, populate() { return this; }, sort() { return this; },
    lean() { return this; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
}

before(async () => {
  process.env.JWT_SECRET = 'support-auth-test-signing-key';
  ownerToken = jwt.sign({ id: ownerId, role: 'Admin', isAdmin: true }, process.env.JWT_SECRET);
  adminToken = jwt.sign({ id: adminId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/tickets', ticketRoutes);
  app.use('/api/brokers', brokerRoutes);
  app.use('/api/deals', dealRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(t => {
  process.env.BDFX_ADMIN_USER_IDS = adminId;
  t.mock.method(User, 'findById', id => query(id === adminId ? admin : owner));
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function request(path, { method = 'GET', body, token = ownerToken } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
}

test('ticket, broker administration and stored deals deny anonymous requests before DB access', async t => {
  const ticketLookup = t.mock.method(Ticket, 'findById', () => { throw new Error('Unexpected ticket lookup'); });
  const dealLookup = t.mock.method(Deal, 'findOne', () => { throw new Error('Unexpected deal lookup'); });
  for (const [path, method] of [
    ['/api/tickets/admin', 'GET'], ['/api/tickets/owner@example.com', 'GET'],
    ['/api/tickets/owner@example.com', 'POST'], [`/api/tickets/one/${ticketId}`, 'GET'],
    [`/api/tickets/${ticketId}/messages`, 'GET'], [`/api/tickets/${ticketId}/messages`, 'POST'],
    [`/api/tickets/${ticketId}/status`, 'PUT'], [`/api/tickets/${ticketId}`, 'DELETE'],
    ['/api/brokers', 'GET'], [`/api/brokers/${ticketId}/mark`, 'PATCH'],
    ['/api/deals', 'GET'], ['/api/deals/12345', 'GET'],
  ]) {
    assert.equal((await request(path, { method, token: null })).status, 401, `${method} ${path}`);
  }
  assert.equal(ticketLookup.mock.callCount(), 0);
  assert.equal(dealLookup.mock.callCount(), 0);
});

test('ordinary user cannot list or mutate admin resources even with a forged role claim', async t => {
  const listTickets = t.mock.method(Ticket, 'find', () => { throw new Error('Unexpected list'); });
  const statusWrite = t.mock.method(Ticket, 'findByIdAndUpdate', () => { throw new Error('Unexpected write'); });
  const removeMessages = t.mock.method(Message, 'deleteMany', () => { throw new Error('Unexpected delete'); });
  const listBrokers = t.mock.method(Broker, 'find', () => { throw new Error('Unexpected broker list'); });
  for (const [path, method] of [
    ['/api/tickets/admin', 'GET'], [`/api/tickets/${ticketId}/status`, 'PUT'],
    [`/api/tickets/${ticketId}`, 'DELETE'], ['/api/brokers', 'GET'],
    [`/api/brokers/${ticketId}/mark`, 'PATCH'],
  ]) assert.equal((await request(path, { method, body: method === 'PUT' ? { status: 'Closed' } : undefined })).status, 403);
  for (const mock of [listTickets, statusWrite, removeMessages, listBrokers]) assert.equal(mock.mock.callCount(), 0);
});

test('ticket create and email lists reject another user email before user lookup', async t => {
  const lookup = t.mock.method(User, 'findOne', () => { throw new Error('Unexpected owner lookup'); });
  assert.equal((await request('/api/tickets/victim@example.com')).status, 403);
  assert.equal((await request('/api/tickets/victim@example.com', {
    method: 'POST', body: { subject: 'Spoof', description: 'Spoof', user: victimId },
  })).status, 403);
  assert.equal(lookup.mock.callCount(), 0);
});

test('cross-user ticket reads and messages cannot expose data or update read counters', async t => {
  const foreignTicket = { _id: ticketId, user: { _id: victimId }, save: async () => { throw new Error('Unexpected save'); } };
  t.mock.method(Ticket, 'findById', () => query(foreignTicket));
  const read = t.mock.method(Message, 'find', () => { throw new Error('Unexpected message read'); });
  const markRead = t.mock.method(Message, 'updateMany', () => { throw new Error('Unexpected read state write'); });
  const write = t.mock.method(Message, 'create', () => { throw new Error('Unexpected message write'); });
  assert.equal((await request(`/api/tickets/one/${ticketId}?viewer=Admin`)).status, 403);
  assert.equal((await request(`/api/tickets/${ticketId}/messages`)).status, 403);
  assert.equal((await request(`/api/tickets/${ticketId}/messages`, {
    method: 'POST', body: { senderType: 'Admin', message: 'Spoofed reply' },
  })).status, 403);
  for (const mock of [read, markRead, write]) assert.equal(mock.mock.callCount(), 0);
});

test('owner cannot spoof the sender role or admin unread counter through a message body', async t => {
  const ticket = { _id: ticketId, user: ownerId, unreadByUser: 2, unreadByAdmin: 4, save: async () => {} };
  t.mock.method(Ticket, 'findById', () => query(ticket));
  let savedMessage;
  t.mock.method(Message, 'create', async value => { savedMessage = value; return value; });
  const response = await request(`/api/tickets/${ticketId}/messages`, {
    method: 'POST', body: { senderType: 'Admin', message: 'Owner reply', readByAdmin: true },
  });
  assert.equal(response.status, 201);
  assert.equal(savedMessage.senderType, 'User');
  assert.equal(savedMessage.readByAdmin, false);
  assert.equal(savedMessage.readByUser, true);
  assert.equal(ticket.unreadByUser, 2);
  assert.equal(ticket.unreadByAdmin, 5);
});

test('viewer=Admin cannot mark owner messages as read by administrators', async t => {
  const ticket = { _id: ticketId, user: { _id: ownerId }, unreadByAdmin: 4, save: async () => {} };
  t.mock.method(Ticket, 'findById', () => query(ticket));
  t.mock.method(Message, 'updateMany', async (filter, changes) => {
    assert.deepEqual(filter, { ticket: ticketId, senderType: 'Admin', readByUser: false });
    assert.deepEqual(changes, { $set: { readByUser: true } });
  });
  t.mock.method(Message, 'countDocuments', async filter => {
    assert.equal(filter.senderType, 'Admin');
    assert.equal(filter.readByUser, false);
    return 0;
  });
  t.mock.method(Message, 'find', () => query([]));
  assert.equal((await request(`/api/tickets/one/${ticketId}?viewer=Admin`)).status, 200);
  assert.equal(ticket.unreadByAdmin, 4);
});

test('verified allowlisted administrator can read another ticket and writes as Admin', async t => {
  const ticket = { _id: ticketId, user: victimId, unreadByUser: 1, save: async () => {} };
  t.mock.method(Ticket, 'findById', () => query(ticket));
  t.mock.method(Message, 'find', () => query([{ senderType: 'User', message: 'Help' }]));
  t.mock.method(Message, 'create', async value => value);
  const read = await request(`/api/tickets/${ticketId}/messages`, { token: adminToken });
  assert.equal(read.status, 200);
  const write = await request(`/api/tickets/${ticketId}/messages`, {
    method: 'POST', token: adminToken, body: { senderType: 'User', message: 'Admin response' },
  });
  assert.equal(write.status, 201);
  assert.equal((await write.json()).senderType, 'Admin');
  assert.equal(ticket.unreadByUser, 2);
});

test('broker email OTP entry points remain public without performing outbound calls', async () => {
  assert.equal((await request('/api/brokers/request-otp', { method: 'POST', body: {}, token: null })).status, 400);
  assert.equal((await request('/api/brokers/verify', { method: 'POST', body: {}, token: null })).status, 400);
});

test('deal list requires a user account and rejects malformed identifiers before deal queries', async t => {
  const aggregate = t.mock.method(Deal, 'aggregate', () => { throw new Error('Unexpected aggregate'); });
  for (const path of [
    '/api/deals', '/api/deals?login=', '/api/deals?login=abc', '/api/deals?login=0',
    '/api/deals?login=9007199254740992', '/api/deals?login=123&login=456',
    '/api/deals?login=123&page=1&page=2', '/api/deals?login=123&from=2025-03-01&to=2025-01-01',
  ]) assert.equal((await request(path)).status, 400, path);
  assert.equal(aggregate.mock.callCount(), 0);
});

test('cross-user account deal list is denied before any deals are read', async t => {
  t.mock.method(Account, 'findOne', filter => {
    assert.deepEqual(filter, { accountNo: 654321, user: ownerId });
    return query(null);
  });
  const aggregate = t.mock.method(Deal, 'aggregate', () => { throw new Error('Unexpected aggregate'); });
  assert.equal((await request('/api/deals?login=654321')).status, 403);
  assert.equal(aggregate.mock.callCount(), 0);
});

test('own account deal list is constrained to the verified MT5 account mapping', async t => {
  t.mock.method(Account, 'findOne', filter => {
    assert.deepEqual(filter, { accountNo: 123456, user: ownerId });
    return query({ _id: 'account-owned' });
  });
  t.mock.method(Deal, 'aggregate', async pipeline => {
    assert.deepEqual(pipeline[1], { $match: { login: '123456' } });
    return [{ data: [{ login: '123456', order: '55' }], totalCount: [{ count: 1 }] }];
  });
  const response = await request('/api/deals?login=123456');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].login, '123456');
});

test('deal ticket detail rejects another account and accepts its verified owner', async t => {
  t.mock.method(Deal, 'findOne', filter => {
    assert.deepEqual(filter, { order: '777' });
    return query({ order: '777', login: '654321', profit: '99' });
  });
  let owned = false;
  t.mock.method(Account, 'findOne', filter => {
    assert.deepEqual(filter, { accountNo: 654321, user: ownerId });
    return query(owned ? { _id: 'owned-account' } : null);
  });
  const denied = await request('/api/deals/777');
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).data, undefined);
  owned = true;
  assert.equal((await request('/api/deals/777')).status, 200);
});

test('invalid ticket and deal IDs are rejected before model lookups', async t => {
  const tickets = t.mock.method(Ticket, 'findById', () => { throw new Error('Unexpected ticket lookup'); });
  const deals = t.mock.method(Deal, 'findOne', () => { throw new Error('Unexpected deal lookup'); });
  assert.equal((await request('/api/tickets/one/not-an-id')).status, 400);
  assert.equal((await request('/api/deals/not-an-order')).status, 400);
  assert.equal(tickets.mock.callCount(), 0);
  assert.equal(deals.mock.callCount(), 0);
});
