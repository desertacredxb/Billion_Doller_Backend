const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  requestId: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxlength: 120 },
  email: { type: String, required: true, maxlength: 254 },
  phone: { type: String, maxlength: 40, default: "" },
  country: { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 5000 },
  privacyAcceptedAt: { type: Date, required: true },
  consentVersion: { type: String, default: "contact-2026-10" },
  marketingConsent: { type: Boolean, default: false },
  campaign: { source: String, medium: String, campaign: String },
  status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
  note: { type: String, maxlength: 2000, default: "" },
  notificationStatus: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending" },
  notificationAttempts: { type: Number, default: 0 },
  notificationAttemptedAt: Date,
  notificationNextAttemptAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.index({ status: 1, createdAt: -1 });
schema.index({ notificationStatus: 1, notificationNextAttemptAt: 1 });
module.exports = mongoose.model("Enquiry", schema);
