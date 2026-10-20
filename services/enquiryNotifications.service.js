const Enquiry = require("../models/Enquiry");
const sendEmail = require("../utils/sendEmail");

function createService({ enquiries = Enquiry, send = sendEmail, now = () => new Date() } = {}) {
  let running = false;
  async function processPending() {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < 5; i++) {
        const current = now();
        const item = await enquiries.findOneAndUpdate({ notificationAttempts: { $lt: 3 }, $or: [
          { notificationStatus: "pending", notificationNextAttemptAt: { $lte: current } },
          { notificationStatus: "sending", notificationAttemptedAt: { $lt: new Date(current.getTime() - 10 * 60000) } },
        ] }, { $set: { notificationStatus: "sending", notificationAttemptedAt: current }, $inc: { notificationAttempts: 1 } }, { new: true, sort: { createdAt: 1 } });
        if (!item) break;
        try {
          const to = process.env.CONTACT_NOTIFICATION_EMAIL || process.env.EMAIL_USER;
          if (!to) throw new Error("Notification mailbox unavailable");
          await send({ to, subject: `New BDFX enquiry ${item.reference}`, throwOnError: true,
            text: `Reference: ${item.reference}\nName: ${item.name}\nEmail: ${item.email}\nPhone: ${item.phone || "Not supplied"}\nCountry: ${item.country}\n\n${item.message}\n\nManage this enquiry in the BDFX administrator panel under Enquiries.` });
          await enquiries.updateOne({ _id: item._id, notificationStatus: "sending" }, { $set: { notificationStatus: "sent" } });
        } catch {
          await enquiries.updateOne({ _id: item._id, notificationStatus: "sending" }, { $set: {
            notificationStatus: item.notificationAttempts >= 3 ? "failed" : "pending",
            notificationNextAttemptAt: new Date(current.getTime() + item.notificationAttempts * 5 * 60000),
          } });
        }
      }
    } finally { running = false; }
  }
  function start() {
    const tick = () => processPending().catch(() => console.error("Enquiry notification worker failed"));
    tick();
    const timer = setInterval(tick, 60000); timer.unref();
    return timer;
  }
  return { processPending, start };
}
module.exports = { ...createService(), createService };
