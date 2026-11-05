const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: String,
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  recipient: { type: String, required: true },
  status: { type: String, enum: ["sending", "accepted", "unknown"], required: true },
  reservedAt: { type: Date, required: true },
  acceptedAt: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("OwnerEmailTest", schema);
