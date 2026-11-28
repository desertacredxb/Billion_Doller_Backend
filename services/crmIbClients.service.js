const IB = require("../models/Broker.model");
const User = require("../models/User");
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Account = require("../models/account.model");
const Staff = require("../models/AdminAccount");
const ibWallet = require("./crmIbWallet.service");
const { CrmError, asId, staffFilter, staffScope, dubaiDay, pageNumber, searchFilter } = require("./crm.service");

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

function emptyActivity() {
  return { deposits: 0, creditedUsd: 0, unpricedDeposits: 0, withdrawals: 0, paid: {} };
}

async function paymentActivity(referrals, range) {
  const createdAt = { $gte: range.start, $lt: range.end };
  const clientJoin = [
    { $lookup: { from: User.collection.name, localField: "trading.user", foreignField: "_id",
      pipeline: [{ $match: referrals }, { $project: { _id: 1 } }], as: "client" } },
    { $unwind: "$client" },
  ];
  // Use the immutable order account when available. Older orders sometimes only carry the MT5 login.
  function accountJoin(deposit) {
    const checkOwner = deposit
      ? { $or: [{ $eq: [{ $ifNull: ["$account", null] }, null] }, { $eq: ["$account", "$trading._id"] }] }
      : { $or: [{ $eq: [{ $ifNull: ["$userId", null] }, null] }, { $eq: ["$userId", "$trading.user"] }] };
    return [
      { $set: { login: { $convert: { input: "$accountNo", to: "long", onError: null, onNull: null } } } },
      { $lookup: { from: Account.collection.name, localField: "login", foreignField: "accountNo",
        pipeline: [{ $match: { accountType: "LIVE", userType: { $ne: "ADMIN" } } }, { $project: { user: 1 } }], as: "trading" } },
      { $unwind: "$trading" }, { $match: { $expr: checkOwner } }, ...clientJoin,
    ];
  }
  const credited = { $gt: [{ $ifNull: ["$creditedAmount", 0] }, 0] };
  const [deposits, withdrawals] = await Promise.all([
    Order.aggregate([{ $match: { createdAt, $or: [{ status: "SUCCESS" }, { status: "PARTIALLY_PAID", creditedAmount: { $gt: 0 } }] } },
      ...accountJoin(true), { $group: { _id: "$client._id", count: { $sum: 1 },
        cents: { $sum: { $cond: [credited, { $round: [{ $multiply: ["$creditedAmount", 100] }, 0] }, 0] } },
        missing: { $sum: { $cond: [credited, 0, 1] } } } }]).option({ maxTimeMS: 12000 }),
    Withdrawal.aggregate([{ $match: { createdAt, status: "Completed" } }, ...accountJoin(false),
      { $group: { _id: { user: "$client._id", currency: { $cond: [{ $eq: ["$currency", "CRYPTO"] },
        { $ifNull: ["$cryptoSymbol", "CRYPTO"] }, { $ifNull: ["$currency", "Unknown"] }] } },
        count: { $sum: 1 }, amount: { $sum: "$amount" } } }]).option({ maxTimeMS: 12000 }),
  ]);
  const clients = new Map();
  const totals = emptyActivity();
  function activity(id) {
    const key = String(id);
    if (!clients.has(key)) clients.set(key, emptyActivity());
    return clients.get(key);
  }
  let totalCents = 0;
  for (const row of deposits) {
    const client = activity(row._id);
    client.deposits = row.count;
    client.creditedUsd = row.cents / 100;
    client.unpricedDeposits = row.missing;
    totals.deposits += row.count;
    totalCents += row.cents;
    totals.unpricedDeposits += row.missing;
  }
  totals.creditedUsd = totalCents / 100;
  for (const row of withdrawals) {
    const currency = /^[A-Z0-9]{2,12}$/.test(row._id.currency) ? row._id.currency : "Unknown";
    for (const dest of [activity(row._id.user), totals]) {
      dest.withdrawals += row.count;
      dest.paid[currency] = (dest.paid[currency] || 0) + row.amount;
    }
  }
  return { clients, totals };
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
  if (scope.assignedTo && principal.adminRole === "manager" && principal.permissions?.includes("crm") && links.length === 1) {
    result.myReferralCode = links[0].broker.referralCode || "";
    if (links[0].agent.crmIbId) {
      const own = await ibWallet.identity(principal.id);
      result.ownDashboard = !!own && String(own.broker._id) === String(links[0].broker._id);
    }
  }
  const range = query.day === undefined ? null : dubaiDay(query.day);
  if (range) result.activity = { day: range.day, newRegistrations: 0, ...emptyActivity() };
  if (!links.length) return result;

  const byId = new Map(links.map(link => [String(link.broker._id), link]));
  const byCode = new Map(links.filter(link => link.broker.referralCode).map(link => [link.broker.referralCode, link]));
  // Follow the IB portal's stable link first. Only legacy signups use the original referral code.
  const referrals = { $or: [{ referredByIB: { $in: links.map(link => link.broker._id) } },
    { referredByIB: null, referralCode: { $in: [...byCode.keys()] } }] };
  const filter = { $and: [referrals, searchFilter(query.search, ["fullName", "email", "phone"])] };
  const clientPage = User.find(filter).select("fullName email phone createdAt isVerified referredByIB referralCode")
    .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit);
  if (result.ownDashboard) clientPage.select("isKycVerified").populate({ path: "accounts", select: "accountNo user" });
  const [clients, total, payments, newRegistrations] = await Promise.all([
    clientPage.lean(),
    User.countDocuments(filter),
    range ? paymentActivity(referrals, range) : null,
    range ? User.countDocuments({ ...referrals, isVerified: true, createdAt: { $gte: range.start, $lt: range.end } }) : 0,
  ]);
  if (range) result.activity = { day: range.day, newRegistrations, ...payments.totals };
  result.total = total;
  result.rows = clients.map(client => {
    const { agent } = client.referredByIB ? byId.get(String(client.referredByIB)) : byCode.get(client.referralCode);
    return { id: String(client._id), name: client.fullName, email: client.email, phone: client.phone,
      ...(result.ownDashboard ? { isKycVerified: client.isKycVerified === true,
        tradingAccounts: (client.accounts || []).map(account => account.accountNo) } : {}),
      ...(payments ? { activity: payments.clients.get(String(client._id)) || emptyActivity() } : {}),
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
