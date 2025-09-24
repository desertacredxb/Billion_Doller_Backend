// models/Ticket.js
const mongoose = require("mongoose");

const ticketSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    category: {
      type: String,
      enum: [
        "Deposit/Withdrawal",
        "Account-verification",
        "MT5 Support",
        "IB Commission",
        "Bonous&Other Promotion",
        "Others",
      ],
      default: "Others",
    },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    status: {
      type: String,
      enum: ["Open", "Pending", "Closed"],
      default: "Open",
    },

    // NEW: unread counters
    unreadByUser: { type: Number, default: 0 }, // messages from Admin not yet read by User
    unreadByAdmin: { type: Number, default: 0 }, // messages from User not yet read by Admin
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ticket", ticketSchema);
