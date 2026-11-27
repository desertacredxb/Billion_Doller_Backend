const mongoose = require("mongoose");
const Staff = require("../models/AdminAccount");
const Call = require("../models/CrmCall");
const Lead = require("../models/CrmLead");
const { ensureCrmIndexes, staffFilter, bankFilter, formatLead, recordOutcome, distribute } = require("./crm.service");

async function allocate(eventKey, requester, session) {
  const event = await Call.findOne({ eventKey, kind: "outcome" }, null, { session })
    .select("refillState refillAgent refillLead lead").lean();
  if (!event?.refillState) return { state: "none" };
  let lead;
  if (event.refillState === "pending") {
    if (!await Staff.exists({ ...staffFilter, _id: event.refillAgent }).session(session)) return { state: "inactive" };
    lead = await Lead.findOneAndUpdate({ ...bankFilter, _id: { $ne: event.lead }, lastOutcome: null },
      { $set: { assignedTo: event.refillAgent, assignedAt: new Date() } },
      { sort: { registeredAt: -1, createdAt: 1, _id: 1 }, new: true, session }).lean();
    if (!lead) return { state: "pending" };
    await Call.updateOne({ _id: event._id, refillState: "pending" },
      { $set: { refillState: "assigned", refillLead: lead._id } }, { session });
  } else if (requester && String(event.refillAgent) === String(requester)) {
    lead = await Lead.findOne({ _id: event.refillLead, assignedTo: event.refillAgent, status: "new", lastOutcome: null }, null, { session }).lean();
  }
  return { state: "assigned", ...(lead && requester && String(event.refillAgent) === String(requester) ? { lead: formatLead(lead) } : {}) };
}

async function saveOutcome(principal, id, body) {
  await ensureCrmIndexes(Call);
  const save = () => mongoose.connection.transaction(async session => {
    const result = await recordOutcome(principal, id, body, session);
    const replacement = await allocate("outcome:" + body.requestId, principal.id, session);
    return { ...result, refreshQueue: true, replacement };
  });
  try { return await save(); }
  catch (error) {
    if (error.code !== 11000) throw error;
    return save(); // A concurrent retry may have just inserted the same outcome key.
  }
}

async function distributeWithRefills() {
  const pending = { refillState: "pending" };
  if (await Call.exists(pending)) {
    const active = await Staff.distinct("_id", staffFilter);
    const events = await Call.find({ ...pending, refillAgent: { $in: active } }).sort({ occurredAt: 1, _id: 1 })
      .limit(100).select("eventKey").lean();
    for (const event of events) {
      const result = await mongoose.connection.transaction(session => allocate(event.eventKey, null, session));
      if (result.state === "pending") break;
    }
  }
  return distribute();
}

module.exports = { allocate, saveOutcome, distributeWithRefills };
