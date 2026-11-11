const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
}, { timestamps: true });

module.exports = mongoose.model("CrmAgentDraft", schema);
