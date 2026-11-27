const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: String,
  agent: { type: mongoose.Schema.Types.ObjectId, required: true },
  version: Number,
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  reason: { type: String, enum: ["expiry", "sign_out", "new_login", "revoked"] },
});
schema.index({ agent: 1, start: -1 });
module.exports = mongoose.model("CrmShift", schema);
