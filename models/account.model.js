const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // one account per user
      required: true,
    },
    accountNo: {
      type: Number,
      required: true,
      unique: true,
    },
    currency: {
      type: String,
      required: true, // e.g., USD
    },
    accountType: {
      type: String,
      enum: ["LIVE", "DEMO"],
      default: "LIVE",
      required: true,
    },
    userType: {
      type: String,
      enum: ["CLIENT", "ADMIN"],
      default: "CLIENT",
      required: true,
    },
    referralCode: {
      type: String,
      default: "",
    },
    moneyPlantPassword: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Account", accountSchema);
