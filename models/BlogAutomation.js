const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: { type: String, default: "education-v1" },
  enabled: { type: Boolean, default: true },
  startedAt: { type: Date, required: true },
  nextPublishAt: { type: Date, required: true },
  pendingSlug: { type: String, default: null },
  lastPublishedAt: { type: Date, default: null },
  lastRunAt: { type: Date, default: null },
  lastOutcome: { type: String, default: "waiting" },
  lastError: { type: String, default: "" },
  leaseToken: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  history: [{ _id: false, at: Date, outcome: String, slug: String, code: String }],
}, { timestamps: true });
module.exports = mongoose.models.BlogAutomation || mongoose.model("BlogAutomation", schema);
