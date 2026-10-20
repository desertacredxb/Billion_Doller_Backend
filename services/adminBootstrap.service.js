const crypto = require("node:crypto");
const AdminAccount = require("../models/AdminAccount");
const AuditLog = require("../models/AuditLog");
const { ownerEmails, normalizeEmail, PERMISSIONS } = require("./adminPolicy");

function createBootstrap({ admins = AdminAccount, logs = AuditLog, emails = () => process.env.ADMIN_BOOTSTRAP_MANAGERS || "", owners = ownerEmails } = {}) {
  return async () => {
    const configured = [...new Set(String(emails()).split(",").map(normalizeEmail).filter(Boolean))];
    if (!configured.length) return;
    const owner = owners()[0];
    if (!owner || configured.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new Error("Administrator bootstrap configuration is invalid.");
    const ownerAccount = await admins.findOneAndUpdate({ email: owner }, { $setOnInsert: { role: "owner", enabled: true, permissions: PERMISSIONS } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    for (const email of configured) {
      if (owners().includes(email)) continue;
      // Existing records, including disabled managers, are never re-enabled by a restart.
      const result = await admins.updateOne({ email }, { $setOnInsert: { email, role: "manager", enabled: true, permissions: PERMISSIONS, invitedBy: ownerAccount._id, authVersion: 0 } }, { upsert: true, setDefaultsOnInsert: true });
      if (result.upsertedId) await logs.create({ requestId: crypto.randomUUID(), actorId: String(ownerAccount._id), actorEmail: owner, actorName: "Owner configuration", method: "SYSTEM", resource: "/api/staff", route: "/", event: "staff.bootstrap_created", targetId: String(result.upsertedId), statusCode: 201,
        details: { changedFields: ["email", "permissions", "enabled"], permissions: PERMISSIONS, enabled: true } });
    }
  };
}
module.exports = { createBootstrap, run: createBootstrap() };
