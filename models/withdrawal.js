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
    // USD-equivalent of `amount` at request time (used to deduct/refund MT5 in a
    // consistent currency regardless of what `amount`/`currency` the payer chose).
    amountUSD: { type: Number, default: 0 },


    // 🔹 Contact / Requester Metadata
    name: { type: String, default: "" },
    mobile: { type: String, default: "" },

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
    // True for requests submitted with manually-entered bank details
    // (handleManualPaymentRequest), used by approvePayoutReq to pick the
    // manual-processing path instead of a gateway API call.
    isManual: { type: Boolean, default: false },
    // How a completed/failed payout was actually executed: "Manual",
    // "Cregis API", or "RameePay API (<currency>)".
    processType: { type: String, default: "" },
    // Bank/blockchain reference for a completed payout (admin-entered txId for
    // manual transfers, or the tx hash/reference reported by the gateway).
    transactionReference: { type: String, default: "" },
    // Cregis's own payout id (cid), stored for support/reconciliation lookups.
    cregisCid: { type: String, default: "" },

    gatewayOrderId: { type: String, default: null }, // Stores Cregis tx_id
    response: { type: Object, default: {} },          // Stores API/Webhook responses
  },
  { timestamps: true }
);

module.exports = mongoose.model("Withdrawal", withdrawalSchema);