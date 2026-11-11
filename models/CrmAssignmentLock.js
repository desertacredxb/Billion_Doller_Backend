const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: String,
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

module.exports = mongoose.model("CrmAssignmentLock", schema);
