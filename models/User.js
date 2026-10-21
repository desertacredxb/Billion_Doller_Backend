const mongoose = require("mongoose");
const idProofSchema = require("./schemas/idProof.schema");
const veriffSchema = require("./schemas/veriff.schema");

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    gender: { type: String },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    registrationEmailKey: { type: String, select: false },
    registrationPhoneKey: { type: String, select: false },
    marketingConsent: { type: Boolean, default: false },
    marketingConsentAt: Date,
    marketingConsentVersion: String,
    marketingUnsubscribedAt: Date,
    emailVerifiedAt: Date,
    phoneVerifiedAt: Date,
    phoneVerificationChannel: { type: String, enum: ["whatsapp"] },
    registration: { type: require("./schemas/registration.schema"), select: false, default: undefined },
    accountType: {
      type: String,
      enum: ["Individual", "Corporate"],
      default: "Individual",
    },
    nationality: { type: String, required: true },
    residenceCountry: { type: String },
    kycProvider: { type: String, enum: ["manual", "veriff"], default: "manual" },
    veriff: { type: veriffSchema, default: undefined },
    address: { type: String },
    country: { type: String },
    state: { type: String, required: true },
    city: { type: String, required: true },
    postalCode: { type: String },
    profileImage: { type: String }, // Path or URL

    password: { type: String, required: true },
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
    otp: { type: String, default: null },
    otpExpires: { type: Date, default: null },
    legacyOtpAttempts: { type: Number, default: 0, select: false },
    isVerified: { type: Boolean, default: false },
    resetOtp: { type: String, default: null },
    resetOtpExpires: { type: Date, default: null },

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
    kycManualReview: { type: new mongoose.Schema({ reviewId: String, approved: Boolean, reviewerId: String, reviewedAt: Date, sessionId: String }, { _id: false }), select: false, default: undefined },

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

// Ensure virtuals are included
userSchema.set("toObject", { virtuals: true });
userSchema.set("toJSON", { virtuals: true, transform: (_doc, result) => {
  for (const key of ["password", "otp", "otpExpires", "resetOtp", "resetOtpExpires", "registration", "registrationEmailKey", "registrationPhoneKey", "legacyOtpAttempts"]) delete result[key];
  return result;
} });

for (const key of ["registrationEmailKey", "registrationPhoneKey"]) {
  userSchema.index({ [key]: 1 }, { name: `registration_${key}_unique`, unique: true,
    partialFilterExpression: { [key]: { $type: "string" } } });
}

// Allow 15 minutes for the email and WhatsApp verification stages.
userSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 900, partialFilterExpression: { isVerified: false } }
);

module.exports = mongoose.model("User", userSchema);
