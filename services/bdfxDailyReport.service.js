const User = require("../models/User");
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Account = require("../models/account.model");
const Ticket = require("../models/Ticket");
const IB = require("../models/Broker.model");
const { createReportService } = require("./buddyReport.service");
const { dubaiDateRange } = require("../controllers/operationsController");

const KYC = ["approved", "not_started", "in_progress", "review", "declined", "resubmission_requested", "other_non_approved"];
const DEPOSIT = ["PENDING", "PARTIALLY_PAID", "SUCCESS", "FAILED"];
const PAYOUT = ["Pending", "Processing", "Completed", "Failed", "Rejected"];
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid aggregate count");
  return value;
}
function totals(rows, statuses) {
  const result = Object.fromEntries([...statuses, "other"].map(key => [key, 0]));
  for (const row of rows || []) result[statuses.includes(row._id) ? row._id : "other"] += count(row.count);
  return { total: Object.values(result).reduce((sum, value) => count(sum + value), 0), byStatus: result };
}
function clientTotals(rows) {
  const byStatus = totals(rows, KYC).byStatus;
  const total = Object.values(byStatus).reduce((sum, value) => count(sum + value), 0);
  return { total, kycApproved: byStatus.approved, kycNotApproved: total - byStatus.approved, byKycStatus: byStatus };
}
function bounded(query) {
  if (typeof query.option === "function") return query.option({ maxTimeMS: 10000 });
  if (typeof query.maxTimeMS === "function") return query.maxTimeMS(10000);
  return query;
}
const kycState = { $switch: { branches: [
  { case: { $eq: ["$isKycVerified", true] }, then: "approved" },
  { case: { $or: [{ $eq: ["$kycManualReview.approved", false] }, { $eq: ["$veriff.status", "declined"] }] }, then: "declined" },
  ...["review", "resubmission_requested"].map(status => ({ case: { $eq: ["$veriff.status", status] }, then: status })),
  { case: { $in: ["$veriff.status", ["created", "started", "submitted", "waiting", "resubmitted"]] }, then: "in_progress" },
  { case: { $and: [{ $ne: ["$hasSubmittedDocuments", true] }, { $in: [{ $ifNull: ["$veriff.status", "not_started"] }, ["not_started", ""]] }] }, then: "not_started" },
], default: "other_non_approved" } };

function createDailyReportService({ users = User, orders = Order, withdrawals = Withdrawal, accounts = Account,
  tickets = Ticket, ibs = IB, now = () => new Date(), buddy = createReportService({ now }) } = {}) {
  return async function dailyReport() {
    const at = now(), range = dubaiDateRange(undefined, undefined, at);
    const createdAt = { $gte: range.start, $lte: at };
    const group = { $group: { _id: "$kycState", count: { $sum: 1 } } };
    const [clients, deposits, payouts, newAccounts, pendingPayouts, openTickets, pendingIb, support] = await Promise.all([
      bounded(users.aggregate([
        { $match: { isVerified: true, createdAt: { $lte: at } } },
        { $project: { _id: 0, createdAt: 1, kycState } },
        { $facet: { all: [group], today: [{ $match: { createdAt } }, group] } },
      ])),
      bounded(orders.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }])),
      bounded(withdrawals.aggregate([{ $match: { createdAt } }, { $group: { _id: "$status", count: { $sum: 1 } } }])),
      bounded(accounts.countDocuments({ createdAt, accountType: "LIVE" })),
      bounded(withdrawals.countDocuments({ status: { $in: ["Pending", "Processing"] } })),
      bounded(tickets.countDocuments({ status: { $in: ["Open", "Pending"] } })),
      bounded(ibs.countDocuments({ status: "pending" })),
      buddy("1"),
    ]);
    if (!Array.isArray(clients) || clients.length !== 1 || !Array.isArray(clients[0].all) || !Array.isArray(clients[0].today)) throw new Error("Client aggregate unavailable");
    const all = clientTotals(clients[0].all), today = clientTotals(clients[0].today);
    return {
      version: 1, source: "BDFX daily operations", generatedAt: at.toISOString(),
      period: { date: range.from, start: range.start.toISOString(), asOf: at.toISOString(), timezone: "Asia/Dubai" },
      registeredClients: all, newRegistrations: today, newLiveAccounts: count(newAccounts),
      depositRequestsToday: totals(deposits, DEPOSIT), withdrawalRequestsToday: totals(payouts, PAYOUT),
      queues: { nonApprovedKyc: all.kycNotApproved, pendingWithdrawals: count(pendingPayouts), openTickets: count(openTickets), pendingIbApplications: count(pendingIb) },
      buddy: { sessionsStarted: count(support.sessionsStarted), sessionsWithActivity: count(support.sessionsWithActivity),
        contactRequests: count(support.contactRequests), supportHandoffs: count(support.supportHandoffs) },
      notes: [
        "New registrations are email-verified client records created from Dubai midnight to the check time; unfinished OTP attempts are excluded.",
        "KYC counts use the current BDFX approval flag. Non-approved includes pending, not-started, review, resubmission and declined cases; it does not mean all were rejected.",
        "Payment counts cover requests created today and their current statuses; they are not bank settlement totals. Monetary totals are excluded because source currencies differ.",
        "Queues and registered-client totals are current snapshots. Buddy counts cover consented saved sessions only, not every visitor or every AI question.",
      ],
    };
  };
}
module.exports = { createDailyReportService, clientTotals, totals, KYC, DEPOSIT, PAYOUT };
