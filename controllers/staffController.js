const AdminAccount = require("../models/AdminAccount");
const CrmAgentDraft = require("../models/CrmAgentDraft");
const { ownerEmails, roleFor, normalizeEmail, PERMISSIONS } = require("../services/adminPolicy");
const { agentPattern } = require("../services/crmHashmi.service");

function validateManager(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Enter the manager details.");
  const value = {};
  if (!partial || Object.hasOwn(body, "fullName")) {
    if (typeof body.fullName !== "string" || body.fullName.trim().length < 2 || body.fullName.trim().length > 100) throw new Error("Enter the manager's name (2–100 characters).");
    value.fullName = body.fullName.trim();
  }
  if (!partial) {
    value.email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email.length > 254) throw new Error("Enter the manager's email address.");
    if (ownerEmails().includes(value.email)) throw new Error("This address belongs to an owner. Choose the manager's own email.");
  }
  if (!partial || Object.hasOwn(body, "permissions")) {
    if (!Array.isArray(body.permissions) || !body.permissions.length || body.permissions.some(permission => !PERMISSIONS.includes(permission))) throw new Error("Select at least one supported permission.");
    value.permissions = [...new Set(body.permissions)];
  }
  if (Object.hasOwn(body, "enabled")) {
    if (typeof body.enabled !== "boolean") throw new Error("Choose a valid account status.");
    value.enabled = body.enabled;
  }
  if (!Object.keys(value).length) throw new Error("Choose a change to save.");
  return value;
}

const serialize = admin => ({ id: String(admin._id), email: admin.email, fullName: admin.fullName || (roleFor(admin) === "owner" ? "BDFX Owner" : "Manager"), role: roleFor(admin) || admin.role,
  enabled: admin.enabled !== false, permissions: roleFor(admin) === "owner" ? PERMISSIONS : admin.permissions || [], setupComplete: !!admin.passwordHash, lastLoginAt: admin.lastLoginAt || null, createdAt: admin.createdAt });

function createController({ admins = AdminAccount, drafts = CrmAgentDraft, now = () => new Date() } = {}) {
  return {
    async list(req, res, next) {
      try {
        const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1)), limit = 50;
        const filter = { $or: [{ email: { $in: ownerEmails() } }, { role: "manager", invitedBy: { $ne: null } }] };
        const [rows, total] = await Promise.all([admins.find(filter).select("+passwordHash").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), admins.countDocuments(filter)]);
        res.json({ data: rows.map(serialize), permissions: PERMISSIONS, page, pages: Math.ceil(total / limit), total });
      } catch (error) { next(error); }
    },
    async create(req, res, next) {
      try {
        const crmDraftId = req.body?.crmDraftId;
        let input = req.body;
        if (crmDraftId !== undefined) {
          if (typeof crmDraftId !== "string" || !agentPattern.test(crmDraftId)) return res.status(400).json({ message: "Choose a pending CRM agent." });
          const draft = await drafts.findById(crmDraftId).lean();
          if (!draft) return res.status(404).json({ message: "Pending CRM agent not found." });
          if (await admins.exists({ crmHashmiAgentId: crmDraftId })) return res.status(409).json({ message: "This Hashmi agent is already mapped to a staff account." });
          input = { fullName: draft.fullName, email: req.body.email, permissions: ["crm"] };
        }
        let value;
        try { value = validateManager(input); } catch (error) { return res.status(400).json({ message: error.message }); }
        if (await admins.exists({ email: value.email })) return res.status(409).json({ message: "An administrator with this email already exists. Update their access instead." });
        const mapping = crmDraftId === undefined ? {} : { crmHashmiAgentId: crmDraftId };
        const data = await admins.create({ ...value, ...mapping, enabled: true, role: "manager", invitedBy: req.principal.id });
        req.auditEvent = "staff.created";
        req.auditTargetId = String(data._id);
        req.auditDetails = { changedFields: ["email", "fullName", "permissions", "enabled", ...Object.keys(mapping)], permissions: data.permissions, enabled: true };
        const message = crmDraftId === undefined
          ? "Manager added. They can open Administrator sign in, verify their own email and set their password. No email has been sent yet."
          : "CRM agent added and mapped to Hashmi. They can verify their email and set a password at first sign-in.";
        res.status(201).json({ data: serialize(data), message });
      } catch (error) {
        if (error.code === 11000) {
          const message = error.keyPattern?.crmHashmiAgentId
            ? "This Hashmi agent is already mapped to a staff account."
            : "This administrator email already exists.";
          return res.status(409).json({ message });
        }
        next(error);
      }
    },
    async listCrmDrafts(_req, res, next) {
      try {
        const mappedIds = await admins.distinct("crmHashmiAgentId", { crmHashmiAgentId: { $exists: true } });
        const rows = await drafts.find({ _id: { $nin: mappedIds } }).sort({ fullName: 1, _id: 1 }).limit(250).lean();
        res.set("Cache-Control", "no-store").json({ data: rows.map(row => ({ hashmiId: row._id, fullName: row.fullName })) });
      } catch (error) { next(error); }
    },
    async stageCrmDrafts(req, res, next) {
      const rows = req.body?.agents;
      if (!Array.isArray(rows) || !rows.length || rows.length > 100) return res.status(400).json({ message: "Enter between 1 and 100 CRM agents." });
      const agents = new Map();
      for (const [index, row] of rows.entries()) {
        const fullName = typeof row?.fullName === "string" ? row.fullName.trim() : "";
        const hashmiId = row?.hashmiId;
        if (fullName.length < 2 || fullName.length > 100 || typeof hashmiId !== "string" || !agentPattern.test(hashmiId) || agents.has(hashmiId)) {
          return res.status(400).json({ message: `Row ${index + 1} needs a name and a unique numeric Hashmi ID.` });
        }
        agents.set(hashmiId, fullName);
      }
      try {
        const mappedIds = new Set(await admins.distinct("crmHashmiAgentId", { crmHashmiAgentId: { $in: [...agents.keys()] } }));
        const changes = [...agents].filter(([id]) => !mappedIds.has(id)).map(([id, fullName]) => ({
          updateOne: { filter: { _id: id }, update: { $set: { fullName } }, upsert: true },
        }));
        if (changes.length) await drafts.bulkWrite(changes, { ordered: false });
        req.auditEvent = "staff.crm-drafts-staged";
        req.auditDetails = { staged: changes.length, alreadyMapped: mappedIds.size };
        res.status(200).json(req.auditDetails);
      } catch (error) { next(error); }
    },
    async update(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return res.status(404).json({ message: "Manager not found." });
        const existing = await admins.findById(req.params.id).lean();
        if (!existing || existing.role !== "manager" || !existing.invitedBy) return res.status(404).json({ message: "Manager not found." });
        if (ownerEmails().includes(normalizeEmail(existing.email)) || String(existing._id) === req.principal.id) return res.status(400).json({ message: "Owner access cannot be changed from the manager list." });
        let value;
        try { value = validateManager(req.body, true); } catch (error) { return res.status(400).json({ message: error.message }); }
        if (Object.hasOwn(req.body, "email") || Object.hasOwn(req.body, "role")) return res.status(400).json({ message: "A manager's email and owner role cannot be changed here. Disable the old manager and add a new email if needed." });
        const update = { $set: value, $inc: { authVersion: 1 }, $unset: { challengeId: 1, otpHash: 1, otpExpiresAt: 1, resetPassword: 1 } };
        if (value.enabled === false) update.$set.disabledAt = now();
        else if (value.enabled === true) update.$unset.disabledAt = 1;
        const data = await admins.findOneAndUpdate({ _id: existing._id, role: "manager", email: existing.email }, update, { new: true, runValidators: true }).select("+passwordHash");
        if (!data) return res.status(404).json({ message: "Manager not found." });
        req.auditEvent = value.enabled === false ? "staff.disabled" : "staff.updated";
        req.auditTargetId = String(data._id);
        req.auditDetails = { changedFields: Object.keys(value).filter(key => key !== "disabledAt"), ...(value.permissions ? { permissions: value.permissions } : {}), ...(Object.hasOwn(value, "enabled") ? { enabled: value.enabled } : {}) };
        res.json({ data: serialize(data), message: "Manager access updated. Existing sessions and pending sign-in codes have been invalidated." });
      } catch (error) { next(error); }
    },
  };
}
module.exports = { createController, validateManager, serialize };
