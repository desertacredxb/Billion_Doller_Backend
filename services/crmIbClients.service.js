const IB = require("../models/Broker.model");
const User = require("../models/User");
const Staff = require("../models/AdminAccount");
const { CrmError, asId, staffFilter, staffScope, pageNumber, searchFilter } = require("./crm.service");

const key = value => String(value || "").trim().toLowerCase();

function resolveLinks(agents, brokers) {
  const byId = new Map(brokers.map(broker => [String(broker._id), broker]));
  const byEmail = new Map();
  for (const broker of brokers) {
    const email = key(broker.email);
    byEmail.set(email, byEmail.has(email) ? null : broker);
  }
  const links = [];
  const claimed = new Set(agents.filter(agent => agent.crmIbId).map(agent => String(agent.crmIbId)));
  for (const agent of agents) {
    const broker = agent.crmIbId ? byId.get(String(agent.crmIbId)) : byEmail.get(key(agent.email));
    if (broker && (agent.crmIbId || !claimed.has(String(broker._id)))) links.push({ agent, broker });
  }
  return links;
}

async function listIbClients(principal, query) {
  const scope = staffScope(principal);
  const selected = scope.assignedTo || (query.agent ? asId(query.agent) : null);
  const page = pageNumber(query.page);
  const limit = 50;
  const agents = await Staff.find(staffFilter).select("_id fullName email crmIbId").lean();
  const brokers = await IB.find({ status: "approved", $or: [
    { email: { $in: agents.map(agent => agent.email) } },
    { _id: { $in: agents.map(agent => agent.crmIbId).filter(Boolean) } },
  ] }).collation({ locale: "en", strength: 2 }).select("_id email referralCode").lean();
  const links = resolveLinks(agents, brokers).filter(({ agent }) => !selected || String(agent._id) === String(selected));
  const result = { rows: [], total: 0, page, limit, linkedAgents: links.length,
    ...(selected && principal.adminRole === "owner" ? { referralCode: links[0]?.broker.referralCode || "" } : {}) };
  if (!links.length) return result;

  const byId = new Map(links.map(link => [String(link.broker._id), link]));
  const byCode = new Map(links.filter(link => link.broker.referralCode).map(link => [link.broker.referralCode, link]));
  // Follow the IB portal's stable link first. Only legacy signups use the original referral code.
  const referrals = { $or: [{ referredByIB: { $in: links.map(link => link.broker._id) } },
    { referredByIB: null, referralCode: { $in: [...byCode.keys()] } }] };
  const filter = { $and: [referrals, searchFilter(query.search, ["fullName", "email", "phone"])] };
  const [clients, total] = await Promise.all([
    User.find(filter).select("fullName email phone createdAt isVerified referredByIB referralCode")
      .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  result.total = total;
  result.rows = clients.map(client => {
    const { agent } = client.referredByIB ? byId.get(String(client.referredByIB)) : byCode.get(client.referralCode);
    return { id: String(client._id), name: client.fullName, email: client.email, phone: client.phone,
      registeredAt: client.createdAt, verified: client.isVerified === true, agentName: agent.fullName || agent.email };
  });
  return result;
}

async function linkIb(id, code) {
  if (typeof code !== "string" || !/^[a-z\d_-]{1,100}$/i.test(code.trim())) throw new CrmError(400, "Enter an IB referral code.");
  const matches = await IB.find({ status: "approved", referralCode: code.trim() })
    .collation({ locale: "en", strength: 2 }).limit(2).select("_id email").lean();
  if (matches.length !== 1) throw new CrmError(400, "The code must identify one approved IB.");
  const broker = matches[0];
  const agentId = asId(id);
  if (await Staff.exists({ _id: { $ne: agentId }, email: key(broker.email) })) {
    throw new CrmError(409, "This IB email belongs to another staff user.");
  }
  await Staff.collection.createIndex({ crmIbId: 1 }, { unique: true, sparse: true });
  try {
    const result = await Staff.updateOne({ ...staffFilter, _id: agentId }, { $set: { crmIbId: broker._id } });
    if (!result.matchedCount) throw new CrmError(404, "Active CRM agent not found.");
  } catch (error) {
    if (error.code === 11000) throw new CrmError(409, "This IB is already linked to another CRM agent.");
    throw error;
  }
}

module.exports = { listIbClients, linkIb, resolveLinks };
