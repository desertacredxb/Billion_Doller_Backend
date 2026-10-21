const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("node:crypto");
const auth = require("../middleware/authMiddleware");
const { createAccessControl } = require("../middleware/accessControl");
const { createController: ticketController } = require("../controllers/ticketController");
const { createController: operationsController } = require("../controllers/operationsController");

test("signed-in client onboarding and support journey preserves ownership, retry safety and manager boundaries", async () => {
  // Complete HTTP/middleware/controller flow with synthetic local stores only.
  // No production client, OTP, email, trading account or payment is created.
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.ADMIN_OWNER_EMAILS = "owner@example.invalid";
  const client = { _id: "111111111111111111111111", email: "client@example.invalid", isVerified: true, isKycVerified: true, kycProvider: "veriff" };
  const other = { _id: "222222222222222222222222", email: "other@example.invalid", isVerified: true };
  const manager = { _id: "444444444444444444444444", email: "manager@example.invalid", role: "manager", enabled: true, invitedBy: "owner", authVersion: 1, permissions: ["support"] };
  const owner = { _id: "555555555555555555555555", email: "owner@example.invalid", enabled: true, authVersion: 1 };
  const tickets = [], messages = [], successfulOrders = [];
  let notified = 0;
  const same = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => structuredClone(value), then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
  const users = { findById: id => query([client, other].find(row => row._id === id) || null), findOne: filter => query([client, other].find(row => same(row, filter)) || null) };
  const ticketStore = {
    findOne: filter => query(tickets.find(row => same(row, filter)) || null), findById: id => query(tickets.find(row => row._id === id) || null),
    countDocuments: async filter => tickets.filter(row => row.user === filter.user && filter.status.$in.includes(row.status)).length,
    create: async value => { const row = { _id: "333333333333333333333333", status: "Open", unreadByAdmin: 0, unreadByUser: 0, ...value }; tickets.push(row); return row; },
    updateOne: async (filter, change) => { const row = tickets.find(item => same(item, filter)); if (row) { Object.assign(row, change.$set); for (const [key, amount] of Object.entries(change.$inc || {})) row[key] += amount; } },
    findByIdAndUpdate: async (id, change) => { const row = tickets.find(item => item._id === id); if (row) Object.assign(row, change.$set); return row; },
  };
  const messageStore = { findOne: filter => query(messages.find(row => same(row, filter)) || null),
    create: async value => { const row = { _id: `message-${messages.length + 1}`, ...value }; messages.push(row); return row; },
    find: filter => query(messages.filter(row => same(row, filter))),
    updateMany: async (filter, change) => { for (const row of messages.filter(item => same(item, filter))) Object.assign(row, change.$set); },
    countDocuments: async filter => messages.filter(row => same(row, filter)).length };
  const accounts = { find: filter => query(filter.user === client._id ? [{ _id: "own-account", accountNo: 1001 }] : []) };
  const admins = { findOne: async filter => [owner, manager].find(row => row._id === filter._id && row.email === filter.email && row.authVersion === filter.authVersion) || null };
  const access = createAccessControl({ users, tickets: ticketStore, accounts, admins });
  const support = ticketController({ users, tickets: ticketStore, messages: messageStore, notify: () => { notified++; } });
  const operations = operationsController({ users, accounts, orders: { exists: async filter => successfulOrders.find(order => order.status === filter.status && filter.$or[1].accountNo.$in.includes(order.accountNo)) || null }, ibs: { findOne: () => query(null) } });
  const app = express(); app.use(express.json()); app.use("/api", auth, access.principal);
  app.get("/api/operations/onboarding", operations.onboarding);
  app.post("/api/tickets/:email", access.emailOwner(), support.createTicket);
  app.get("/api/tickets/one/:ticketId", access.ticketOwner, support.getTicketWithMessages);
  app.post("/api/tickets/:ticketId/messages", access.ticketOwner, support.addMessageToTicket);
  app.put("/api/tickets/:ticketId/status", access.admin, support.updateTicketStatus);
  app.get("/api/staff", access.owner, (_req, res) => res.json({ success: true }));
  app.get("/api/payment/safe-probe", access.admin, (_req, res) => res.json({ success: true }));
  const token = value => jwt.sign(value, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 300 });
  const clientToken = token({ id: client._id }), otherToken = token({ id: other._id });
  const adminToken = row => token({ kind: "admin", sub: row._id, email: row.email, version: 1, iss: "bdfx-auth", aud: "bdfx-admin" });
  const managerToken = adminToken(manager), ownerToken = adminToken(owner);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const request = async (path, bearer, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const before = await request("operations/onboarding", clientToken);
    assert.equal(before.status, 200); assert.equal(before.data.identityVerified, true); assert.equal(before.data.firstDepositCompleted, false);
    successfulOrders.push({ accountNo: "1001", status: "SUCCESS" });
    assert.equal((await request("operations/onboarding", clientToken)).data.firstDepositCompleted, true);
    assert.equal((await request("operations/onboarding", otherToken)).data.firstDepositCompleted, false);
    const body = { category: "MT5 Support", subject: "Practice connection question", description: "Please explain the platform connection status.", requestId: "11111111-1111-4111-8111-111111111111" };
    assert.equal((await request(`tickets/${other.email}`, clientToken, "POST", body)).status, 403);
    const created = await request(`tickets/${client.email}`, clientToken, "POST", body);
    const retried = await request(`tickets/${client.email}`, clientToken, "POST", body);
    assert.equal(created.status, 201); assert.equal(created.data._id, retried.data._id); assert.equal(tickets.length, 1); assert.equal(notified, 1);
    assert.equal((await request(`tickets/one/${created.data._id}?viewer=Admin`, otherToken)).status, 404);
    const message = { message: "Here is my follow-up question.", senderType: "Admin", requestId: "22222222-2222-4222-8222-222222222222" };
    await request(`tickets/${created.data._id}/messages`, clientToken, "POST", message);
    await request(`tickets/${created.data._id}/messages`, clientToken, "POST", message);
    assert.equal(messages.length, 1); assert.equal(messages[0].senderType, "User"); assert.equal(tickets[0].unreadByAdmin, 1);
    assert.equal((await request(`tickets/one/${created.data._id}`, managerToken)).status, 200);
    assert.equal(tickets[0].unreadByAdmin, 0);
    await request(`tickets/${created.data._id}/messages`, managerToken, "POST", { message: "A synthetic support reply.", senderType: "User", requestId: "33333333-3333-4333-8333-333333333333" });
    assert.equal(messages[1].senderType, "Admin");
    assert.equal((await request("staff", managerToken)).status, 403);
    assert.equal((await request("payment/safe-probe", managerToken)).status, 403);
    assert.equal((await request("staff", ownerToken)).status, 200);
    assert.equal((await request("payment/safe-probe", ownerToken)).status, 200);
    await request(`tickets/${created.data._id}/status`, managerToken, "PUT", { status: "Closed" });
    assert.equal((await request(`tickets/${created.data._id}/messages`, clientToken, "POST", { message: "A new reply after closure.", requestId: "44444444-4444-4444-8444-444444444444" })).status, 409);
    manager.enabled = false;
    assert.equal((await request(`tickets/one/${created.data._id}`, managerToken)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
