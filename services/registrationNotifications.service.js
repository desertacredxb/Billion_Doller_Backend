const sendEmail = require("../utils/sendEmail");

async function notifyRegistration(user, { send = sendEmail } = {}) {
  user = { fullName: user.fullName, email: user.email, phone: user.phone, kycProvider: user.kycProvider };
  for (const field of ["fullName", "email", "phone"]) user[field] = String(user[field] || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeSend = async mail => { try { await send({ ...mail, throwOnError: true }); } catch { /* Registration is already committed. */ } };
    await safeSend({
      to: user.email,
      subject: "Welcome to Billion Dollar FX 🎉",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #00CFFF;">Welcome, ${user.fullName}!</h2>

      <p>We’re excited to have you on board with <strong>Billion Dollar FX</strong>.</p>

      <p>Your account has been successfully created. You can now log in and start exploring the platform.</p>

      <p style="color:#d9534f; font-weight:bold;">
        ${user.kycProvider === "veriff"
          ? "Please continue identity verification to activate your account."
          : "To activate your account fully, please go to Settings and upload your documents and bank details for KYC verification."}
      </p>

      <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/welcome_to_billiondollarfx_bn6rs2.jpg"
           alt="Welcome Image" style="width:600px; max-width:100%; height:auto; display:block; margin:20px auto;" />

      <p>If you have any questions or need assistance, our support team is here to help.</p>

      <p>We look forward to seeing you succeed in your trading journey 🚀</p>

      <br/>
      <p>Best Regards,<br/><strong>The Billion Dollar FX Team</strong></p>
    </div>
  `,
    });

    await safeSend({
      to: "support@billiondollarfx.com",
      subject: "🔔 New User Registered on Billion Dollar FX",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #00CFFF;">New User Registration Alert</h2>

      <p>A new user has just registered on <strong>Billion Dollar FX</strong>.</p>

      <p><strong>User Details:</strong></p>
      <ul>
        <li><strong>Full Name:</strong> ${user.fullName}</li>
        <li><strong>Email:</strong> ${user.email}</li>
        <li><strong>Phone:</strong> ${user.phone || "Not Provided"}</li>
        <li><strong>Registration Date:</strong> ${new Date().toLocaleString()}</li>
      </ul>

      <p>
        Please log in to the admin panel to verify their account.
        If the user has not yet uploaded their <strong>documents</strong> or <strong>bank details</strong>,
        kindly reach out to them and request the necessary information for KYC verification.
      </p>

      <p style="margin-top:20px;">
        ✅ Next Step: <strong>Check user’s profile in the admin dashboard.</strong>
      </p>

      <br/>
      <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
    </div>
  `,
    });

}
module.exports = notifyRegistration;
