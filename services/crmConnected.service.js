const Call = require("../models/CrmCall");
const Lead = require("../models/CrmLead");
const target = 90;
async function confirmedCounts(start, end, ids) {
  const range = { $gte: start, $lt: end };
  return Call.aggregate([
      { $match: { ...(ids ? { agent: { $in: ids } } : {}), kind: { $in: ["hashmi", "indiavoice"] }, connected: true, $or: [
        { customerAnsweredAt: range }, { customerAnsweredAt: null, occurredAt: range },
      ] } },
      { $lookup: { from: Lead.collection.name, localField: "lead", foreignField: "_id", as: "leadRow", pipeline: [{ $project: { phone: 1 } }] } },
      { $project: { agent: 1, day: { $dateToString: { date: { $ifNull: ["$customerAnsweredAt", "$occurredAt"] }, timezone: "Asia/Dubai", format: "%Y-%m-%d" } }, phone: { $ifNull: ["$customerPhone", { $arrayElemAt: ["$leadRow.phone", 0] }, ""] } } },
      { $group: { _id: { agent: "$agent", day: "$day", phone: "$phone" }, calls: { $sum: 1 } } },
      { $set: { known: { $regexMatch: { input: "$_id.phone", regex: "^\\+[1-9][0-9]{6,14}$" } } } },
      { $group: { _id: { agent: "$_id.agent", day: "$_id.day" }, unique: { $sum: { $cond: ["$known", 1, 0] } },
        repeats: { $sum: { $cond: ["$known", { $subtract: ["$calls", 1] }, 0] } },
        unresolved: { $sum: { $cond: ["$known", 0, "$calls"] } } } },
    ]);
}
module.exports = { confirmedCounts, target };
