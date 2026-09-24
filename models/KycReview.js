const mongoose = require('mongoose');

// A durable notification that a provider review changed. No ID images or raw
// provider comments are retained here. The worker fetches the CURRENT result.
const schema = new mongoose.Schema({
  _id: String,
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  applicantId: { type: String, required: true },
  state: { type: String, enum: ['queued', 'processing', 'done', 'blocked'], default: 'queued' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: () => new Date(0) },
  lockToken: String,
  completedAt: Date,
  lastError: String,
}, { timestamps: true });
schema.index({ state: 1, nextAttemptAt: 1, lockedUntil: 1 });
module.exports = mongoose.model('KycReview', schema);
