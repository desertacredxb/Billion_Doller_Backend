const mongoose = require("mongoose");

const ibSchema = new mongoose.Schema(
  {
    // user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true },

    // Onboarding Questions
    existingClientBase: { type: String, enum: ["Yes", "No"], required: true },
    offerEducation: { type: String, enum: ["Yes", "No"], required: true },
    expectedClientsNext3Months: {
      type: String,
      enum: ["0-10", "10-50", "50-100", "100+"],
      required: true,
    },
    expectedCommissionDirect: { type: String, required: true },
    expectedCommissionSubIB: { type: String, required: true },
    yourShare: { type: Number, default: 0 },
    clientShare: { type: Number, default: 0 },

    // Approval Flow
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    referralCode: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("IB", ibSchema);
