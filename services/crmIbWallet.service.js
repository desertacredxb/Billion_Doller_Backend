const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const Staff = require("../models/AdminAccount");
const Broker = require("../models/Broker.model");
const User = require("../models/User");
const Account = require("../models/account.model");
const Transfer = require("../models/CrmIbTransfer");
const mt5 = require("../utils/MT5/mt5Balance");
const { CrmError, asId, staffFilter, assertRequestId } = require("./crm.service");

const eligible = { isApprovedIB: true, isVerified: true, portalBlocked: { $ne: true }, portalAccessStatus: { $ne: "rejected" } };
const accountScope = user => ({ user, accountType: "LIVE", userType: "CLIENT", currency: "USD" });
const summary = row => ({ reference: row._id, accountNo: row.accountNo, amount: row.cents / 100, state: row.state, updatedAt: row.updatedAt });

async function identity(agentId, session = null) {
  const agent = await Staff.findOne({ ...staffFilter, _id: asId(agentId) }).select("email crmIbId crmIbWallet").session(session).lean();
  if (!agent?.crmIbId) return null;
  const broker = await Broker.findOne({ _id: agent.crmIbId, status: "approved" }).select("email user referralCode").session(session).lean();
  if (!broker || broker.email?.trim().toLowerCase() !== agent.email.trim().toLowerCase()) return null;
  // CRM financial authority comes from the same OTP-confirmed mailbox as the IB owner.
  const users = await User.find({ ...eligible, ...(broker.user ? { _id: broker.user } : {}), email: agent.email })
    .collation({ locale: "en", strength: 2 }).limit(2).select("_id commission").session(session).lean();
  if (users.length !== 1) return null;
  return { broker, user: users[0], enabled: !!agent.crmIbWallet && String(agent.crmIbWallet) === String(broker._id) };
}

async function configure(agentId, enabled) {
  if (typeof enabled !== "boolean") throw new CrmError(400, "Choose whether commission transfers are enabled.");
  const filter = { ...staffFilter, _id: asId(agentId) };
  if (!enabled) {
    await Staff.updateOne(filter, { $unset: { crmIbWallet: "" } });
    return;
  }
  const own = await identity(agentId);
  if (!own) throw new CrmError(409, "Link the approved IB that belongs to this agent’s verified CRM email first.");
  const saved = await Staff.updateOne({ ...filter, crmIbId: own.broker._id }, { $set: { crmIbWallet: own.broker._id } });
  if (!saved.matchedCount) throw new CrmError(409, "The IB mapping changed. Refresh the CRM.");
}

async function overview(agentId) {
  const own = await identity(agentId);
  if (!own) return { belongsToAgent: false };
  const [accounts, recent] = await Promise.all([
    Account.find(accountScope(own.user._id)).select("accountNo").sort({ accountNo: 1 }).lean(),
    Transfer.find({ agent: asId(agentId), user: own.user._id }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  return { belongsToAgent: true, enabled: own.enabled, balance: own.user.commission || 0,
    accounts: accounts.map(row => row.accountNo), recent: recent.map(summary) };
}

async function transfer(principal, input) {
  if (principal.adminRole !== "manager" || !principal.permissions?.includes("crm")) throw new CrmError(403, "Sign in with your own CRM agent account.");
  assertRequestId(input?.requestId);
  if (typeof input.amount !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0 ||
      typeof input.accountNo !== "string" || !/^\d{1,15}$/.test(input.accountNo)) throw new CrmError(400, "Enter a valid USD amount and your trading account.");
  const agent = asId(principal.id), cents = Math.round(Number(input.amount) * 100), accountNo = Number(input.accountNo);
  const owner = await identity(principal.id);
  if (!owner?.enabled) throw new CrmError(403, "Commission transfers are not enabled for this IB.");
  const id = input.requestId;
  function check(row) {
    if (String(row.agent) !== String(agent) || String(row.user) !== String(owner.user._id) || String(row.broker) !== String(owner.broker._id) ||
        row.accountNo !== accountNo || row.cents !== cents) throw new CrmError(409, "This transfer reference is already in use.");
    return row;
  }
  // An open reservation blocks a new request across tabs and restarts, including an uncertain MT5 response.
  await Transfer.collection.createIndex({ user: 1 }, { unique: true, partialFilterExpression: { open: true } });
  let record;
  try {
    record = await mongoose.connection.transaction(async session => {
      const own = await identity(principal.id, session);
      if (!own?.enabled || String(own.user._id) !== String(owner.user._id)) throw new CrmError(403, "Refresh your IB access.");
      const prior = await Transfer.findById(id).session(session).lean();
      if (prior) return check(prior);
      if (!await Account.exists({ ...accountScope(own.user._id), accountNo }).session(session)) throw new CrmError(403, "Select your own live USD account.");
      const debited = await User.updateOne({ _id: own.user._id, ...eligible, commission: { $gte: Math.max(75, cents / 100) } },
        { $inc: { commission: -cents / 100 } }, { session });
      if (!debited.modifiedCount) throw new CrmError(409, "A minimum available balance of USD 75 and enough commission for this transfer are required.");
      const [row] = await Transfer.create([{ _id: id, agent, user: own.user._id, broker: own.broker._id, cents, accountNo, state: "reserved", open: true }], { session });
      return row.toObject();
    }, { writeConcern: { w: "majority" } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const prior = await Transfer.findById(id).lean();
    if (!prior) throw new CrmError(409, "Another transfer is pending for this IB.");
    record = check(prior);
  }
  if (record.state !== "reserved") return summary(record);
  const claim = await Transfer.findOneAndUpdate({ _id: id, state: "reserved" }, { $set: { state: "submitting" } },
    { new: true, writeConcern: { w: "majority", j: true } }).lean();
  if (!claim) return summary(check(await Transfer.findById(id).lean()));
  let ticket;
  let submitted = false;
  try {
    const comment = "CRM IB " + createHash("sha256").update(id).digest("hex").slice(0, 22);
    const answer = await mt5.updateMT5Balance({ login: String(accountNo), type: 2, balance: cents / 100, comment, onSubmitting: () => { submitted = true; } });
    if (!/^0(?:\s+Done)?$/i.test(String(answer?.retcode ?? ""))) throw new Error("Unconfirmed MT5 response");
    ticket = String(answer.ticket || "");
  } catch {
    if (!submitted) {
      const failed = await mongoose.connection.transaction(async session => {
        const changed = await Transfer.findOneAndUpdate({ _id: id, state: "submitting" }, { $set: { state: "failed", open: false } }, { session, new: true }).lean();
        if (changed) await User.updateOne({ _id: claim.user }, { $inc: { commission: cents / 100 } }, { session });
        return changed;
      }, { writeConcern: { w: "majority" } });
      return summary(failed);
    }
    const pending = await Transfer.findByIdAndUpdate(id, { $set: { state: "review" } }, { new: true }).lean();
    return summary(pending);
  }
  const completed = await mongoose.connection.transaction(async session => {
    await User.updateOne({ _id: claim.user }, { $set: { lastWithdrawalDate: new Date() } }, { session });
    return Transfer.findOneAndUpdate({ _id: id, state: "submitting" },
      { $set: { state: "completed", open: false, ticket } }, { session, new: true }).lean();
  }, { writeConcern: { w: "majority" } });
  return summary(completed);
}

module.exports = { overview, configure, transfer };
