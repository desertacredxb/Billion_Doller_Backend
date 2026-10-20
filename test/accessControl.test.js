const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createAccessControl } = require("../middleware/accessControl");
const auth = require("../middleware/authMiddleware");

const ownerId = "111111111111111111111111";
const otherId = "222222222222222222222222";
const response = () => ({ code: 200, data: null, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; }, set() { return this; } });
const query = value => ({ select: async () => value });
const makeAccess = () => createAccessControl({
  users: { findById: id => query(id === ownerId ? { _id: ownerId, email: "client@example.invalid", isVerified: true } : null) },
  accounts: { findOne: filter => query(filter.user === ownerId && filter.accountNo === 1001 ? { _id: "account" } : null) },
  tickets: { findOne: filter => query(filter._id === ownerId && filter.user === ownerId ? { _id: ownerId } : null) },
  deals: { findOne: () => query({ login: 9001 }) },
  admins: { findOne: filter => Promise.resolve(filter.authVersion === 2 ? { _id: otherId, email: "admin@example.invalid" } : null) },
});

test("both existing JWT subject formats resolve the verified account; forged role claims do not grant admin", async () => {
  for (const token of [{ id: ownerId }, { userId: ownerId }, { id: ownerId, role: "admin", isAdmin: true }]) {
    const req = { user: token }; const res = response(); let next = false;
    await makeAccess().principal(req, res, () => { next = true; });
    assert.equal(next, true); assert.equal(req.principal.isAdmin, false);
    makeAccess().admin(req, res, () => assert.fail("client gained admin permission"));
    assert.equal(res.code, 403);
  }
});

test("unverified, deleted, missing and stale-admin principals are denied", async () => {
  process.env.ADMIN_EMAILS = "admin@example.invalid";
  for (const user of [undefined, {}, { id: otherId }, { kind: "admin", email: "admin@example.invalid", iss: "bdfx-auth", aud: "bdfx-admin", sub: otherId, version: 1 }]) {
    const res = response(); await makeAccess().principal({ user }, res, () => assert.fail("invalid principal accepted"));
    assert.equal(res.code, 401);
  }
});

test("admin access requires a signed administrator namespace and current server-side session version", async () => {
  process.env.ADMIN_EMAILS = "admin@example.invalid";
  const req = { user: { kind: "admin", email: "admin@example.invalid", iss: "bdfx-auth", aud: "bdfx-admin", sub: otherId, version: 2 } };
  await makeAccess().principal(req, response(), () => {});
  assert.equal(req.principal.isAdmin, true);
});

test("profile owner checks reject other emails and object/operator payloads", () => {
  const principal = { id: ownerId, email: "client@example.invalid", isAdmin: false };
  for (const email of ["other@example.invalid", { $ne: null }, undefined]) {
    const res = response(); makeAccess().emailOwner()({ principal, params: { email } }, res, () => assert.fail("another profile was accessible"));
    assert.equal(res.code, 403);
  }
  let passed = false;
  makeAccess().emailOwner()({ principal, params: { email: "CLIENT@example.invalid" } }, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test("trading account ownership blocks foreign account reads, password changes and deposit/withdrawal requests", async () => {
  const principal = { id: ownerId, isAdmin: false };
  for (const value of [9001, { $ne: null }, "1001.5", "1e3", "Infinity"]) {
    const res = response(); await makeAccess().accountOwner()({ principal, body: { accountNo: value } }, res, () => assert.fail("foreign or malformed account accepted"));
    assert.ok([400, 403].includes(res.code));
  }
  let passed = false;
  await makeAccess().accountOwner()({ principal, body: { accountNo: "1001" } }, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test("ticket and single-deal ownership cannot be bypassed using a supplied viewer role", async () => {
  const res = response();
  await makeAccess().ticketOwner({ principal: { id: otherId }, params: { ticketId: ownerId }, query: { viewer: "Admin" } }, res, () => assert.fail("foreign ticket accepted"));
  assert.equal(res.code, 404);
  const dealRes = response();
  await makeAccess().dealOwner({ principal: { id: ownerId }, params: { order: "1" } }, dealRes, () => assert.fail("foreign deal accepted"));
  assert.equal(dealRes.code, 403);
});

test("expired, unsigned and fake legacy administrator tokens are rejected before data access", () => {
  process.env.JWT_SECRET = "local-security-test-key";
  const expired = jwt.sign({ id: ownerId }, process.env.JWT_SECRET, { expiresIn: -1 });
  for (const token of ["admin-token", "invalid", expired, jwt.sign({ id: ownerId }, "other-key")]) {
    const res = response(); auth({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail("invalid token accepted"));
    assert.equal(res.code, 401);
  }
});

test("all private production router entry points require a bearer token before any controller or upload", async t => {
  const app = express(); app.use(express.json());
  for (const [prefix, file] of [["auth", "authRoutes"], ["payment", "paymentRoutes"], ["mt5", "mt5Routes"], ["moneyplant", "moneyplant.routes"], ["ib", "IBRoutes"], ["tickets", "ticketRoutes"], ["brokers", "brokerRoutes"], ["deals", "dealRoutes"], ["enquiries", "enquiryRoutes"]]) app.use(`/api/${prefix}`, require(`../routes/${file}`));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    ["GET", "auth/users"], ["GET", "auth/user/client@example.invalid"], ["PUT", "auth/profile-image/client@example.invalid"],
    ["PUT", "auth/documents/client@example.invalid"], ["PUT", "auth/bank/client@example.invalid"], ["PATCH", "auth/bank-approve/client@example.invalid"],
    ["PUT", "auth/change-password/client@example.invalid"], ["PUT", "auth/client@example.invalid/verify-kyc"], ["DELETE", "auth/delete/client@example.invalid"],
    ["GET", "mt5/user?login=1001"], ["POST", "mt5/register"], ["POST", "mt5/change_password"], ["POST", "mt5/update_balance"],
    ["POST", "moneyplant/add-balance"], ["GET", "payment/deposit/1001"], ["GET", "payment/withdrawal/1001"], ["POST", "payment/request"],
    ["POST", "payment/approve/test"], ["POST", "payment/cregis/deposit"], ["GET", "ib"], ["GET", "ib/connections"], ["PUT", "ib/client@example.invalid/approve"],
    ["POST", "ib/withdrawalIBamountV2"], ["POST", "ib/update-commission"], ["GET", "tickets/admin"], ["GET", "tickets/one/test"], ["POST", "tickets/test/messages"],
    ["GET", "brokers"], ["PATCH", "brokers/test/mark"], ["GET", "deals?login=1001"],
    ["GET", "enquiries"], ["PATCH", "enquiries/111111111111111111111111"],
  ];
  for (const [method, path] of cases) {
    const result = await fetch(`${base}/api/${path}`, { method });
    assert.equal(result.status, 401, `${method} ${path}`);
  }
});
