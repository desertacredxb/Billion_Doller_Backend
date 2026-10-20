const User = require("../models/User");
const Account = require("../models/account.model");
const Ticket = require("../models/Ticket");
const Deal = require("../models/Deal.model");
const AdminAccount = require("../models/AdminAccount");

const { normalizeEmail, ownerEmails: adminEmails, roleFor, permissionForRequest, PERMISSIONS } = require("../services/adminPolicy");

function createAccessControl({ users = User, accounts = Account, tickets = Ticket, deals = Deal, admins = AdminAccount } = {}) {
  const deny = (res, code = 403) => res.status(code).json({ message: code === 401 ? "Please sign in again." : "You do not have permission to access this resource." });

  async function principal(req, res, next) {
    try {
      res.set("Cache-Control", "no-store");
      const token = req.user;
      if (!token) return deny(res, 401);
      if (token.kind === "admin") {
        if (token.iss !== "bdfx-auth" || token.aud !== "bdfx-admin") return deny(res, 401);
        const admin = await admins.findOne({ _id: token.sub, email: normalizeEmail(token.email), authVersion: token.version });
        const role = roleFor(admin);
        if (!role) return deny(res, 401);
        const permissions = role === "owner" ? PERMISSIONS : (admin.permissions || []).filter(value => PERMISSIONS.includes(value));
        req.principal = { id: String(admin._id), email: admin.email, fullName: admin.fullName || (role === "owner" ? "BDFX Owner" : "BDFX Manager"), isAdmin: true, adminRole: role, permissions };
        const required = permissionForRequest(req);
        if (role !== "owner" && required !== "session" && !permissions.includes(required)) return deny(res);
      } else {
        const id = token.id || token.userId;
        if (typeof id !== "string" || !id) return deny(res, 401);
        const user = await users.findById(id).select("_id email isVerified");
        if (!user?.isVerified) return deny(res, 401);
        req.principal = { id: String(user._id), email: user.email, isAdmin: false };
      }
      next();
    } catch (error) {
      if (["CastError", "ValidationError"].includes(error.name)) return deny(res, 401);
      next(error);
    }
  }

  const admin = (req, res, next) => req.principal?.isAdmin ? next() : deny(res);
  const owner = (req, res, next) => req.principal?.isAdmin && req.principal.adminRole === "owner" ? next() : deny(res);
  const emailOwner = (source = "params", key = "email") => (req, res, next) => {
    if (req.principal?.isAdmin) return next();
    const email = req[source]?.[key];
    if (!normalizeEmail(email) || normalizeEmail(email) !== normalizeEmail(req.principal?.email)) return deny(res);
    // Use the authenticated account's stored email for case-sensitive legacy queries.
    req[source][key] = req.principal.email;
    next();
  };
  const accountOwner = (source = "body", key = "accountNo") => async (req, res, next) => {
    try {
      const value = req[source]?.[key];
      if (!["string", "number"].includes(typeof value) || !/^\d{1,16}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        return res.status(400).json({ message: "A valid trading account number is required." });
      }
      if (req.principal?.isAdmin) return next();
      const account = await accounts.findOne({ accountNo: Number(value), user: req.principal.id }).select("_id");
      if (!account) return deny(res);
      next();
    } catch (error) { next(error); }
  };
  const ticketOwner = async (req, res, next) => {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.ticketId || "")) return res.status(404).json({ message: "Ticket not found." });
      const filter = { _id: req.params.ticketId };
      if (!req.principal?.isAdmin) filter.user = req.principal.id;
      const ticket = await tickets.findOne(filter).select("_id");
      if (!ticket) return res.status(404).json({ message: "Ticket not found." });
      next();
    } catch (error) { next(error); }
  };
  const dealOwner = async (req, res, next) => {
    try {
      if (req.principal?.isAdmin) return next();
      if (typeof req.params.order !== "string") return deny(res);
      const deal = await deals.findOne({ order: req.params.order }).select("login");
      if (!deal) return res.status(404).json({ message: "Deal not found." });
      const account = await accounts.findOne({ accountNo: Number(deal.login), user: req.principal.id }).select("_id");
      if (!account) return deny(res);
      next();
    } catch (error) { next(error); }
  };
  return { principal, admin, owner, emailOwner, accountOwner, ticketOwner, dealOwner };
}

module.exports = { ...createAccessControl(), createAccessControl, adminEmails, normalizeEmail };
