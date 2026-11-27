const mongoose = require("mongoose");
const id = mongoose.Schema.Types.ObjectId;
const schema = new mongoose.Schema({
  _id: String, agent: { type: id, required: true }, user: { type: id, required: true },
  broker: { type: id, required: true }, accountNo: { type: Number, required: true },
  cents: { type: Number, required: true }, state: { type: String, enum: ["reserved", "submitting", "review", "failed", "completed"], required: true },
  open: { type: Boolean, required: true }, ticket: String,
}, { timestamps: true });
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { open: true } });
module.exports = mongoose.model("CrmIbTransfer", schema);
