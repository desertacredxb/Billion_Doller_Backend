const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, select: false },
  authVersion: { type: Number, default: 0 },
  challengeId: { type: String, select: false },
  otpHash: { type: String, select: false },
  otpExpiresAt: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  resetPassword: { type: Boolean, default: false, select: false },
}, { timestamps: true });

module.exports = mongoose.model("AdminAccount", schema);
