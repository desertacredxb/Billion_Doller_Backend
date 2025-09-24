const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    transactionId: { type: String, required: true }, // API's transaction id
    status: { type: String, required: true },
    merchantTxnId: { type: String, required: true },
    merchantUserId: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    addedOn: { type: Date, required: true },
    refId: { type: String },
    gateway: { type: Number },
    merchant: { type: Number },
    wallet: { type: Number },
    currency: { type: String, default: "INR" },
    transactionPayinRequests: { type: Array, default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", transactionSchema);
