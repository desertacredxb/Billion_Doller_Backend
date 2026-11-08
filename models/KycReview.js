const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  reviewId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reviewerId: { type: String, required: true }, reviewerEmail: { type: String, required: true },
  approved: { type: Boolean, required: true }, reason: { type: String, required: true, maxlength: 1000 },
  source: { type: String, enum: ["veriff", "owner_documents"], default: "veriff" },
  providerSessionId: { type: String, required() { return this.source === "veriff"; } },
  providerStatus: String, providerReasonCode: Number,
  evidenceReference: { type: String, maxlength: 80 }, documentCountry: String,
  reviewedAt: { type: Date, required: true },
}, { versionKey: false });
module.exports = mongoose.model("KycReview", schema);
