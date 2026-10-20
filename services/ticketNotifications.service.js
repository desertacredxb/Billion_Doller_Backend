const Ticket = require("../models/Ticket");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
function createService({ tickets = Ticket, users = User, send = sendEmail, now = () => new Date() } = {}) {
  let running = false;
  async function processPending() {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < 5; i++) {
        const current = now();
        const item = await tickets.findOneAndUpdate({ notificationAttempts: { $lt: 3 }, $or: [
          { notificationStatus: "pending", notificationNextAttemptAt: { $lte: current } },
          { notificationStatus: "sending", notificationAttemptedAt: { $lt: new Date(current.getTime() - 600000) } },
        ] }, { $set: { notificationStatus: "sending", notificationAttemptedAt: current }, $inc: { notificationAttempts: 1 } }, { new: true, sort: { createdAt: 1 } });
        if (!item) break;
        try {
          const to = process.env.CONTACT_NOTIFICATION_EMAIL || process.env.EMAIL_USER;
          if (!to) throw new Error("Notification mailbox unavailable");
          const user = await users.findById(item.user).select("email fullName");
          await send({ to, subject: `BDFX support ticket ${item._id}`, throwOnError: true,
            text: `Ticket: ${item._id}\nClient: ${user?.email || "See client area"}\nCategory: ${item.category}\nSubject: ${item.subject}\n\n${item.description}\n\nManage this ticket in the BDFX administrator panel.` });
          await tickets.updateOne({ _id: item._id, notificationStatus: "sending" }, { $set: { notificationStatus: "sent" } });
        } catch {
          await tickets.updateOne({ _id: item._id, notificationStatus: "sending" }, { $set: { notificationStatus: item.notificationAttempts >= 3 ? "failed" : "pending", notificationNextAttemptAt: new Date(current.getTime() + item.notificationAttempts * 300000) } });
        }
      }
    } finally { running = false; }
  }
  function start() {
    const tick = () => processPending().catch(() => console.error("Ticket notification worker failed"));
    tick(); const timer = setInterval(tick, 60000); timer.unref(); return timer;
  }
  return { processPending, start };
}
module.exports = { ...createService(), createService };
