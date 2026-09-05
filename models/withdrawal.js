const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    orderid: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    accountNo: { type: String, required: true }, // MT5 Trading Account Number
    
    // 🔹 Core Currency Selection
    currency: {
      type: String,
      enum: ["INR", "USD", "CRYPTO"],
      required: true,
    },

    amount: { type: Number, required: true },
    
    // 🔹 INR Payout Fields (Bank / UPI)
    account: { type: String, default: null }, // Bank Account Number
    ifsc: { type: String, default: null },
    upiId: { type: String, default: null },

    // 🔹 USD Payout Fields (Wire / SWIFT)
    bankName: { type: String, default: null },
    swiftCode: { type: String, default: null },

    // 🔹 Crypto / Cregis Payout Fields
    cryptoSymbol: { type: String, default: "USDT" }, // e.g., USDT, BTC, ETH
    walletAddress: { type: String, default: null },
    network: { type: String, default: null },        // e.g., TRC20, ERC20, BEP20
    memo: { type: String, default: null },           // Tag/Memo for exchanges

    // 🔹 Metadata & Status
    note: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Pending", "Processing", "Completed", "Failed", "Rejected"],
      default: "Pending",
    },
    
    gatewayOrderId: { type: String, default: null }, // Stores Cregis tx_id
    response: { type: Object, default: {} },          // Stores API/Webhook responses
  },
  { timestamps: true }
);

module.exports = mongoose.model("Withdrawal", withdrawalSchema);