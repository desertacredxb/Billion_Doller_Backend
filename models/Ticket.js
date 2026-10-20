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
    subject: { type: String, required: true, trim: true, minlength: 3, maxlength: 160 },
    description: { type: String, required: true, trim: true, minlength: 10, maxlength: 5000 },
    requestId: { type: String, maxlength: 80 },
    notificationStatus: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending" },
    notificationAttempts: { type: Number, default: 0 },
    notificationNextAttemptAt: { type: Date, default: Date.now },
    notificationAttemptedAt: Date,
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

ticketSchema.index({ user: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });
module.exports = mongoose.model("Ticket", ticketSchema);
