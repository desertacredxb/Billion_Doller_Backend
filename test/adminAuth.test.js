const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createController } = require("../controllers/adminAuthController");

const now = new Date("2026-10-21T12:00:00Z");
const response = () => ({ code: 200, data: null, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; }, set() { return this; } });
function fixture() {
  process.env.JWT_SECRET = "test-admin-signing-key-not-a-production-secret";
  process.env.ADMIN_EMAILS = "admin@example.invalid";
  process.env.ADMIN_OTP_TO_SMTP_USER = "false";
  const state = { admin: null, sent: [] };
  const q = value => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
  function matches(filter) {
    return state.admin && Object.entries(filter).every(([key, wanted]) => {
      const actual = state.admin[key];
      if (wanted && typeof wanted === "object" && "$gt" in wanted) return actual > wanted.$gt;
      if (wanted && typeof wanted === "object" && "$lt" in wanted) return actual < wanted.$lt;
      return actual === wanted;
    });
  }
  const admins = {
    findOne: filter => q(matches(filter) ? structuredClone(state.admin) : null),
    findOneAndUpdate: (filter, update, options = {}) => {
      if (!matches(filter)) {
        if (!options.upsert) return q(null);
        state.admin = { _id: "111111111111111111111111", email: filter.email, authVersion: 0 };
      }
      Object.assign(state.admin, update.$set);
      for (const [key, value] of Object.entries(update.$inc || {})) state.admin[key] = (state.admin[key] || 0) + value;
      for (const key of Object.keys(update.$unset || {})) delete state.admin[key];
      return q(structuredClone(state.admin));
    },
  };
  const controller = createController({ admins, now: () => now, randomCode: () => "123456", send: async mail => { state.sent.push(mail); } });
  const call = async (method, body) => {
    const res = response(); await controller[method]({ body }, res, error => { throw error; }); return res;
  };
  return { state, call };
}

test("unconfigured email cannot enroll an administrator or send an email", async () => {
  const f = fixture();
  const res = await f.call("requestCode", { email: "other@example.invalid" });
  assert.equal(res.code, 200); assert.equal(f.state.admin, null); assert.equal(f.state.sent.length, 0);
  assert.equal((await f.call("verifyCode", { challengeId: res.data.challengeId, code: "123456" })).code, 400);
});

test("first enrollment requires email verification and a new strong password, with only an HMAC stored", async () => {
  const f = fixture();
  const request = await f.call("requestCode", { email: "ADMIN@example.invalid" });
  assert.equal(request.data.requiresPasswordSetup, true);
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.admin.otpHash.includes("123456"), false);
  const weak = await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456", newPassword: "short" });
  assert.equal(weak.code, 400);
  const verified = await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456", newPassword: "a-new-test-password-123" });
  assert.equal(verified.code, 200);
  assert.ok(await bcrypt.compare("a-new-test-password-123", f.state.admin.passwordHash));
  const claims = jwt.verify(verified.data.token, process.env.JWT_SECRET, { audience: "bdfx-admin", issuer: "bdfx-auth" });
  assert.equal(claims.kind, "admin"); assert.equal(claims.version, 1);
  assert.ok(claims.exp - claims.iat <= 7200);
  assert.equal(verified.data.user.passwordHash, undefined);
  assert.equal((await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456", newPassword: "a-new-test-password-123" })).code, 400);
});

test("subsequent admin sessions require both the password and a fresh email code", async () => {
  const f = fixture();
  f.state.admin = { _id: "111111111111111111111111", email: "admin@example.invalid", authVersion: 0, passwordHash: await bcrypt.hash("a-test-password-123", 4) };
  const wrong = await f.call("requestCode", { email: "admin@example.invalid", password: "wrong" });
  assert.equal(wrong.code, 401); assert.equal(f.state.sent.length, 0);
  const request = await f.call("requestCode", { email: "admin@example.invalid", password: "a-test-password-123" });
  assert.equal(request.data.requiresPasswordSetup, false);
  assert.equal((await f.call("verifyCode", { challengeId: request.data.challengeId, code: "654321" })).code, 400);
  assert.equal((await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456" })).code, 200);
});

test("five wrong codes exhaust a challenge, and expired codes cannot issue sessions", async () => {
  const f = fixture();
  const request = await f.call("requestCode", { email: "admin@example.invalid" });
  for (let i = 0; i < 5; i++) assert.equal((await f.call("verifyCode", { challengeId: request.data.challengeId, code: "654321" })).code, 400);
  assert.equal((await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456", newPassword: "a-test-password-123" })).code, 400);
  const second = await f.call("requestCode", { email: "admin@example.invalid" });
  f.state.admin.otpExpiresAt = new Date(now.getTime() - 1);
  assert.equal((await f.call("verifyCode", { challengeId: second.data.challengeId, code: "123456", newPassword: "a-test-password-123" })).code, 400);
});

test("recovery changes the password and invalidates existing administrator sessions", async () => {
  const f = fixture();
  f.state.admin = { _id: "111111111111111111111111", email: "admin@example.invalid", authVersion: 2, passwordHash: await bcrypt.hash("old-test-password-123", 4) };
  const request = await f.call("requestCode", { email: "admin@example.invalid", resetPassword: true });
  assert.equal(request.data.requiresPasswordSetup, true);
  const result = await f.call("verifyCode", { challengeId: request.data.challengeId, code: "123456", newPassword: "replacement-test-password-123" });
  assert.equal(result.code, 200); assert.equal(f.state.admin.authVersion, 3);
  assert.ok(await bcrypt.compare("replacement-test-password-123", f.state.admin.passwordHash));
});
