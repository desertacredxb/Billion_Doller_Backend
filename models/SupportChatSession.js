const mongoose = require("mongoose");
const languages = ["en", "hi", "bn", "th", "vi", "id"];
const eventSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 36 },
  type: { type: String, enum: ["open", "language", "topic", "answer", "guide", "team", "close"], required: true },
  language: { type: String, enum: languages, required: true },
  topic: { type: String, enum: ["account", "verification", "deposit", "withdrawal", "mt5", "ib", "support"] },
  question: { type: Number, min: 0, max: 13 },
  at: { type: Date, required: true },
}, { _id: false });
const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 },
  email: { type: String, required: true, maxlength: 254 },
  phone: { type: String, default: "", maxlength: 40 },
  country: { type: String, required: true, maxlength: 100 },
  privacyAcceptedAt: { type: Date, required: true },
}, { _id: false });
const schema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, maxlength: 36 },
  secretHash: { type: String, required: true, select: false },
  tokenExpiresAt: { type: Date, required: true, select: false },
  reference: { type: String, required: true, maxlength: 24 },
  guideVersion: { type: Number, enum: [1], default: 1 },
  consentVersion: { type: String, enum: ["support-chat-2026-10"], default: "support-chat-2026-10" },
  consentedAt: { type: Date, required: true },
  language: { type: String, enum: languages, required: true },
  lastActiveAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  events: { type: [eventSchema], validate: value => value.length <= 100 },
  contact: { type: contactSchema, default: undefined },
  status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
  note: { type: String, default: "", maxlength: 2000 },
}, { timestamps: true, toJSON: { transform(_doc, value) { delete value.secretHash; delete value.tokenExpiresAt; delete value.publicId; return value; } } });
schema.index({ createdAt: -1, _id: -1 });
schema.index({ lastActiveAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("SupportChatSession", schema);
