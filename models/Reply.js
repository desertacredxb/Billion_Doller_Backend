// models/Reply.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    ticket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ticket",
      required: true,
    },
    senderType: {
      type: String,
      enum: ["User", "Admin"],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    requestId: { type: String, maxlength: 80 },
    attachments: [String], // Optional: Array of file URLs if needed

    // NEW: read flags
    readByUser: { type: Boolean, default: false }, // has the User read this message?
    readByAdmin: { type: Boolean, default: false }, // has the Admin read this message?
  },
  { timestamps: true }
);

messageSchema.index({ ticket: 1, senderType: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });
module.exports = mongoose.model("Message", messageSchema);
