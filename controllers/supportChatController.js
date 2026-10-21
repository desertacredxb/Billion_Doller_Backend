const crypto = require("node:crypto");
const Session = require("../models/SupportChatSession");
const { validateEnquiry } = require("./enquiryController");
const { dubaiDateRange } = require("./operationsController");
const LANGUAGES = ["en", "hi", "bn", "th", "vi", "id"];
const TOPICS = ["account", "verification", "deposit", "withdrawal", "mt5", "ib", "support"];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const SECRET = /^[a-f\d]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const RETENTION_DAYS = 90;
function eventValue(body, at) {
  if (!body || !UUID.test(body.eventId || "") || !LANGUAGES.includes(body.language) || !["open", "language", "topic", "answer", "guide", "team", "close"].includes(body.type)) return null;
  const value = { id: body.eventId, type: body.type, language: body.language, at };
  if (["answer", "guide"].includes(body.type)) {
    if (!Number.isInteger(body.question) || body.question < 0 || body.question > 13) return null;
    value.question = body.question; value.topic = TOPICS[Math.floor(body.question / 2)];
  } else if (body.type === "topic") {
    if (!TOPICS.includes(body.topic)) return null;
    value.topic = body.topic;
  }
  // Arbitrary search text, messages, URLs and visitor identifiers are never retained.
  return value;
}
async function ensureSupportChatStorage() {
  await Session.init();
  // Guarantee retry safety even if a deployment disables Mongoose autoIndex.
  await Session.collection.createIndex({ publicId: 1 }, { name: "publicId_1", unique: true });
  await Session.collection.createIndex({ expiresAt: 1 }, { name: "expiresAt_1", expireAfterSeconds: 0 });
}
function createController({ sessions = Session, now = () => new Date(), ensureStorage = ensureSupportChatStorage } = {}) {
  let storage;
  const ready = () => storage ||= Promise.resolve().then(ensureStorage).catch(error => { storage = null; throw error; });
  const missing = res => res.status(404).json({ message: "Support session unavailable. Start a new saved session." });
  function owned(req, time) {
    const token = req.get("X-BDFX-Chat-Token");
    if (!UUID.test(req.params.id || "") || typeof token !== "string" || !SECRET.test(token)) return null;
    return { publicId: req.params.id, secretHash: hash(token), tokenExpiresAt: { $gt: time }, expiresAt: { $gt: time } };
  }
  return {
    async create(req, res, next) {
      try {
        const body = req.body || {};
        if (body.consent !== true || !UUID.test(body.requestId || "") || typeof body.secret !== "string" || !SECRET.test(body.secret) || !LANGUAGES.includes(body.language)) return res.status(400).json({ message: "Choose to save this support session before continuing." });
        await ready();
        const at = now(), secretHash = hash(body.secret), expiresAt = new Date(at.getTime() + RETENTION_DAYS * 86400000);
        try {
          await sessions.create({ publicId: body.requestId, secretHash, reference: `CHAT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, language: body.language,
            guideVersion: 1, consentVersion: "support-chat-2026-10", consentedAt: at, lastActiveAt: at, expiresAt,
            tokenExpiresAt: new Date(at.getTime() + 86400000), events: [{ id: body.requestId, type: "open", language: body.language, at }] });
        } catch (error) {
          if (error.code !== 11000) throw error;
          const existing = await sessions.findOne({ publicId: body.requestId, secretHash, tokenExpiresAt: { $gt: at }, expiresAt: { $gt: at } }).select("_id");
          if (!existing) return missing(res);
        }
        res.status(201).json({ sessionId: body.requestId, retentionDays: RETENTION_DAYS });
      } catch (error) { next(error); }
    },
    async event(req, res, next) {
      try {
        const at = now(), filter = owned(req, at), value = eventValue(req.body, at);
        if (!filter) return missing(res);
        if (!value) return res.status(400).json({ message: "Invalid support activity." });
        const saved = await sessions.findOneAndUpdate({ ...filter, "events.id": { $ne: value.id }, "events.99": { $exists: false } },
          { $push: { events: value }, $set: { language: value.language, lastActiveAt: at } }, { new: true }).select("_id");
        if (!saved) {
          const existing = await sessions.findOne(filter).select("events.id");
          if (!existing) return missing(res);
          if (!existing.events.some(event => event.id === value.id)) return res.status(429).json({ message: "This saved session has reached its activity limit." });
        }
        res.status(204).end();
      } catch (error) { next(error); }
    },
    async contact(req, res, next) {
      try {
        const at = now(), filter = owned(req, at);
        if (!filter) return missing(res);
        if (typeof req.body?.website === "string" && req.body.website.trim()) return res.status(400).json({ message: "Unable to save this request." });
        const result = validateEnquiry({ name: req.body?.name, email: req.body?.email, phone: req.body?.phone, country: req.body?.country,
          privacyAccepted: req.body?.privacyAccepted, requestId: req.params.id, message: "Website chatbot follow-up request." });
        if (result.error) return res.status(400).json({ message: result.error });
        const { name, email, phone, country } = result.value;
        const contact = { name, email, phone, country, privacyAcceptedAt: at };
        const saved = await sessions.findOneAndUpdate({ ...filter, contact: { $exists: false } }, { $set: { contact, lastActiveAt: at } }, { new: true }).select("_id");
        if (!saved && !await sessions.findOne(filter).select("_id")) return missing(res);
        // A retry cannot replace an earlier visitor's submitted details or reset the team's status.
        res.status(201).json({ success: true });
      } catch (error) { next(error); }
    },
    async list(req, res, next) {
      try {
        let range;
        try { range = dubaiDateRange(req.query.from, req.query.to, now()); if (range.end - range.start > RETENTION_DAYS * 86400000) throw new Error("Choose up to 90 days."); }
        catch (error) { return res.status(400).json({ message: error.message }); }
        const filter = { createdAt: { $gte: range.start, $lt: range.end }, expiresAt: { $gt: now() } };
        if (req.query.language) { if (!LANGUAGES.includes(req.query.language)) return res.status(400).json({ message: "Choose a supported language." }); filter.language = req.query.language; }
        if (req.query.status) { if (!["new", "contacted", "closed"].includes(req.query.status)) return res.status(400).json({ message: "Choose a valid status." }); filter.status = req.query.status; }
        if (req.query.contacts === "true") filter.contact = { $exists: true };
        const page = Math.min(10000, Math.max(1, parseInt(req.query.page, 10) || 1)), limit = 25;
        const [data, total, contacts, active] = await Promise.all([
          sessions.find(filter).select("-events -publicId -secretHash -tokenExpiresAt").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
          sessions.countDocuments(filter), sessions.countDocuments({ ...filter, contact: { $exists: true } }),
          sessions.countDocuments({ ...filter, lastActiveAt: { $gte: new Date(now().getTime() - 300000) } }),
        ]);
        res.json({ data, total, page, limit, summary: { sessions: total, contacts, active }, period: { from: range.from, to: range.to, timezone: range.timezone }, retentionDays: RETENTION_DAYS });
      } catch (error) { next(error); }
    },
    async detail(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return missing(res);
        const data = await sessions.findOne({ _id: req.params.id, expiresAt: { $gt: now() } }).select("-publicId -secretHash -tokenExpiresAt").lean();
        if (!data) return missing(res);
        res.json({ data });
      } catch (error) { next(error); }
    },
    async update(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return missing(res);
        const status = req.body?.status, note = req.body?.note;
        if (!["new", "contacted", "closed"].includes(status) || typeof note !== "string" || note.length > 2000) return res.status(400).json({ message: "Choose a valid status and keep notes below 2,000 characters." });
        const saved = await sessions.findOneAndUpdate({ _id: req.params.id, expiresAt: { $gt: now() } }, { $set: { status, note: note.trim() } }, { new: true }).select("_id");
        if (!saved) return missing(res);
        res.json({ success: true });
      } catch (error) { next(error); }
    },
  };
}
module.exports = { createController, eventValue, LANGUAGES, TOPICS, RETENTION_DAYS };
