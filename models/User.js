const mongoose = require("mongoose");
const idProofSchema = require("./schemas/idProof.schema");

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    gender: { type: String },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    accountType: {
      type: String,
      enum: ["Individual", "Corporate"],
      default: "Individual",
    },
    nationality: { type: String, required: true },
    address: { type: String },
    country: { type: String },
    state: { type: String, required: true },
    city: { type: String, required: true },
    postalCode: { type: String },
    profileImage: { type: String }, // Path or URL

    password: { type: String, required: true, select: false },
    referralCode: { type: String },
    // Stable link to the referring IB, captured at signup time. Kept
    // alongside referralCode (the raw string used) because referralCode
    // alone can't survive the referring IB's code being rotated/revoked -
    // this ObjectId keeps the relationship intact regardless.
    referredByIB: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IB",
      default: null,
    },
    isApprovedIB: { type: Boolean, default: false },
    commission: { type: Number, default: 0 }, // Total commission earned by IB
    lastWithdrawalDate: { type: Date, default: null },
    otp: { type: String, default: null, select: false },
    otpExpires: { type: Date, default: null, select: false },
    isVerified: { type: Boolean, default: false },
    resetOtp: { type: String, default: null, select: false },
    resetOtpExpires: { type: Date, default: null, select: false },

    accountHolderName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    iban: { type: String },
    bankName: { type: String },
    bankAddress: { type: String },

    pendingBankDetails: {
      accountHolderName: { type: String },
      accountNumber: { type: String },
      ifscCode: { type: String },
      iban: { type: String },
      bankName: { type: String },
      bankAddress: { type: String },
    },
    bankApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
    },

    idProof1: { type: idProofSchema, default: () => ({}) },
    idProof2: { type: idProofSchema, default: () => ({}) },
    hasSubmittedDocuments: { type: Boolean, default: false },
    isKycVerified: { type: Boolean, default: false },
    kycAutomation: {
      status: { type: String, enum: ["not_started", "pending", "action_required", "approved", "rejected"], default: "not_started" },
      reason: String,
      provider: String,
      applicantId: String,
      intakeKey: String,
      submittedAt: Date,
      reviewId: String,
      reviewKey: String,
      reviewedAt: Date,
      processedAt: Date,
    },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Virtual field to link to Account model
userSchema.virtual("accounts", {
  ref: "Account",
  localField: "_id",
  foreignField: "user",
});

const SECRET_FIELDS = new Set(['password', 'otp', 'otpExpires', 'resetOtp', 'resetOtpExpires',
  'moneyPlantPassword', 'mt5Password', 'mt5InvestorPassword']);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELDS.has(key))
    .map(([key, item]) => [key, redact(item)]));
}
const transform = (document, returned) => redact(returned);
userSchema.set('toObject', { virtuals: true, transform });
userSchema.set('toJSON', { virtuals: true, transform });
// Also use this at response boundaries for projected/plain/lean records.
userSchema.statics.toSafeObject = value => redact(typeof value?.toObject === 'function' ? value.toObject() : value);

// Auto-expire unverified accounts after 5 minutes (for example)
userSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 300, partialFilterExpression: { isVerified: false } }
);

module.exports = mongoose.model("User", userSchema);
