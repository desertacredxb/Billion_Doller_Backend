const User = require("../models/User");
const Account = require("../models/account.model");
const IB = require("../models/Broker.model");
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Ticket = require("../models/Ticket");
const Enquiry = require("../models/Enquiry");
const AuditLog = require("../models/AuditLog");

function dubaiDateRange(from, to = from, now = new Date()) {
  const today = new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
  from ||= today; to ||= from;
  for (const value of [from, to]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Choose valid report dates.");
  }
  const start = new Date(`${from}T00:00:00+04:00`);
  const end = new Date(new Date(`${to}T00:00:00+04:00`).getTime() + 86400000);
  if (end <= start || end - start > 366 * 86400000) throw new Error("Choose a date range of up to 366 days, with the end after the start.");
  return { from, to, start, end, timezone: "Asia/Dubai" };
}

function createController({ users = User, accounts = Account, ibs = IB, orders = Order, withdrawals = Withdrawal, tickets = Ticket, enquiries = Enquiry, logs = AuditLog, now = () => new Date() } = {}) {
  const queueFilters = {
    pendingKyc: { isVerified: true, isKycVerified: false },
    pendingIb: { status: "pending" },
    pendingBank: { bankApprovalStatus: "pending" },
    pendingPayouts: { status: { $in: ["Pending", "Processing"] } },
    openTickets: { status: { $in: ["Open", "Pending"] } },
    newEnquiries: { status: "new" },
  };
  const queues = async () => {
    const values = await Promise.all([users.countDocuments(queueFilters.pendingKyc), ibs.countDocuments(queueFilters.pendingIb), users.countDocuments(queueFilters.pendingBank), withdrawals.countDocuments(queueFilters.pendingPayouts), tickets.countDocuments(queueFilters.openTickets), enquiries.countDocuments(queueFilters.newEnquiries)]);
    return Object.fromEntries(Object.keys(queueFilters).map((key, index) => [key, values[index]]));
  };
  return {
    async onboarding(req, res, next) {
      try {
        const user = await users.findById(req.principal.id).select("isVerified isKycVerified veriff.status kycProvider").lean();
        if (!user) return res.status(404).json({ message: "Account not found." });
        const ownAccounts = await accounts.find({ user: req.principal.id, accountType: "LIVE" }).select("_id accountNo").lean();
        const accountNumbers = ownAccounts.map(account => String(account.accountNo));
        const [deposit, ib] = await Promise.all([
          ownAccounts.length ? orders.exists({ $or: [{ account: { $in: ownAccounts.map(account => account._id) } }, { accountNo: { $in: accountNumbers } }], status: "SUCCESS" }) : null,
          ibs.findOne({ email: req.principal.email }).select("status").lean(),
        ]);
        res.json({ emailVerified: !!user.isVerified, identityVerified: !!user.isKycVerified, identityStatus: user.veriff?.status || (user.isKycVerified ? "approved" : "not_started"), identityProvider: user.kycProvider, tradingAccountCreated: ownAccounts.length > 0, firstDepositCompleted: !!deposit, ibStatus: ib?.status || "not_applied" });
      } catch (error) { next(error); }
    },
    async overview(_req, res, next) { try { res.json({ generatedAt: now(), queues: await queues() }); } catch (error) { next(error); } },
    async report(req, res, next) {
      try {
        let range;
        try { range = dubaiDateRange(req.query.from || req.query.date, req.query.to, now()); } catch (error) { return res.status(400).json({ message: error.message }); }
        const createdAt = { $gte: range.start, $lt: range.end };
        const [registrations, newTradingAccounts, ibApplications, newEnquiries, newTickets, depositOrders, payoutRequests, countries, currentQueues] = await Promise.all([
          users.countDocuments({ createdAt, isVerified: true }),
          accounts.countDocuments({ createdAt, accountType: "LIVE" }),
          ibs.countDocuments({ createdAt }), enquiries.countDocuments({ createdAt }), tickets.countDocuments({ createdAt }),
          orders.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
          withdrawals.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
          users.aggregate([{ $match: { createdAt, isVerified: true } }, { $group: { _id: { $ifNull: ["$residenceCountry", { $ifNull: ["$nationality", "Unspecified"] }] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 30 }]), queues(),
        ]);
        res.json({ generatedAt: now(), period: { from: range.from, to: range.to, timezone: range.timezone, start: range.start, endExclusive: range.end },
          registrations, newTradingAccounts, ibApplications, newEnquiries, newTickets,
          depositOrders: depositOrders.map(row => ({ status: row._id, count: row.count })), payoutRequests: payoutRequests.map(row => ({ status: row._id, count: row.count })),
          countries: countries.map(row => ({ country: row._id || "Unspecified", count: row.count })), queues: currentQueues,
          note: "Period totals count records created during the selected Dubai dates. Payment statuses reflect their current state. Work queues are a current snapshot. Country values are self-reported. Monetary totals are excluded because payment currencies differ." });
      } catch (error) { next(error); }
    },
    async audit(req, res, next) {
      try {
        const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1)), limit = 50;
        const [data, total] = await Promise.all([logs.find({}).sort({ occurredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), logs.countDocuments({})]);
        res.json({ data, total, page, pages: Math.ceil(total / limit) });
      } catch (error) { next(error); }
    },
  };
}
module.exports = { createController, dubaiDateRange };
