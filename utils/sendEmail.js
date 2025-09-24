const nodemailer = require("nodemailer");
require("dotenv").config();

const sendEmail = async ({ to, subject, text, html, attachments }) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.hostinger.com", // 👈 likely SMTP for cPanel
      port: 465,
      secure: true, // true for 465 (SSL), false for 587 (TLS)
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"Billion Dollar Fx " <info@billiondollarfx.com>`,
      to: to || "support@billiondollarfx.com", // generic or your own address

      subject,
      text,
      html,
      attachments,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Email sent to ${to}`);
  } catch (err) {
    console.error("❌ Failed to send email:", err);
  }
};

module.exports = sendEmail;
