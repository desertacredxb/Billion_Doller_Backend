const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: String,
  agent: { type: mongoose.Schema.Types.ObjectId, required: true },
  effectiveFrom: { type: String, required: true },
  currency: { type: String, required: true },
  dailyMinor: { type: Number, required: true },
}, { timestamps: true });
schema.index({ agent: 1, effectiveFrom: -1 }, { unique: true });
module.exports = mongoose.model("CrmPayRate", schema);
