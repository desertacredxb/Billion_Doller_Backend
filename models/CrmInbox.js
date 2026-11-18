const mongoose = require("mongoose");
const { Schema } = mongoose;
const ref = Schema.Types.ObjectId;
const channel = { type: String, enum: ["telegram", "whatsapp"], required: true };
const account = new Schema({
  agent: { type: ref, required: true }, channel, externalId: String, connectionId: String,
  enabled: { type: Boolean, default: false }, canReply: Boolean, secret: { type: String, select: false },
  pairingHash: String, pairingUntil: Date, consentAt: Date, connectedAt: Date,
}, { timestamps: true });
account.index({ agent: 1, channel: 1 }, { unique: true });
account.index({ channel: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
const thread = new Schema({
  account: { type: ref, required: true }, agent: { type: ref, required: true }, lead: { type: ref, required: true }, channel,
  peer: String, pairingHash: String, pairingUntil: Date, lastIncoming: Date,
}, { timestamps: true });
thread.index({ account: 1, lead: 1 }, { unique: true });
thread.index({ account: 1, peer: 1 }, { unique: true, partialFilterExpression: { peer: { $type: "string" } } });
const message = new Schema({
  thread: { type: ref, required: true }, remoteId: String, key: String, outbound: Boolean, superseded: Boolean,
  state: { type: String, enum: ["received", "sending", "sent", "unconfirmed", "failed", "deleted"] },
  text: { type: String, maxlength: 8192 }, at: { type: Date, required: true },
}, { timestamps: true });
message.index({ thread: 1, remoteId: 1 }, { unique: true, partialFilterExpression: { remoteId: { $type: "string" } } });
message.index({ thread: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });
message.index({ thread: 1, at: -1 });
module.exports = { Account: mongoose.model("CrmInboxAccount", account), Thread: mongoose.model("CrmInboxThread", thread), Message: mongoose.model("CrmInboxMessage", message) };
