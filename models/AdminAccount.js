const mongoose = require("mongoose");
const { PERMISSIONS } = require("../services/adminPolicy");

const schema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  fullName: { type: String, trim: true, maxlength: 100 },
  role: { type: String, enum: ["owner", "manager"], default: "manager" },
  enabled: { type: Boolean, default: true },
  permissions: [{ type: String, enum: PERMISSIONS }],
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminAccount" },
  disabledAt: Date,
  lastLoginAt: Date,
  passwordHash: { type: String, select: false },
  authVersion: { type: Number, default: 0 },
  challengeId: { type: String, select: false },
  otpHash: { type: String, select: false },
  otpExpiresAt: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  resetPassword: { type: Boolean, default: false, select: false },
}, { timestamps: true });

module.exports = mongoose.model("AdminAccount", schema);
