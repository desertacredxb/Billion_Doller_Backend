const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  leadId: { type: String, required: true, unique: true, maxlength: 100 },
  phone: { type: String, required: true, unique: true },
  name: { type: String, default: "", maxlength: 150 },
  email: { type: String, default: "", maxlength: 254 },
  source: { type: String, default: "Upload", maxlength: 100 },
  originalAgent: { type: String, default: "", maxlength: 254 },
  assignmentPending: { type: Boolean, default: false },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "AdminAccount", default: null },
  assignedAt: { type: Date, default: null },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  registrationUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  registrationName: { type: String, maxlength: 150 },
  registeredAt: Date,
  accountOpened: { type: Boolean, default: false },
  status: { type: String, enum: ["new", "follow_up", "worked", "qualified", "closed"], default: "new" },
  followUpAt: { type: Date, default: null },
  lastOutcome: String,
  lastNote: { type: String, default: "", maxlength: 1500 },
  lastOutcomeAt: Date,
  dialRequest: {
    _id: false,
    key: String,
    state: String,
    startedAt: Date,
    callId: String,
  },
}, { timestamps: true });

schema.index({ assignedTo: 1, status: 1, followUpAt: 1, createdAt: 1 });
schema.index({ assignmentPending: 1, assignedTo: 1, status: 1, createdAt: 1 });
schema.index({ assignmentPending: 1, assignedTo: 1, status: 1, registeredAt: -1, createdAt: 1, _id: 1 });

module.exports = mongoose.model("CrmLead", schema);
