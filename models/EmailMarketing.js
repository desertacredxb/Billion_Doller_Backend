const mongoose = require("mongoose");
const subscriber = new mongoose.Schema({
  publicId: { type: String, required: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  email: { type: String, required: true }, active: { type: Boolean, default: true }, held: { type: Boolean, default: false },
  consentAt: { type: Date, required: true }, consentVersion: { type: String, required: true },
  unsubscribedAt: Date, nextDay: { type: Number, default: 0 }, nextAt: { type: Date, required: true },
}, { timestamps: true });
subscriber.index({ publicId: 1 }, { unique: true }); subscriber.index({ email: 1 }, { unique: true }); subscriber.index({ userId: 1 }, { unique: true });
subscriber.index({ active: 1, held: 1, nextAt: 1 });
const delivery = new mongoose.Schema({ subscriberId: { type: mongoose.Schema.Types.ObjectId, required: true }, day: { type: Number, required: true },
  status: { type: String, enum: ["sending", "accepted", "unknown", "skipped", "cancelled"], required: true }, reservedAt: Date, acceptedAt: Date,
}, { timestamps: true });
delivery.index({ subscriberId: 1, day: 1 }, { unique: true });
delivery.index({ reservedAt: 1 });
const state = new mongoose.Schema({ _id: String, paused: { type: Boolean, default: true }, leaseToken: String, leaseUntil: Date,
  lastSlot: Number, budgetDate: String, reservedToday: { type: Number, default: 0 }, lastSyncAt: Date, lastRunAt: Date,
  lastOutcome: String, lastError: String }, { timestamps: true });
module.exports = { Subscriber: mongoose.model("EmailMarketingSubscriber", subscriber), Delivery: mongoose.model("EmailMarketingDelivery", delivery), State: mongoose.model("EmailMarketingState", state) };
