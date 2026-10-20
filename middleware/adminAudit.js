const crypto = require("node:crypto");
const AuditLog = require("../models/AuditLog");

function createAudit({ logs = AuditLog, now = () => new Date(), errorLog = () => console.error("Administrator activity could not be recorded.") } = {}) {
  return (req, res, next) => {
    const requestId = crypto.randomUUID();
    res.set("X-Request-Id", requestId);
    res.on("finish", () => {
      if (!req.principal?.isAdmin || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
      // Store route templates, not URLs, query strings, bodies, OTPs or credentials.
      const module = String(req.originalUrl || "").split("?")[0].split("/")[2];
      const resource = /^[a-z-]{1,40}$/i.test(module || "") ? `/api/${module}` : "/api";
      const value = req.auditTargetId || req.params?.id || req.params?.ticketId;
      const targetId = /^[a-f\d]{24}$/i.test(value || "") ? value : undefined;
      const allowedFields = ["fullName", "gender", "address", "state", "city", "postalCode", "profileImage", "accountHolderName", "accountNumber", "ifscCode", "iban", "bankName", "bankAddress", "status", "yourShare", "clientShare", "referralCode", "title", "slug", "shortDescription", "content", "coverImage", "category", "tags", "metaTitle", "metaDescription", "scheduledAt", "teamNotes", "message", "subject", "description", "amount", "comment", "note"];
      const changedFields = Object.keys(req.body || {}).filter(key => allowedFields.includes(key));
      const details = req.auditDetails || { changedFields };
      Promise.resolve().then(() => logs.create({ requestId, actorId: req.principal.id, actorEmail: req.principal.email, actorName: req.principal.fullName,
        event: req.auditEvent || `${req.method.toLowerCase()}:${resource}`, details,
        method: req.method, resource, route: typeof req.route?.path === "string" ? req.route.path : "", targetId,
        statusCode: res.statusCode, occurredAt: now() })).catch(errorLog);
    });
    next();
  };
}
module.exports = { createAudit };
