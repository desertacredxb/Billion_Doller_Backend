const normalizeEmail = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const PERMISSIONS = ["clients", "partners", "finance", "support", "enquiries", "content", "reports"];
const ownerEmails = () => String(process.env.ADMIN_OWNER_EMAILS || process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean);
function roleFor(admin) {
  if (!admin || admin.enabled === false) return null;
  if (ownerEmails().includes(normalizeEmail(admin.email))) return "owner";
  if (admin.role === "manager" && admin.enabled === true && admin.invitedBy) return "manager";
  return null;
}
function permissionForRequest(req) {
  const path = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  if (path === "/api/auth/admin/session" || path === "/api/operations/overview") return "session";
  if (path.startsWith("/api/staff") || path === "/api/operations/audit") return "owner";
  const module = path.split("/")[2];
  if (module === "auth") return /bank/i.test(path) ? "finance" : "clients";
  return { mt5: "finance", moneyplant: "finance", payment: "finance", ib: "partners", brokers: "partners", deals: "reports", tickets: "support", "support-chat": "support", blogs: "content", enquiries: "enquiries", operations: "reports", ai: "clients" }[module] || "owner";
}
module.exports = { normalizeEmail, PERMISSIONS, ownerEmails, roleFor, permissionForRequest };
