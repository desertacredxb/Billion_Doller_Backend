const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createController } = require("../controllers/registrationController");
const { checkRegistrationStorage } = require("../services/registrationReadiness.service");
const { createSender, isConfigured } = require("../utils/sendWhatsAppOTP");
const User = require("../models/User");
const identity = require("../utils/registrationIdentity");
const response = () => ({ code: 200, data: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
const get = (o, path) => path.split(".").reduce((o, k) => o?.[k], o);
function set(o, path, value) { const keys = path.split("."); const last = keys.pop(); for (const key of keys) o = o[key] ||= {}; o[last] = value; }
function unset(o, path) { const keys = path.split("."); const last = keys.pop(); for (const key of keys) { o = o?.[key]; if (!o) return; } delete o[last]; }
function matches(o, query) {
  return Object.entries(query).every(([key, wanted]) => {
    if (key === "$or") return wanted.some(q => matches(o, q));
    if (key === "$and") return wanted.every(q => matches(o, q));
    const value = get(o, key);
    if (wanted instanceof RegExp) return typeof value === "string" && wanted.test(value);
    if (wanted === null) return value == null;
    if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) return Object.entries(wanted).every(([operator, operand]) => {
      if (operator === "$gt") return value > operand;
      if (operator === "$lt") return value < operand;
      if (operator === "$lte") return value <= operand;
      if (operator === "$exists") return (value !== undefined) === operand;
      if (operator === "$ne") return operand === null ? value != null : value !== operand;
      throw Error(`Unsupported fixture operator ${operator}`);
    });
    return value instanceof Date && wanted instanceof Date ? +value === +wanted : value === wanted;
  });
}
function fixture({ required = true, configured = true, sendFailure = false, emailFailure = false } = {}) {
  let time = new Date("2026-10-21T06:00:00Z"), nextId = 1, nextCode = 100001, nextToken = 1, nextNonce = 1;
  const state = { rows: [], mails: [], phones: [], notified: [], indexes: true };
  const q = value => ({ select() { return q(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  class Users {
    constructor(data) { Object.assign(this, structuredClone(data), { _id: String(nextId++).padStart(24, "0"), createdAt: new Date(time) }); }
    async save() {
      if (state.rows.some(row => row.email === this.email || row.phone === this.phone ||
        (this.registrationEmailKey && row.registrationEmailKey === this.registrationEmailKey) ||
        (this.registrationPhoneKey && row.registrationPhoneKey === this.registrationPhoneKey))) throw Object.assign(Error("Duplicate"), { code: 11000 });
      state.rows.push(structuredClone(this));
    }
    static findOne(filter) { return q(structuredClone(state.rows.find(row => matches(row, filter)) || null)); }
    static findOneAndUpdate(filter, update) {
      const row = state.rows.find(row => matches(row, filter));
      if (!row) return q(null);
      for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
      for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, (get(row, key) || 0) + value);
      for (const key of Object.keys(update.$unset || {})) unset(row, key);
      return q(structuredClone(row));
    }
    static updateOne(filter, update) { return Users.findOneAndUpdate(filter, update); }
  }
  const env = { JWT_SECRET: "synthetic-registration-signing-key-not-live", REGISTRATION_WHATSAPP_OTP_ENABLED: String(required) };
  const controller = createController({ users: Users, brokers: { findOne: async () => null }, env,
    ensureStorage: async () => { if (!state.indexes) throw Error("No indexes"); }, automaticKyc: () => true,
    phoneConfigured: () => configured, now: () => new Date(time), randomCode: () => String(nextCode++),
    randomToken: () => String(nextToken++).padStart(64, "a"), randomId: () => `challenge-${nextNonce++}`,
    send: async mail => { state.mails.push(mail); if (emailFailure) throw Error("private SMTP failure"); },
    sendPhone: async (phone, code) => { state.phones.push({ phone, code }); if (sendFailure) throw Error("private provider token"); return { success: true }; },
    notify: async user => { state.notified.push(user._id); } });
  const call = async (method, body = {}) => { const res = response(); await controller[method]({ body }, res); return res; };
  const data = { fullName: "Synthetic Signup", email: " Person@Example.invalid ", phone: "+91 (98765) 43210", nationality: "India", residenceCountry: "India", state: "Delhi", city: "Delhi", password: "Synthetic#123", whatsappOtpConsent: true };
  const signup = (patch = {}) => call("register", { ...data, ...patch });
  const emailCode = index => state.mails[index || 0].html.match(/font-weight:bold">(\d{6})/)[1];
  return { state, call, data, signup, emailCode, advance: ms => { time = new Date(+time + ms); }, env };
}

test("canonical identity matching handles email case/whitespace and international phone formatting", () => {
  assert.equal(identity.normalizeEmail(" Name+tag@Example.COM "), "name+tag@example.com");
  assert.equal(identity.normalizePhone("0091 (98765) 43210"), "+919876543210");
  assert.equal(identity.normalizePhone("+91 09876543210"), "+919876543210");
  assert.ok(identity.emailPattern("Name+tag@example.com").test(" NAME+tag@EXAMPLE.COM "));
  assert.equal(identity.emailPattern("name+tag@example.com").test("nameXtag@example.com"), false);
  assert.ok(identity.phonePattern("+919876543210").test("0091 (98765) 43210"));
  assert.ok(identity.phonePattern("+919876543210").test("+91 (0) 98765 43210"));
  assert.ok(identity.legacyNationalPattern("+919876543210").test("098765 43210"));
  assert.equal(identity.normalizeEmail({ $ne: null }), null);
  assert.equal(identity.normalizePhone("+91javascript"), null);
});

test("only both channel proofs activate a new user; codes, phone and flags cannot be substituted", async () => {
  const f = fixture(), registration = await f.signup();
  assert.equal(registration.code, 200); assert.equal(registration.data.mobileRequired, true);
  const registrationToken = registration.data.registrationToken, row = f.state.rows[0];
  assert.equal(row.email, "person@example.invalid"); assert.equal(row.phone, "+919876543210");
  assert.equal(row.registration.emailHash.includes(f.emailCode()), false); assert.equal(row.registration.tokenHash.includes(registrationToken), false);
  assert.equal(f.state.phones.length, 0);
  assert.equal((await f.call("sendMobile", { registrationToken, phone: "+12025550123" })).code, 400);
  const email = await f.call("verifyOTP", { email: "PERSON@EXAMPLE.INVALID", otp: f.emailCode(), registrationToken, mobileRequired: false, isVerified: true });
  assert.equal(email.code, 200); assert.equal(email.data.mobileRequired, true); assert.equal(email.data.token, undefined);
  assert.equal(f.state.rows[0].isVerified, false); assert.equal(f.state.phones[0].phone, "+919876543210");
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: f.emailCode() })).code, 400);
  const results = await Promise.all([1, 2].map(() => f.call("verifyMobile", { registrationToken, otp: f.state.phones[0].code })));
  assert.deepEqual(results.map(r => r.code).sort(), [201, 400]);
  const complete = results.find(r => r.code === 201);
  assert.equal(jwt.verify(complete.data.token, f.env.JWT_SECRET).userId, row._id);
  assert.equal(f.state.rows[0].phoneVerificationChannel, "whatsapp"); assert.ok(f.state.rows[0].phoneVerifiedAt);
  assert.equal(f.state.rows[0].registration, undefined); assert.equal(f.state.notified.length, 1);
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: f.state.phones[0].code })).code, 400);
});

test("duplicate legacy email OR phone is rejected and concurrent new requests have one winner", async () => {
  for (const patch of [{ email: "legacy@example.invalid", phone: "+12025550123" }, { email: "different@example.invalid", phone: "+919876543210" }]) {
    const f = fixture(); f.state.rows.push({ _id: "old", email: " Legacy@Example.invalid ", phone: "0091 98765 43210", isVerified: true });
    assert.equal((await f.signup(patch)).code, 409); assert.equal(f.state.rows.length, 1); assert.equal(f.state.mails.length, 0);
  }
  for (const patch of [{ phone: "+12025550123" }, { email: "another@example.invalid", phone: "0091 98765 43210" }]) {
    const f = fixture(); const results = await Promise.all([f.signup(), f.signup(patch)]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409]); assert.equal(f.state.rows.length, 1); assert.equal(f.state.mails.length, 1);
  }
  const legacy = fixture(); legacy.state.rows.push({ _id: "old-local", email: "old@example.invalid", phone: "09876543210", isVerified: true });
  assert.equal((await legacy.signup()).code, 409);
});

test("per-user attempt caps persist across resends and concurrent requests", async () => {
  const f = fixture(), r = await f.signup(), registrationToken = r.data.registrationToken;
  for (let i = 0; i < 3; i++) assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: "999999", registrationToken })).code, 400);
  f.advance(60000); assert.equal((await f.call("resendEmail", { registrationToken })).code, 200);
  assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken })).code, 400);
  assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: "999999", registrationToken })).code, 400);
  assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(1), registrationToken })).code, 400);
  assert.equal(f.state.rows[0].registration.emailAttempts, 5); assert.equal(f.state.phones.length, 0);

  const g = fixture(), rr = await g.signup(), token = rr.data.registrationToken;
  await g.call("verifyOTP", { email: g.data.email, otp: g.emailCode(), registrationToken: token });
  const failures = await Promise.all(Array.from({ length: 10 }, () => g.call("verifyMobile", { registrationToken: token, otp: "999999" })));
  assert.ok(failures.every(r => r.code === 400)); assert.equal(g.state.rows[0].registration.phoneAttempts, 5);
  assert.equal((await g.call("verifyMobile", { registrationToken: token, otp: g.state.phones[0].code })).code, 400);
});

test("resend reserves atomically, invalidates earlier codes and never exceeds the send quota", async () => {
  const f = fixture(), r = await f.signup(), registrationToken = r.data.registrationToken;
  await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken });
  assert.equal((await f.call("sendMobile", { registrationToken })).code, 429);
  f.advance(60000);
  const results = await Promise.all([1, 2].map(() => f.call("sendMobile", { registrationToken })));
  assert.deepEqual(results.map(r => r.code).sort(), [200, 429]); assert.equal(f.state.phones.length, 2);
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: f.state.phones[0].code })).code, 400);
  f.advance(60000); assert.equal((await f.call("sendMobile", { registrationToken })).code, 200);
  f.advance(60000); assert.equal((await f.call("sendMobile", { registrationToken })).code, 429);
  assert.equal(f.state.phones.length, 3);
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: f.state.phones[2].code })).code, 201);
});

test("provider failure leaves the account unverified; valid delivered codes survive an ambiguous response", async () => {
  const f = fixture({ sendFailure: true }), r = await f.signup(), registrationToken = r.data.registrationToken;
  const email = await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken });
  assert.equal(email.data.phoneSent, false); assert.equal(email.data.token, undefined); assert.equal(f.state.rows[0].isVerified, false);
  assert.equal(JSON.stringify(email.data).includes("private provider"), false);
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: "999999" })).code, 400);
  assert.equal((await f.call("verifyMobile", { registrationToken, otp: f.state.phones[0].code })).code, 201);
});

test("expiry, token substitution and request injection cannot complete either channel", async () => {
  const f = fixture(), r = await f.signup(), registrationToken = r.data.registrationToken;
  assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken: "f".repeat(64) })).code, 400);
  assert.equal((await f.call("verifyMobile", { registrationToken: { $ne: null }, otp: "123456" })).code, 400);
  f.advance(300001); assert.equal((await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken })).code, 400);
  f.advance(600000); assert.equal((await f.call("resendEmail", { registrationToken })).code, 400);
  assert.equal(f.state.rows[0].isVerified, false); assert.equal(f.state.notified.length, 0);
});

test("no provider, missing consent, UAE eligibility, malformed inputs or missing indexes create an account", async () => {
  const missing = fixture({ configured: false }); assert.equal((await missing.signup()).code, 503);
  assert.equal((await missing.call("options")).data.registrationAvailable, false);
  const f = fixture();
  for (const patch of [{ whatsappOtpConsent: false }, { email: { $ne: null } }, { password: "weak" }, { phone: "invalid" }]) assert.equal((await f.signup(patch)).code, 400);
  for (const patch of [{ nationality: "United Arab Emirates" }, { residenceCountry: "UAE" }]) assert.equal((await f.signup(patch)).code, 403);
  f.state.indexes = false; assert.equal((await f.signup()).code, 503);
  assert.equal(f.state.rows.length, 0); assert.equal(f.state.mails.length, 0); assert.equal(f.state.phones.length, 0);
});

test("existing email-only mode and pre-release pending email challenges still work without retroactive phone checks", async () => {
  const f = fixture({ required: false }), r = await f.signup({ whatsappOtpConsent: false });
  assert.equal(r.data.mobileRequired, false);
  const done = await f.call("verifyOTP", { email: f.data.email, otp: f.emailCode(), registrationToken: r.data.registrationToken });
  assert.equal(done.code, 201); assert.equal(done.data.phoneVerified, false); assert.equal(f.state.phones.length, 0);
  const g = fixture(); g.state.rows.push({ _id: "legacy-user", fullName: "Legacy", email: "legacy@example.invalid", phone: "+12025550123", isVerified: false, otp: "123456", otpExpires: new Date("2026-10-21T06:04:00Z") });
  assert.equal((await g.call("verifyOTP", { email: "LEGACY@example.invalid", otp: "123456" })).code, 201);
  assert.equal(g.state.phones.length, 0);
});

test("registration secrets and identity keys are excluded from User JSON", () => {
  const user = new User({ fullName: "Synthetic", email: "synthetic@example.invalid", phone: "+12025550123", nationality: "India", state: "Delhi", city: "Delhi", password: "secret", registrationEmailKey: "key", registration: { tokenHash: "private", emailHash: "private" }, legacyOtpAttempts: 2 });
  const json = user.toJSON();
  for (const key of ["registration", "password", "registrationEmailKey", "legacyOtpAttempts"]) assert.equal(json[key], undefined);
});

test("connected storage creates partial unique identity indexes and extends only the existing unverified TTL", async () => {
  const indexes = [{ name: "createdAt_1", key: { createdAt: 1 }, partialFilterExpression: { isVerified: false }, expireAfterSeconds: 300 }];
  let commands = [];
  const users = { db: { readyState: 1, db: { command: async c => { commands.push(c); indexes[0].expireAfterSeconds = c.index.expireAfterSeconds; } } }, collection: { collectionName: "users", indexes: async () => structuredClone(indexes), createIndex: async (key, options) => { indexes.push({ key, ...options }); } } };
  await checkRegistrationStorage({ users }); await checkRegistrationStorage({ users });
  assert.equal(indexes.length, 3); assert.equal(commands.length, 1); assert.equal(commands[0].index.expireAfterSeconds, 900);
  assert.deepEqual(indexes[0].partialFilterExpression, { isVerified: false });
  users.db.readyState = 0; await assert.rejects(checkRegistrationStorage({ users }));
});

test("WhatsApp adapter requires explicit template config and hides provider payload/errors", async () => {
  let calls = [];
  const env = { TELEOBI_API_TOKEN: "synthetic-not-live", TELEOBO_NUMBER_ID: "synthetic-number", TELEOBI_OTP_TEMPLATE_ID: "synthetic-template" };
  const sender = createSender({ env, http: { post: async (...args) => { calls.push(args); return { status: 200, data: { success: true, private: "never-return" } }; } } });
  assert.equal(isConfigured({ ...env, TELEOBI_OTP_TEMPLATE_ID: "" }), false);
  assert.deepEqual(await sender("+12025550123", "123456"), { success: true });
  assert.equal(new URLSearchParams(calls[0][1]).get("phone_number"), "12025550123"); assert.equal(calls[0][2].maxRedirects, 0);
  const failed = createSender({ env, http: { post: async () => { throw Error("private token and provider payload"); } } });
  assert.deepEqual(await failed("+12025550123", "123456"), { success: false });
  assert.deepEqual(await sender("+12025550123", "not-a-code"), { success: false }); assert.equal(calls.length, 1);
});
