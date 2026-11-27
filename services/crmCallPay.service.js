const { confirmedCounts, target } = require("./crmConnected.service");
const Staff = require("../models/AdminAccount");
const Rate = require("../models/CrmPayRate");
const { CrmError, asId, dubaiDay, staffFilter } = require("./crm.service");

function credit(unique, rate) {
  const units = Math.min(unique, target);
  return { units, target, payMinor: rate ? Math.round(rate.dailyMinor * units / target) : null };
}

async function saveRate(agentId, input) {
  const agent = asId(agentId);
  if (typeof input?.effectiveFrom !== "string" || !input.effectiveFrom || !await Staff.exists({ ...staffFilter, _id: agent })) {
    throw new CrmError(400, "Select an active CRM agent and an effective date.");
  }
  const { day } = dubaiDay(input.effectiveFrom);
  const currency = input.currency;
  if (typeof currency !== "string" || !Intl.supportedValuesOf("currency").includes(currency)) throw new CrmError(400, "Enter a valid currency code.");
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  if (typeof input.daily !== "string" || !/^\d{1,9}(?:\.\d{1,4})?$/.test(input.daily) || (input.daily.split(".")[1] || "").length > decimals) {
    throw new CrmError(400, "Enter a valid daily rate in the selected currency.");
  }
  const dailyMinor = Math.round(Number(input.daily) * 10 ** decimals);
  if (dailyMinor <= 0 || !Number.isSafeInteger(dailyMinor * target)) throw new CrmError(400, "Enter a positive daily rate.");
  const filter = { _id: String(agent) + ":" + day, agent, effectiveFrom: day };
  try {
    await Rate.updateOne(filter, { $setOnInsert: { ...filter, dailyMinor, currency } }, { upsert: true });
  } catch (err) { if (err.code !== 11000) throw err; }
  const saved = await Rate.findOne(filter).lean();
  if (saved?.dailyMinor !== dailyMinor || saved.currency !== currency) throw new CrmError(409, "A different rate already exists for that effective date.");
  return { saved: true };
}

async function daily(date) {
  const { day, start, end } = dubaiDay(date);
  const [calls, rates] = await Promise.all([
    confirmedCounts(start, end),
    Rate.aggregate([{ $match: { effectiveFrom: { $lte: day } } }, { $sort: { agent: 1, effectiveFrom: -1 } },
      { $group: { _id: "$agent", rate: { $first: "$$ROOT" } } }]),
  ]);
  const stats = new Map(calls.map(row => [String(row._id.agent), row]));
  const byAgent = new Map(rates.map(row => [String(row._id), row.rate]));
  const agents = await Staff.find({ $or: [staffFilter, { _id: { $in: [...calls.map(row => row._id.agent), ...rates.map(row => row._id)] } }] })
    .select("_id fullName email enabled").sort({ fullName: 1, _id: 1 }).lean();
  return { day, target, rows: agents.map(agent => {
    const id = String(agent._id), count = stats.get(id), rate = byAgent.get(id);
    const unique = count?.unique || 0;
    return { id, name: agent.fullName || agent.email, unique, repeats: count?.repeats || 0, unresolved: count?.unresolved || 0,
      ...credit(unique, rate), ...(rate ? { currency: rate.currency, dailyMinor: rate.dailyMinor, effectiveFrom: rate.effectiveFrom } : {}) };
  }) };
}
function monthlyTotals(days, rates) {
  const byAgent = new Map();
  const history = new Map();
  for (const rate of rates) {
    const key = String(rate.agent);
    if (!history.has(key)) history.set(key, []);
    history.get(key).push(rate);
  }
  for (const group of days) {
    const id = String(group._id.agent);
    const total = byAgent.get(id) || { unique: 0, repeat: 0, uncertain: 0, units: 0, missingRates: 0, amounts: {} };
    const rate = history.get(id)?.find(rate => rate.effectiveFrom <= group._id.day);
    const earned = credit(group.unique, rate);
    total.unique += group.unique;
    total.repeat += group.repeats;
    total.uncertain += group.unresolved;
    total.units += earned.units;
    if (rate) total.amounts[rate.currency] = (total.amounts[rate.currency] || 0) + earned.payMinor;
    else if (earned.units) total.missingRates++;
    byAgent.set(id, total);
  }
  return byAgent;
}

async function monthly(month) {
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) throw new CrmError(400, "Choose a valid Dubai payroll month.");
  const { start } = dubaiDay(month + "-01");
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0, 12)).toISOString().slice(0, 10);
  const { end } = dubaiDay(lastDay);
  const [days, rates] = await Promise.all([confirmedCounts(start, end), Rate.find({ effectiveFrom: { $lte: lastDay } }).sort({ effectiveFrom: -1 }).lean()]);
  const totals = monthlyTotals(days, rates);
  const agents = await Staff.find({ $or: [staffFilter, { _id: { $in: [...totals.keys(), ...rates.map(row => row.agent)] } }] })
    .select("_id fullName email").sort({ fullName: 1, _id: 1 }).lean();
  return { month, target, rows: agents.map(agent => ({ id: String(agent._id), name: agent.fullName || agent.email,
    ...(totals.get(String(agent._id)) || { unique: 0, repeat: 0, uncertain: 0, units: 0, missingRates: 0, amounts: {} }) })) };
}
module.exports = { daily, monthly, monthlyTotals, saveRate, credit };
