const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createService, VERSION, eligible, nextSlot, config, message, parseToken, unsubscribeToken } = require("../services/emailMarketing.service");
const { createRouter } = require("../routes/emailMarketingRoutes");
const { createMailer } = require("../utils/sendEmail");
const secret = "synthetic-email-test-key-123456";
const consentUser = { _id: "user1", email: "client@example.invalid", isVerified: true, marketingConsent: true, marketingConsentAt: new Date(), marketingConsentVersion: VERSION, nationality: "India" };
function query(value) { return { select() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }, sort() { return this; }, cursor: async function* () { for (const item of value) yield item; } }; }
function fixture({ paused = false, failure = false, prior = null, reservedToday = 0, recentReservations = 0, envPatch = {}, time = "2026-10-21T08:00:00Z" } = {}) {
  const current = new Date(time), state = { paused, reservedToday, budgetDate: "2026-10-21" };
  const sub = { _id: "sub1", publicId: "12345678-1234-1234-1234-123456789012", userId: "user1", email: consentUser.email, active: true, held: false, nextDay: 0, nextAt: new Date("2026-10-21T06:00:00Z") };
  const receipts = prior ? [prior] : []; let sent = 0; const messages = [];
  const apply = (target, update) => { Object.assign(target, update.$set || {}); for (const [k, v] of Object.entries(update.$inc || {})) target[k] = (target[k] || 0) + v; };
  const users = { find: () => query([]), findById: () => query(consentUser), updateOne: async () => {} };
  const states = { updateOne: async (_f, update) => apply(state, update), findOneAndUpdate: async (f, update) => {
    if (f.paused === false && (state.paused || state.reservedToday >= f.reservedToday.$lt || state.lastSlot === f.lastSlot.$ne || state.leaseUntil <= current)) return null;
    apply(state, update); return { ...state };
  } };
  const subscribers = { findOneAndUpdate: async (filter, update) => {
    if (filter.publicId !== sub.publicId) return null;
    apply(sub, update); return { ...sub };
  }, findOne: () => query(sub.active && !sub.held && sub.nextDay < 7 ? { ...sub } : null), updateOne: async (_f, u) => apply(sub, u) };
  const deliveries = { countDocuments: async filter => {
    assert.equal(filter.reservedAt.$gt.getTime(), current.getTime() - 86400000);
    assert.deepEqual(filter.status.$in, ["sending", "accepted", "unknown", "cancelled"]);
    return recentReservations;
  }, find: () => query([]), findOne: () => query(receipts.find(r => r.day === sub.nextDay) || null), create: async entries => receipts.push(...entries), updateOne: async (f, u) => apply(receipts.find(r => r.day === f.day), u) };
  const service = createService({ users, states, subscribers, deliveries, ensure: async () => {}, now: () => current,
    env: { JWT_SECRET: secret, EMAIL_MARKETING_ENABLED: "true", EMAIL_MARKETING_DAILY_LIMIT: "5", ...envPatch }, logger: { error() {} }, send: async message => { messages.push(message); sent++; if (failure) throw Error("synthetic failure"); } });
  return { service, sub, state, receipts, sent: () => sent, messages };
}
test("legacy registrations and unverified or withdrawn consent are never eligible", () => {
  assert.ok(eligible(consentUser));
  for (const override of [{ marketingConsent: undefined }, { marketingConsent: "true" }, { marketingConsentAt: undefined }, { marketingConsentVersion: "other" }, { isVerified: false }, { country: "United Arab Emirates" }, { email: "bad\r\nmail@domain.test" }]) assert.ok(!eligible({ ...consentUser, ...override }));
  assert.equal(config({}).enabled, false); assert.equal(config({ EMAIL_MARKETING_DAILY_LIMIT: "NaN" }).dailyLimit, 0);
});
test("Dubai schedule crosses date boundaries and never chains seven emails on restart", () => {
  assert.equal(nextSlot(new Date("2026-10-21T05:59:00Z")).toISOString(), "2026-10-21T06:00:00.000Z");
  assert.equal(nextSlot(new Date("2026-10-21T08:00:00Z")).toISOString(), "2026-10-22T06:00:00.000Z");
  assert.equal(nextSlot(new Date("2026-10-21T22:00:00Z")).toISOString(), "2026-10-22T06:00:00.000Z");
});
test("unsubscribe tokens cannot target an arbitrary subscriber and every email contains one-click headers", () => {
  const id = "12345678-1234-1234-1234-123456789012", token = unsubscribeToken(id, secret);
  assert.equal(parseToken(token, secret), id); assert.equal(parseToken(token.replace("12345678", "99999999"), secret), null);
  assert.equal(parseToken(token, "different"), null); assert.equal(parseToken({ token }, secret), null);
  for (let day = 0; day < 7; day++) { const m = message(day, { publicId: id, email: consentUser.email }, secret); assert.ok(m.text.includes("Unsubscribe:")); assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click"); }
});
test("paused worker sends nothing; active worker advances once and respects daily budget", async () => {
  const paused = fixture({ paused: true }); assert.equal((await paused.service.processPending()).outcome, "paused"); assert.equal(paused.sent(), 0);
  const limited = fixture({ reservedToday: 5 }); assert.equal((await limited.service.processPending()).outcome, "daily_limit"); assert.equal(limited.sent(), 0);
  const live = fixture(); assert.equal((await live.service.processPending()).outcome, "accepted"); assert.equal(live.sent(), 1); assert.equal(live.sub.nextDay, 1); assert.equal(live.receipts[0].status, "accepted");
  await live.service.processPending(); assert.equal(live.sent(), 1);
});
test("Dubai early morning is outside sending window, including UTC previous evening", async () => {
  const f = fixture({ time: "2026-10-21T22:00:00Z" }); assert.equal((await f.service.processPending()).outcome, "outside_window"); assert.equal(f.sent(), 0);
});
test("uncertain SMTP deliveries are held without retries and accepted receipts reconcile without sending", async () => {
  const failed = fixture({ failure: true }); assert.equal((await failed.service.processPending()).outcome, "delivery_unconfirmed"); assert.equal(failed.sub.held, true); assert.equal(failed.receipts[0].status, "unknown"); await failed.service.processPending(); assert.equal(failed.sent(), 1);
  const recorded = fixture({ prior: { day: 0, status: "accepted", acceptedAt: new Date("2026-10-20T08:00:00Z") } }); assert.equal((await recorded.service.processPending()).outcome, "reconciled"); assert.equal(recorded.sub.nextDay, 1); assert.equal(recorded.sent(), 0);
});
test("mailer preserves List-Unsubscribe headers", async () => {
  let captured;
  const send = createMailer({ env: { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_USER: "support@example.invalid", SMTP_PASS: "synthetic", SMTP_FROM: "support@example.invalid" }, mail: { createTransport: () => ({ sendMail: async m => { captured = m; } }) }, logger: { info() {}, error() {} } });
  await send({ ...message(0, { publicId: "12345678-1234-1234-1234-123456789012", email: consentUser.email }, secret) });
  assert.equal(captured.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});
test("unsubscribe GET does not mutate, POST opts out; owner and self-preference boundaries enforced", async () => {
  let unsub = 0, report = 0, preference;
  const campaign = { unsubscribe: async token => { unsub++; return token === "valid"; }, status: async () => { report++; return {}; }, getPreference: async () => ({ subscribed: false }), preference: async (id, value) => { preference = { id, value }; return { subscribed: value }; } };
  const authentication = (req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); next(); };
  const principal = (req, _res, next) => { req.principal = { id: "self", isAdmin: req.headers.authorization === "owner" }; next(); };
  const owner = (req, res, next) => req.principal.isAdmin ? next() : res.sendStatus(403);
  const app = express(); app.use(express.json()); app.use(createRouter({ campaign, authentication, principal, owner }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r)); const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + "/unsubscribe?token=valid")).status, 200); assert.equal(unsub, 0);
    const out = await fetch(url + "/unsubscribe?token=valid", { method: "POST" }); assert.equal(out.status, 200); assert.equal(out.headers.get("cache-control"), "no-store"); assert.equal(unsub, 1);
    assert.equal((await fetch(url + "/report")).status, 401); assert.equal((await fetch(url + "/report", { headers: { Authorization: "client" } })).status, 403); assert.equal(report, 0);
    assert.equal((await fetch(url + "/report", { headers: { Authorization: "owner" } })).status, 200); assert.equal(report, 1);
    const put = body => fetch(url + "/preferences", { method: "PUT", headers: { Authorization: "client", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await put({ subscribed: "true" })).status, 400); assert.equal((await put({ subscribed: true, userId: "victim" })).status, 400); assert.equal(preference, undefined);
    assert.equal((await put({ subscribed: true })).status, 200); assert.deepEqual(preference, { id: "self", value: true });
  } finally { await new Promise(r => server.close(r)); }
});


test("rolling campaign budget still blocks delivery after the Dubai daily counter resets", async () => {
  const f = fixture({ time: "2026-10-22T06:00:00Z", reservedToday: 0, recentReservations: 5 });
  assert.equal((await f.service.processPending()).outcome, "rolling_limit");
  assert.equal(f.state.budgetDate, "2026-10-22"); assert.equal(f.sent(), 0); assert.equal(f.receipts.length, 0);
});
test("expired rolling reservations allow a due message while retaining the per-minute throttle", async () => {
  const f = fixture({ time: "2026-10-22T06:00:00Z", recentReservations: 4 });
  assert.equal((await f.service.processPending()).outcome, "accepted");
  assert.equal(f.sent(), 1); assert.equal((await f.service.processPending()).outcome, "throttled");
});


test("a dedicated campaign key signs and verifies unsubscribe links independently of login credentials", async () => {
  const campaignKey = "synthetic-dedicated-campaign-key-123456789";
  assert.equal(config({ JWT_SECRET: "short" }).secretReady, false);
  assert.equal(config({ JWT_SECRET: "short", EMAIL_MARKETING_TOKEN_SECRET: campaignKey }).secretReady, true);
  const f = fixture({ envPatch: { JWT_SECRET: "short", EMAIL_MARKETING_TOKEN_SECRET: campaignKey } });
  assert.equal((await f.service.processPending()).outcome, "accepted");
  const link = f.messages[0].headers["List-Unsubscribe"].slice(1, -1);
  const token = new URL(link).searchParams.get("token");
  assert.equal(parseToken(token, campaignKey), f.sub.publicId); assert.equal(parseToken(token, "short"), null);
  assert.equal(await f.service.unsubscribe(unsubscribeToken(f.sub.publicId, "short")), false);
  assert.equal(await f.service.unsubscribe(token), true); assert.equal(f.sub.active, false);
});
