const mongoose = require("mongoose");

module.exports = mongoose.model("CrmDistribution", new mongoose.Schema({
  _id: String,
  owner: { type: mongoose.Schema.Types.ObjectId, required: true },
  source: String,
  quantity: Number,
  agents: [mongoose.Schema.Types.ObjectId],
  assigned: Number,
  counts: [Number],
}, { timestamps: true }));
