const mongoose = require("mongoose");
const Lead = require("../models/CrmLead");
const Distribution = require("../models/CrmDistribution");
const { asId, assertRequestId, CrmError, unassignedFilter, activeStaff } = require("./crm.service");

const available = { ...unassignedFilter, lastOutcome: null };

async function sources() {
  return Lead.aggregate([
    { $match: available },
    { $group: { _id: { $ifNull: ["$source", ""] }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
}

function validate(input) {
  assertRequestId(input?.requestId);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000 ||
      typeof input.source !== "string" || input.source.length > 100 ||
      !Array.isArray(input.agents) || input.agents.length === 0 || input.agents.length > 100) {
    throw new CrmError(400, "Select agents, a source and 1–1,000 numbers.");
  }
  const agents = input.agents.map(value => String(asId(value)));
  if (new Set(agents).size !== agents.length) throw new CrmError(400, "Select each agent once.");
  return agents;
}

async function assign(principal, input) {
  const agents = validate(input);
  const owner = asId(principal.id);
  const { source, quantity, requestId } = input;
  const result = record => {
    if (String(record.owner) !== String(owner) || record.source !== source || record.quantity !== quantity ||
        record.agents.map(String).join() !== agents.join()) throw new CrmError(409, "This request already belongs to another distribution.");
    return { assigned: record.assigned, counts: record.counts };
  };
  try {
    return await mongoose.connection.transaction(async session => {
      const prior = await Distribution.findById(requestId).session(session).lean();
      if (prior) return result(prior);
      const eligible = new Set((await activeStaff(true).session(session)).map(agent => String(agent._id)));
      if (agents.some(id => !eligible.has(id))) throw new CrmError(409, "Refresh the team and select active agents with mapped dialers.");
      const filter = source ? { ...available, source } : available;
      // Use reserved stock first, then ordinary unassigned stock. Never take another agent's lead.
      const leads = await Lead.find(filter).sort({ manualDistributionOnly: -1, registeredAt: -1, createdAt: 1, _id: 1 })
        .select("_id").limit(quantity).session(session).lean();
      const counts = agents.map(() => 0);
      const now = new Date();
      const updates = leads.map((lead, index) => {
        const seat = index % agents.length;
        counts[seat]++;
        return { updateOne: { filter: { ...filter, _id: lead._id }, update: {
          $set: { assignedTo: asId(agents[seat]), assignedAt: now }, $unset: { manualDistributionOnly: "" },
        } } };
      });
      if (updates.length) {
        const updated = await Lead.bulkWrite(updates, { session });
        if (updated.modifiedCount !== leads.length) throw new CrmError(409, "Available leads changed. Try the distribution again.");
      }
      const record = { _id: requestId, owner, source, quantity, agents, assigned: leads.length, counts };
      await Distribution.create([record], { session });
      return result(record);
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const prior = await Distribution.findById(requestId).lean();
    if (!prior) throw error;
    return result(prior);
  }
}

module.exports = { assign, sources, validate };
