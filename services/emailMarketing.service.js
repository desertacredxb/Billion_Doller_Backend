const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const { Subscriber, Delivery, State } = require("../models/EmailMarketing");
const sendEmail = require("../utils/sendEmail");
const plan = require("../data/emailSequence");
const { isUae } = require("../utils/veriffPolicy");
const VERSION = "email-marketing-2026-10-v1", ID = "seven-day-v1", DAY = 86400000;
const WRITE = { w: "majority", j: true };
const SETTINGS = { new: true, writeConcern: WRITE };
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
const dubaiDate = date => DATE.format(date);
function nextSlot(date, tomorrow = false) {
  const shifted = new Date(date.getTime() + 4 * 3600000);
  let target = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 7); // 11:00 Dubai
  if (tomorrow || target < date.getTime()) target += DAY;
  return new Date(target);
}
function eligible(user) {
  return user?.isVerified === true && user.marketingConsent === true && user.marketingConsentVersion === VERSION
    && user.marketingConsentAt && Number.isFinite(new Date(user.marketingConsentAt).getTime())
    && typeof user.email === "string" && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(user.email)
    && ![user.nationality, user.residenceCountry, user.country].some(isUae);
}
function config(env) {
  const dailyLimit = Number(env.EMAIL_MARKETING_DAILY_LIMIT || 0);
  return { enabled: env.EMAIL_MARKETING_ENABLED === "true", dailyLimit: Number.isSafeInteger(dailyLimit) && dailyLimit > 0 && dailyLimit <= 1000 ? dailyLimit : 0,
    secretReady: typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length >= 16 };
}
function signature(id, secret) { return crypto.createHmac("sha256", secret).update(`bdfx-email-unsubscribe-v1:${id}`).digest("hex"); }
function unsubscribeToken(id, secret) { return `${id}.${signature(id, secret)}`; }
function parseToken(token, secret) {
  if (typeof token !== "string" || !/^[a-f\d-]{36}\.[a-f\d]{64}$/i.test(token) || !secret) return null;
  const [id, hash] = token.split(".");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature(id, secret))) ? id : null;
}
function message(day, subscriber, secret) {
  const article = plan[day]; if (!article) throw Error("Invalid email day");
  const link = `https://www.billiondollarfx.com${article.path}`;
  const unsubscribe = `https://billion-doller-backend.onrender.com/api/email-marketing/unsubscribe?token=${unsubscribeToken(subscriber.publicId, secret)}`;
  return { to: subscriber.email, subject: article.subject,
    text: `${article.heading}\n\n${article.body}\n\n${article.action}: ${link}\n\nBillion Dollar FX\nYou opted in to email updates. Unsubscribe: ${unsubscribe}\nSupport: support@billiondollarfx.com\nTrading involves risk. No guaranteed returns.`,
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, throwOnError: true };
}
async function ensureStorage(connection = mongoose.connection) {
  if (connection.readyState !== 1) throw Error("Email storage unavailable");
  for (const model of [Subscriber, Delivery, State]) {
    const name = model.collection.collectionName;
    if (!await connection.db.listCollections({ name }, { nameOnly: true }).hasNext()) {
      try { await connection.db.createCollection(name); } catch (e) { if (e.code !== 48) throw e; }
    }
    for (const [fields, options] of model.schema.indexes()) await model.collection.createIndex(fields, options);
  }
}
function createService({ users = User, subscribers = Subscriber, deliveries = Delivery, states = State, send = sendEmail,
  now = () => new Date(), env = process.env, ensure = ensureStorage, logger = console } = {}) {
  let running = false, storageReady;
  async function ready() {
    if (!storageReady) storageReady = Promise.resolve().then(ensure).catch(error => { storageReady = null; throw error; });
    return storageReady;
  }
  async function sync() {
    const current = now();
    for await (const user of users.find({ isVerified: true, marketingConsent: true, marketingConsentVersion: VERSION, marketingConsentAt: { $type: "date" } })
      .select("_id email isVerified nationality residenceCountry country marketingConsent marketingConsentAt marketingConsentVersion").lean().cursor()) {
      if (!eligible(user)) continue;
      try {
        await subscribers.updateOne({ userId: user._id }, { $setOnInsert: { publicId: crypto.randomUUID(), userId: user._id,
          email: user.email.trim().toLowerCase(), consentAt: user.marketingConsentAt, consentVersion: VERSION, active: true, held: false,
          nextDay: 0, nextAt: nextSlot(current) } }, { upsert: true, writeConcern: WRITE });
      } catch (e) { if (e.code !== 11000) throw e; }
    }
    await states.updateOne({ _id: ID }, { $set: { lastSyncAt: current } }, { writeConcern: WRITE });
  }
  async function processPending() {
    if (running) return { outcome: "busy" }; running = true;
    const leaseToken = crypto.randomUUID(); let locked = false;
    const current = now();
    try {
      await ready();
      await states.updateOne({ _id: ID }, { $setOnInsert: { paused: true, reservedToday: 0 } }, { upsert: true, writeConcern: WRITE });
      const state = await states.findOneAndUpdate({ _id: ID, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: current } }] },
        { $set: { leaseToken, leaseUntil: new Date(current.getTime() + 120000) } }, SETTINGS);
      if (!state) return { outcome: "busy" }; locked = true;
      await sync();
      // SMTP cannot provide exactly-once delivery. Never blindly retry an interrupted send.
      const interrupted = await deliveries.find({ status: "sending", reservedAt: { $lt: new Date(current.getTime() - 120000) } }).select("subscriberId").lean();
      for (const item of interrupted) {
        await deliveries.updateOne({ _id: item._id, status: "sending" }, { $set: { status: "unknown" } }, { writeConcern: WRITE });
        await subscribers.updateOne({ _id: item.subscriberId }, { $set: { held: true } }, { writeConcern: WRITE });
      }
      const cfg = config(env), slot = Math.floor(current.getTime() / 60000);
      if (!cfg.enabled || !cfg.dailyLimit || !cfg.secretReady || state.paused) return { outcome: "paused" };
      if (new Date(current.getTime() + 4 * 3600000).getUTCHours() < 11) return { outcome: "outside_window" };
      if (state.lastSlot === slot) return { outcome: "throttled" };
      const date = dubaiDate(current);
      if (state.budgetDate !== date) await states.updateOne({ _id: ID, leaseToken }, { $set: { budgetDate: date, reservedToday: 0 } }, { writeConcern: WRITE });
      const candidate = await subscribers.findOne({ active: true, held: false, nextDay: { $lt: 7 }, nextAt: { $lte: current } }).sort({ nextAt: 1, _id: 1 }).lean();
      if (!candidate) return { outcome: "empty" };
      const user = await users.findById(candidate.userId).select("email isVerified isKycVerified nationality residenceCountry country marketingConsent marketingConsentAt marketingConsentVersion").lean();
      if (!eligible(user) || user.email.trim().toLowerCase() !== candidate.email) {
        await subscribers.updateOne({ _id: candidate._id }, { $set: { active: false } }, { writeConcern: WRITE }); return { outcome: "ineligible" };
      }
      const prior = await deliveries.findOne({ subscriberId: candidate._id, day: candidate.nextDay }).lean();
      const advance = at => subscribers.updateOne({ _id: candidate._id, nextDay: candidate.nextDay },
        { $inc: { nextDay: 1 }, $set: { nextAt: nextSlot(new Date(at), true) } }, { writeConcern: WRITE });
      if (prior) {
        if (["accepted", "skipped"].includes(prior.status)) await advance(prior.acceptedAt || prior.reservedAt);
        else await subscribers.updateOne({ _id: candidate._id }, { $set: { held: true } }, { writeConcern: WRITE });
        return { outcome: "reconciled" };
      }
      if (plan[candidate.nextDay].pendingKycOnly && user.isKycVerified) {
        await deliveries.create([{ subscriberId: candidate._id, day: candidate.nextDay, status: "skipped", reservedAt: current }], { writeConcern: WRITE });
        await advance(current); return { outcome: "skipped" };
      }
      const budget = await states.findOneAndUpdate({ _id: ID, leaseToken, leaseUntil: { $gt: now() }, paused: false, reservedToday: { $lt: cfg.dailyLimit }, lastSlot: { $ne: slot } },
        { $inc: { reservedToday: 1 }, $set: { lastSlot: slot } }, SETTINGS);
      if (!budget) return { outcome: "daily_limit" };
      await deliveries.create([{ subscriberId: candidate._id, day: candidate.nextDay, status: "sending", reservedAt: current }], { writeConcern: WRITE });
      const latest = await users.findById(candidate.userId).select("email isVerified isKycVerified nationality residenceCountry country marketingConsent marketingConsentAt marketingConsentVersion").lean();
      const active = await subscribers.findOne({ _id: candidate._id, active: true, held: false }).lean();
      if (!eligible(latest) || latest.email.trim().toLowerCase() !== candidate.email || !active) {
        await deliveries.updateOne({ subscriberId: candidate._id, day: candidate.nextDay }, { $set: { status: "cancelled" } }, { writeConcern: WRITE });
        return { outcome: "cancelled" };
      }
      try { await send(message(candidate.nextDay, candidate, env.JWT_SECRET)); }
      catch {
        await deliveries.updateOne({ subscriberId: candidate._id, day: candidate.nextDay }, { $set: { status: "unknown" } }, { writeConcern: WRITE });
        await subscribers.updateOne({ _id: candidate._id }, { $set: { held: true } }, { writeConcern: WRITE });
        return { outcome: "delivery_unconfirmed" };
      }
      const acceptedAt = now();
      await deliveries.updateOne({ subscriberId: candidate._id, day: candidate.nextDay, status: "sending" }, { $set: { status: "accepted", acceptedAt } }, { writeConcern: WRITE });
      await advance(acceptedAt); return { outcome: "accepted" };
    } catch { logger.error("Email marketing tick failed; no automatic retry of an uncertain SMTP delivery."); return { outcome: "unavailable" }; }
    finally {
      if (locked) { try { await states.updateOne({ _id: ID, leaseToken }, { $set: { leaseToken: null, leaseUntil: null, lastRunAt: now() } }, { writeConcern: WRITE }); } catch { /* Lease expires. */ } }
      running = false;
    }
  }
  async function status() {
    await ready();
    const [registered, optedIn, enrolled, accepted, held, unsubscribed, state] = await Promise.all([
      users.countDocuments({ isVerified: true }), users.countDocuments({ isVerified: true, marketingConsent: true, marketingConsentVersion: VERSION, marketingConsentAt: { $type: "date" } }),
      subscribers.countDocuments({ active: true, nextDay: { $lt: 7 } }), deliveries.countDocuments({ status: "accepted" }),
      subscribers.countDocuments({ held: true }), subscribers.countDocuments({ active: false, unsubscribedAt: { $ne: null } }), states.findById(ID).lean(),
    ]);
    const cfg = config(env);
    return { registered, optedIn, enrolled, accepted, held, unsubscribed, paused: state?.paused !== false,
      sendingConfigured: cfg.enabled && !!cfg.dailyLimit && cfg.secretReady, dailyLimit: cfg.dailyLimit, timezone: "Asia/Dubai", startsAt: "11:00",
      lastSyncAt: state?.lastSyncAt || null, lastRunAt: state?.lastRunAt || null, plan };
  }
  async function setPaused(paused) {
    if (typeof paused !== "boolean") throw Error("Choose pause or resume");
    const cfg = config(env);
    if (!paused && (!cfg.enabled || !cfg.dailyLimit || !cfg.secretReady)) throw Error("Confirm the mailbox sending allowance before enabling campaign delivery.");
    await ready(); await states.updateOne({ _id: ID }, { $set: { paused } }, { upsert: true, writeConcern: WRITE }); return status();
  }
  async function preference(userId, value) {
    if (typeof value !== "boolean") throw Error("Choose an email preference");
    await ready();
    const update = { marketingConsent: value, marketingConsentVersion: VERSION,
      ...(value ? { marketingConsentAt: now() } : { marketingUnsubscribedAt: now() }) };
    const user = await users.findOneAndUpdate({ _id: userId, isVerified: true }, { $set: update }, SETTINGS);
    if (!user) throw Error("Account unavailable");
    if (!value) await subscribers.updateOne({ userId }, { $set: { active: false, unsubscribedAt: now() } }, { writeConcern: WRITE });
    else await subscribers.updateOne({ userId }, { $set: { active: true, consentAt: now(), consentVersion: VERSION } }, { writeConcern: WRITE });
    return { subscribed: value };
  }
  async function unsubscribe(token) {
    const id = parseToken(token, env.JWT_SECRET); if (!id) return false;
    const subscriber = await subscribers.findOneAndUpdate({ publicId: id }, { $set: { active: false, unsubscribedAt: now() } }, SETTINGS);
    if (!subscriber) return false;
    await users.updateOne({ _id: subscriber.userId }, { $set: { marketingConsent: false, marketingUnsubscribedAt: now() } }, { writeConcern: WRITE });
    return true;
  }
  function start() { const tick = () => processPending().catch(() => {}); tick(); const timer = setInterval(tick, 60000); timer.unref(); return timer; }
  async function getPreference(userId) {
    const user = await users.findById(userId).select("marketingConsent marketingConsentVersion").lean();
    return { subscribed: user?.marketingConsent === true && user.marketingConsentVersion === VERSION };
  }
  return { processPending, getPreference, status, setPaused, preference, unsubscribe, start };
}
module.exports = { ...createService(), createService, VERSION, nextSlot, eligible, config, message, parseToken, unsubscribeToken };
