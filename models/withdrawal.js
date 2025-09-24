const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    orderid: { type: String, required: true, unique: true },
    account: String,
    ifsc: String,
    name: String,
    mobile: String,
    amount: Number,
    note: String,
    accountNo: { type: String, required: true },

    // 🔹 Use string enum instead of boolean
    status: {
      type: String,
      enum: ["Pending", "Completed", "Failed", "Rejected"],
      default: "Pending",
    },

    response: Object, // store decrypted response from RameePay
  },
  { timestamps: true }
);

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
