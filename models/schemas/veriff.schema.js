const mongoose = require("mongoose");

module.exports = new mongoose.Schema({
  reference: { type: String, select: false },
  sessionId: String,
  sessionUrl: { type: String, select: false },
  mode: { type: String, enum: ["test", "live"] },
  integrationKeyHash: { type: String, select: false },
  status: { type: String, default: "not_started" },
  message: String,
  reasonCode: Number,
  creationStartedAt: Date,
  sessionCreatedAt: Date,
  decisionAt: Date,
  revision: { type: Number, default: 0 },
  resubmissionRequired: { type: Boolean, default: false },
}, { _id: false });
