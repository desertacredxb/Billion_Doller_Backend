const mongoose = require("mongoose");

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

    password: { type: String, required: true },
    referralCode: { type: String },
    isApprovedIB: { type: Boolean, default: false },
    otp: { type: String, default: null },
    otpExpires: { type: Date, default: null },
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

    identityFront: { type: String },
    identityBack: { type: String },
    addressProof: { type: String },
    selfieProof: { type: String },
    hasSubmittedDocuments: { type: Boolean, default: false },
    isKycVerified: { type: Boolean, default: false },

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
userSchema.set("toJSON", { virtuals: true });

// Auto-expire unverified accounts after 5 minutes (for example)
userSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 300, partialFilterExpression: { isVerified: false } }
);

module.exports = mongoose.model("User", userSchema);
