const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const AdminAccount = require("../models/AdminAccount");
const sendEmail = require("../utils/sendEmail");
const { adminEmails, normalizeEmail } = require("../middleware/accessControl");
const { roleFor, PERMISSIONS } = require("../services/adminPolicy");

function createController({ admins = AdminAccount, send = sendEmail, randomCode = () => String(crypto.randomInt(100000, 1000000)), now = () => new Date() } = {}) {
  const hash = (id, code) => crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${id}:${code}`).digest("hex");
  const invalid = res => res.status(400).json({ message: "The sign-in code is invalid or expired. Please request a new code." });

  async function requestCode(req, res, next) {
    try {
      const email = normalizeEmail(req.body?.email);
      const challengeId = crypto.randomUUID();
      if (!email || email.length > 254) return res.status(400).json({ message: "Enter your authorized email address." });
      let admin = await admins.findOne({ email }).select("+passwordHash");
      const isOwner = adminEmails().includes(email);
      const role = admin ? roleFor(admin) : isOwner ? "owner" : null;
      if (!role) return res.json({ challengeId, requiresPasswordSetup: false, message: "If the details are correct, a code will be sent to your authorized email address." });
      const resetPassword = req.body?.resetPassword === true;
      if (admin?.passwordHash && !resetPassword && (typeof req.body?.password !== "string" || !await bcrypt.compare(req.body.password, admin.passwordHash))) {
        return res.status(401).json({ message: "Invalid administrator email or password." });
      }
      const code = randomCode();
      const requiresPasswordSetup = !admin?.passwordHash || resetPassword;
      const filter = admin ? { _id: admin._id, email, enabled: { $ne: false }, authVersion: admin.authVersion || 0 } : { email };
      admin = await admins.findOneAndUpdate(filter, { $set: {
        challengeId, otpHash: hash(challengeId, code), otpExpiresAt: new Date(now().getTime() + 5 * 60000), otpAttempts: 0,
        resetPassword: requiresPasswordSetup,
      }, ...(!admin ? { $setOnInsert: { role: "owner", enabled: true } } : {}) }, { new: true, upsert: !admin && isOwner, setDefaultsOnInsert: true });
      if (!admin || !roleFor(admin)) return invalid(res);
      await send({ to: email, subject: "BDFX administrator sign-in code", text: `Your administrator sign-in code is ${code}. It expires in 5 minutes. Do not share this code.`, throwOnError: true });
      res.json({ challengeId, requiresPasswordSetup,
        message: "A sign-in code has been sent to your authorized email address." });
    } catch (error) { next(error); }
  }

  async function verifyCode(req, res, next) {
    try {
      const { challengeId, code, newPassword } = req.body || {};
      if (typeof challengeId !== "string" || !/^[a-f\d-]{36}$/i.test(challengeId) || typeof code !== "string" || !/^\d{6}$/.test(code)) return invalid(res);
      // Reserve an attempt atomically before comparing, including failed attempts.
      const admin = await admins.findOneAndUpdate({ challengeId, otpExpiresAt: { $gt: now() }, otpAttempts: { $lt: 5 } },
        { $inc: { otpAttempts: 1 } }, { new: true }).select("+passwordHash +otpHash +resetPassword");
      if (!admin || !roleFor(admin)) return invalid(res);
      const supplied = Buffer.from(hash(challengeId, code), "hex");
      const expected = Buffer.from(admin.otpHash || "", "hex");
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return invalid(res);
      if (admin.resetPassword && (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128)) {
        return res.status(400).json({ message: "Choose a new administrator password containing 12–128 characters." });
      }
      const update = { $unset: { challengeId: 1, otpHash: 1, otpExpiresAt: 1, resetPassword: 1 }, $inc: { authVersion: 1 }, $set: { lastLoginAt: now() } };
      if (admin.resetPassword) update.$set.passwordHash = await bcrypt.hash(newPassword, 12);
      // Consume the challenge once; parallel requests cannot issue a second session.
      const consumed = await admins.findOneAndUpdate({ _id: admin._id, challengeId, otpHash: admin.otpHash, otpExpiresAt: { $gt: now() }, enabled: { $ne: false }, authVersion: admin.authVersion || 0 }, update, { new: true });
      if (!consumed || !roleFor(consumed)) return invalid(res);
      const role = roleFor(consumed);
      const token = jwt.sign({ kind: "admin", email: consumed.email, version: consumed.authVersion }, process.env.JWT_SECRET,
        { subject: String(consumed._id), issuer: "bdfx-auth", audience: "bdfx-admin", expiresIn: "2h" });
      res.set("Cache-Control", "no-store");
      req.principal = { id: String(consumed._id), email: consumed.email, isAdmin: true, adminRole: role };
      req.auditEvent = admin.resetPassword ? "admin.password_setup_or_recovery" : "admin.sign_in";
      res.json({ token, user: { email: consumed.email, fullName: consumed.fullName || (role === "owner" ? "BDFX Owner" : "BDFX Manager"), role, permissions: role === "owner" ? PERMISSIONS : consumed.permissions || [] } });
    } catch (error) { next(error); }
  }
  return { requestCode, verifyCode };
}

module.exports = { ...createController(), createController };
