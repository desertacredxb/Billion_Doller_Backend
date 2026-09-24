const mongoose = require('mongoose');

// One delivery record per event and channel. The primary key is a hash of the
// event identity; documents and provider webhook payloads do not belong here.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  subjectKey: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  eventAt: { type: Date, required: true },
  eventPriority: { type: Number, required: true, enum: [0, 1, 2, 3] },
  channel: { type: String, enum: ['email', 'whatsapp'], required: true },
  recipient: { type: String, default: '', maxlength: 320 },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'resubmission'], required: true },
  reason: { type: String, default: '', maxlength: 300 },
  state: { type: String, enum: ['queued', 'sending', 'retry', 'sent', 'skipped', 'cancelled'], required: true },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, required: true },
  leaseToken: { type: String, default: null },
  leaseExpiresAt: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  lastErrorCode: { type: String, enum: ['', 'recipient_missing', 'configuration_unavailable', 'automation_disabled', 'provider_not_accepted', 'send_failed', 'superseded'], default: '' },
}, { timestamps: true, versionKey: false });

schema.index({ state: 1, nextAttemptAt: 1 });
schema.index({ state: 1, leaseExpiresAt: 1 });
schema.index({ subjectKey: 1, eventAt: -1, eventPriority: -1 });

module.exports = mongoose.models.KycNotice || mongoose.model('KycNotice', schema);
