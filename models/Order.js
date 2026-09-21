const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
    },
    orderid: { type: String, required: true, unique: true },
    accountNo: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["PENDING", "PARTIALLY_PAID", "SUCCESS", "FAILED"],
      default: "PENDING",
    },
    // Cumulative amount (USD-equivalent) already credited to MT5 for this order.
    // Used to credit only the delta when a partial payment is later topped up,
    // instead of re-crediting the full amount and double-paying the customer.
    creditedAmount: {
      type: Number,
      default: 0,
    },
    // Payment-processor surcharge already folded into `amount` (e.g. Cregis's
    // 0.5% charge). Kept separately just so the breakdown is visible later
    // (support/accounting) - `amount` itself is the real total asked from the payer.
    paymentChargeAmount: {
      type: Number,
      default: 0,
    },
    provider: {
      type: String,
      default: "",
    },
    providerOrderId: {
      type: String,
      sparse: true,
    },
    comment:{
      type: String,
      default: ""
    },
    // TrustPay24 webhook bookkeeping - nested since these fields are only
    // meaningful for that provider. Purely additive: previously these were
    // top-level fields the schema didn't declare, so Mongoose's default
    // strict mode was silently dropping them on save().
    trustpay24: {
      utrNumber: { type: String, default: "" },
      transactionId: { type: String, default: "" },
      transactionRef: { type: String, default: "" },
      approvedAt: { type: Date },
      expiredAt: { type: Date },
      failedAt: { type: Date },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
