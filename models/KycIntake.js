const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  documentUrl: { type: String, required: true },
  documentBackUrl: { type: String, default: '' },
  documentType: String,
  issuingCountry: String,
  state: { type: String, enum: ['queued', 'retry', 'processing', 'done', 'action_required', 'rejected', 'cancelled'], default: 'queued' },
  uploadState: { type: String, enum: ['none', 'uploading', 'uploaded', 'ambiguous'], default: 'none' },
  backUploadState: { type: String, enum: ['none', 'uploading', 'uploaded', 'ambiguous'], default: 'none' },
  applicantId: String,
  documentHash: String,
  backDocumentHash: String,
  providerDocumentType: String,
  providerCountry: String,
  submittedAt: Date,
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  leaseToken: String,
  leaseExpiresAt: Date,
  lastErrorCode: String,
  outcome: { type: String, enum: ['pending', 'resubmission', 'rejected'] },
  reason: String,
}, { timestamps: true });
schema.index({ state: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });

module.exports = mongoose.model('KycIntake', schema);
