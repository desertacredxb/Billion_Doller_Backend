const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  requestId: { type: String, required: true },
  actorId: { type: String, required: true },
  actorEmail: { type: String, required: true },
  actorName: String,
  event: String,
  details: { changedFields: [String], permissions: [String], enabled: Boolean },
  method: String, resource: String, route: String, targetId: String,
  statusCode: Number,
  occurredAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });
module.exports = mongoose.model("AuditLog", schema);
