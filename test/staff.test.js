const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccessControl } = require("../middleware/accessControl");
const { createController, validateManager } = require("../controllers/staffController");
const { PERMISSIONS } = require("../services/adminPolicy");
const ownerId = "111111111111111111111111", managerId = "222222222222222222222222";
const response = () => ({ code: 200, status(value) { this.code = value; return this; }, set() { return this; }, json(value) { this.data = value; return this; } });

function managerRequest(path, overrides = {}) {
  return { method: "PATCH", originalUrl: path, user: { kind: "admin", email: "manager@example.invalid", sub: managerId, version: 2, iss: "bdfx-auth", aud: "bdfx-admin", role: "owner", permissions: PERMISSIONS }, ...overrides };
}
function accessFor(admin) { return createAccessControl({ admins: { findOne: async query => query.authVersion === 2 ? admin : null } }); }
const manager = () => ({ _id: managerId, email: "manager@example.invalid", role: "manager", enabled: true, invitedBy: ownerId, permissions: ["support"], authVersion: 2 });

test("manager permissions come from the database and cannot be expanded with JWT role or permission claims", async () => {
  process.env.ADMIN_EMAILS = "owner@example.invalid";
  const req = managerRequest("/api/tickets/one/333333333333333333333333");
  let allowed = false;
  await accessFor(manager()).principal(req, response(), () => { allowed = true; });
  assert.equal(allowed, true); assert.equal(req.principal.adminRole, "manager");
  assert.deepEqual(req.principal.permissions, ["support"]);
  for (const path of ["/api/payment/approve/test", "/api/auth/users", "/api/ib", "/api/blogs", "/api/staff", "/api/operations/audit"]) {
    const res = response();
    await accessFor(manager()).principal(managerRequest(path), res, () => assert.fail(`manager reached ${path}`));
    assert.equal(res.code, 403, path);
  }
});

test("disabling a manager or changing the session version revokes existing tokens immediately", async () => {
  for (const admin of [{ ...manager(), enabled: false }, { ...manager(), invitedBy: undefined }, { ...manager(), role: "owner" }]) {
    const res = response(); await accessFor(admin).principal(managerRequest("/api/auth/admin/session"), res, () => assert.fail("revoked manager accepted"));
    assert.equal(res.code, 401);
  }
  const res = response(); await accessFor(manager()).principal(managerRequest("/api/auth/admin/session", { user: { ...managerRequest("").user, version: 1 } }), res, () => assert.fail("stale manager session accepted"));
  assert.equal(res.code, 401);
});

test("only an owner can manage staff, and new manager input cannot assign owner status or unknown permissions", () => {
  const res = response(); accessFor(manager()).owner({ principal: { isAdmin: true, adminRole: "manager" } }, res, () => assert.fail("manager granted staff access"));
  assert.equal(res.code, 403);
  process.env.ADMIN_EMAILS = "owner@example.invalid";
  const value = validateManager({ fullName: "Support Manager", email: "MANAGER@example.invalid", permissions: ["support", "support"], role: "owner", passwordHash: "injected" });
  assert.deepEqual(value.permissions, ["support"]); assert.equal(value.role, undefined); assert.equal(value.passwordHash, undefined);
  for (const patch of [{ email: "owner@example.invalid" }, { permissions: ["owner"] }, { permissions: [] }, { email: { $ne: null } }]) assert.throws(() => validateManager({ fullName: "Manager", email: "manager@example.invalid", permissions: ["support"], ...patch }));
});

test("manager creation records the inviting owner and returns no password or code", async () => {
  let saved;
  const controller = createController({ admins: { exists: async () => null, create: async value => { saved = { _id: managerId, ...value }; return saved; } } });
  const req = { principal: { id: ownerId }, body: { fullName: "Support Manager", email: "manager@example.invalid", permissions: ["support"] } }, res = response();
  await controller.create(req, res, error => { throw error; });
  assert.equal(res.code, 201); assert.equal(saved.invitedBy, ownerId); assert.equal(saved.role, "manager");
  assert.equal(res.data.data.setupComplete, false); assert.equal(res.data.data.passwordHash, undefined);
  assert.equal(req.auditEvent, "staff.created"); assert.equal(req.auditTargetId, managerId);
});

test("changing manager access clears pending challenges and invalidates existing sessions", async () => {
  let update;
  const controller = createController({ admins: { findById: () => ({ lean: async () => manager() }), findOneAndUpdate: (_filter, value) => { update = value; return { select: async () => ({ ...manager(), enabled: false }) }; } } });
  const res = response(); await controller.update({ principal: { id: ownerId }, params: { id: managerId }, body: { enabled: false } }, res, error => { throw error; });
  assert.equal(res.code, 200); assert.equal(update.$inc.authVersion, 1); assert.equal(update.$unset.otpHash, 1);
  assert.equal(res.data.data.enabled, false);
});

test("configured bootstrap managers get separate identities without passwords or emails, and restarts preserve disabled status", async () => {
  const { createBootstrap } = require("../services/adminBootstrap.service");
  const state = { row: null, entries: [] };
  const run = createBootstrap({ owners: () => ["owner@example.invalid"], emails: () => "manager@example.invalid, owner@example.invalid",
    admins: { findOneAndUpdate: async () => ({ _id: ownerId }), updateOne: async (_filter, update) => {
      if (state.row) return { matchedCount: 1 };
      state.row = { _id: managerId, ...update.$setOnInsert }; return { upsertedId: managerId };
    } }, logs: { create: async entry => state.entries.push(entry) } });
  await run();
  assert.equal(state.row.email, "manager@example.invalid");
  assert.equal(state.row.invitedBy, ownerId); assert.deepEqual(state.row.permissions, PERMISSIONS);
  assert.equal(state.row.passwordHash, undefined); assert.equal(state.entries.length, 1);
  state.row.enabled = false; await run();
  assert.equal(state.row.enabled, false); assert.equal(state.entries.length, 1);
});
