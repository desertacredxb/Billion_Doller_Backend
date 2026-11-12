const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true, maxlength: 160 },
  kind: { type: String, required: true, enum: ["outcome", "hashmi"] },
  providerCallId: { type: String, maxlength: 120 },
  hashmiExportStatus: String,
  agent: { type: mongoose.Schema.Types.ObjectId, ref: "AdminAccount", required: true },
  lead: { type: mongoose.Schema.Types.ObjectId, ref: "CrmLead", default: null },
  occurredAt: { type: Date, required: true },
  outcome: String,
  note: { type: String, maxlength: 1500 },
  followUpAt: Date,
  attempted: { type: Boolean, default: false },
  connected: { type: Boolean, default: false },
  talkSeconds: { type: Number, min: 0, default: 0 },
}, { timestamps: true });

schema.index({ agent: 1, occurredAt: -1 });
schema.index({ lead: 1, occurredAt: -1 });

module.exports = mongoose.model("CrmCall", schema);
