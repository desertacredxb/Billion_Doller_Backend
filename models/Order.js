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
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
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
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
