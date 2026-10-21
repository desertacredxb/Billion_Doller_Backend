const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  reviewId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reviewerId: { type: String, required: true }, reviewerEmail: { type: String, required: true },
  approved: { type: Boolean, required: true }, reason: { type: String, required: true, maxlength: 1000 },
  providerSessionId: { type: String, required: true }, providerStatus: String, providerReasonCode: Number,
  reviewedAt: { type: Date, required: true },
}, { versionKey: false });
module.exports = mongoose.model("KycReview", schema);
