const nodemailer = require("nodemailer");
const { mailConfig } = require("./mailConfig");
require("dotenv").config();

function createMailer({ env = process.env, mail = nodemailer, logger = console } = {}) {
  let transporter;
  return async ({ to, subject, text, html, attachments, headers, throwOnError = false }) => {
    try {
      const config = mailConfig(env);
      transporter ||= mail.createTransport(config.transport);
      await transporter.sendMail({ from: config.from, replyTo: config.replyTo, to: to || "support@billiondollarfx.com", subject, text, html, attachments, headers });
      logger.info("BDFX email accepted by mail server");
    } catch {
      // Provider errors can include credentials, recipients or message content.
      logger.error("BDFX email delivery failed");
      if (throwOnError) throw new Error("Email delivery failed. Please try again shortly.");
    }
  };
}
module.exports = createMailer();
module.exports.createMailer = createMailer;
