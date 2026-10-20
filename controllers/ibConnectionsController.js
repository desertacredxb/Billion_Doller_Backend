const User = require("../models/User");
const IB = require("../models/Broker.model");

function createController({ users = User, ibs = IB } = {}) {
  async function getConnections(req, res, next) {
    try {
      const ib = await ibs.findOne({ email: req.principal.email, status: "approved" });
      if (!ib) return res.status(403).json({ message: "An approved IB account is required." });
      const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
      const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 25));
      // The stable relationship is authoritative; legacy referrals are included
      // only when there is no relationship to a different IB.
      const filter = { $or: [{ referredByIB: ib._id },
        ...(ib.referralCode ? [{ referredByIB: null, referralCode: ib.referralCode }] : [])] };
      const [clients, total] = await Promise.all([
        users.find(filter).select("fullName createdAt isKycVerified").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
          .populate({ path: "accounts", select: "accountNo user" }).lean(),
        users.countDocuments(filter),
      ]);
      // Do not serialize whole user/account documents into an IB report.
      res.set("Cache-Control", "no-store");
      res.json({ referralCode: ib.referralCode, total, page, limit, connections: clients.map(client => ({
        id: String(client._id), fullName: client.fullName, createdAt: client.createdAt,
        isKycVerified: client.isKycVerified === true,
        accounts: (client.accounts || []).map(account => ({ accountNo: account.accountNo })),
      })) });
    } catch (error) { next(error); }
  }
  return { getConnections };
}

module.exports = { ...createController(), createController };
