const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const sendEmail = require("../utils/sendEmail");
const whatsapp = require("../utils/sendWhatsAppOTP");
const notifyRegistration = require("../services/registrationNotifications.service");
const { ensureRegistrationStorage } = require("../services/registrationReadiness.service");
const identity = require("../utils/registrationIdentity");
const { isUae } = require("../utils/veriffPolicy");
const { isEnabled: veriffEnabled } = require("../services/veriff.service");

const WRITE = { new: true, writeConcern: { w: "majority", j: true } };
const FIVE_MINUTES = 300000;
const COOLDOWN = 60000;
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const tokenValid = token => typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function createController({ users = User, brokers = IB, send = sendEmail, sendPhone = whatsapp,
  phoneConfigured = () => whatsapp.isConfigured(), ensureStorage = ensureRegistrationStorage,
  automaticKyc = veriffEnabled, notify = notifyRegistration, env = process.env,
  now = () => new Date(), randomCode = () => String(crypto.randomInt(100000, 1000000)),
  randomToken = () => crypto.randomBytes(32).toString("hex"), randomId = () => crypto.randomUUID() } = {}) {
  const mobileRequired = () => env.REGISTRATION_WHATSAPP_OTP_ENABLED === "true";
  const hashCode = (id, channel, nonce, code) => crypto.createHmac("sha256", env.JWT_SECRET)
    .update(`${id}:${channel}:${nonce}:${code}`).digest("hex");
  const invalid = res => res.status(400).json({ message: "The verification code or registration session is invalid or expired. Use the newest code or start again." });
  const unavailable = res => res.status(503).json({ message: "Registration is temporarily unavailable. Please try again shortly." });
  const pendingQuery = token => ({ "registration.tokenHash": hashToken(token), "registration.expiresAt": { $gt: now() }, isVerified: false });
  const selected = query => query.select("+registration +legacyOtpAttempts");
  const view = user => ({ mobileRequired: !!user.registration?.mobileRequired, mobileChannel: "whatsapp",
    emailVerified: !!user.emailVerifiedAt, maskedPhone: identity.maskedPhone(user.phone),
    expiresAt: user.registration?.expiresAt });
  const codeExpiry = user => new Date(Math.min(now().getTime() + FIVE_MINUTES, new Date(user.registration.expiresAt).getTime()));

  async function emailCode(user, code) {
    await send({ to: user.email, subject: "Verify Your Email Address - OTP Code", throwOnError: true,
      html: `<div style="font-family:Arial,sans-serif"><h2>Email Verification Required</h2><p>Dear ${escapeHtml(user.fullName)},</p><p>Your Billion Dollar FX email verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 5 minutes. Do not share this code. If you did not request registration, ignore this email.</p></div>` });
  }
  async function activate(user, condition, res, phoneVerified = false) {
    const activated = await users.findOneAndUpdate({ _id: user._id, isVerified: false, ...condition }, {
      $set: { isVerified: true, emailVerifiedAt: user.emailVerifiedAt || now(),
        ...(phoneVerified ? { phoneVerifiedAt: now(), phoneVerificationChannel: "whatsapp" } : {}) },
      $unset: { registration: 1, otp: 1, otpExpires: 1, legacyOtpAttempts: 1 },
    }, WRITE);
    if (!activated) return invalid(res);
    const token = jwt.sign({ userId: activated._id }, env.JWT_SECRET, { expiresIn: "7d" });
    await notify(activated);
    res.set("Cache-Control", "no-store");
    return res.status(201).json({ message: "User verified & registered", kycRequired: activated.kycProvider === "veriff", token,
      user: { fullName: activated.fullName, email: activated.email }, phoneVerified: !!activated.phoneVerifiedAt });
  }
  async function attemptPhone(user) {
    if (!phoneConfigured()) return { phoneSent: false, message: "WhatsApp verification is temporarily unavailable. Please try again shortly." };
    let code = randomCode();
    for (let attempt = 0; attempt < 10 && sameHash(hashCode(user._id, "email", user.registration.emailChallengeId, code), user.registration.emailHash); attempt++) code = randomCode();
    if (sameHash(hashCode(user._id, "email", user.registration.emailChallengeId, code), user.registration.emailHash)) return { phoneSent: false, message: "Please try sending a new WhatsApp code shortly." };
    const nonce = randomId();
    const reserved = await selected(users.findOneAndUpdate({ _id: user._id, isVerified: false,
      "registration.tokenHash": user.registration.tokenHash, "registration.expiresAt": { $gt: now() },
      "registration.mobileRequired": true, emailVerifiedAt: { $ne: null },
      "registration.phoneSends": { $lt: 3 }, "registration.phoneAttempts": { $lt: 5 },
      $or: [{ "registration.phoneSentAt": { $exists: false } }, { "registration.phoneSentAt": { $lte: new Date(now().getTime() - COOLDOWN) } }],
    }, { $set: { "registration.phoneChallengeId": nonce, "registration.phoneHash": hashCode(user._id, "phone", nonce, code),
      "registration.phoneExpiresAt": codeExpiry(user), "registration.phoneSentAt": now(), "registration.phoneDelivery": "pending" },
      $inc: { "registration.phoneSends": 1 } }, WRITE));
    if (!reserved) return { phoneSent: false, retryAfterSeconds: 60, message: "Please wait 60 seconds before resending. A registration allows at most three WhatsApp codes and five verification attempts." };
    let delivered = false;
    try { delivered = (await sendPhone(reserved.phone, code))?.success === true; } catch { /* Do not expose provider errors. */ }
    await users.updateOne({ _id: reserved._id, "registration.phoneChallengeId": nonce },
      { $set: { "registration.phoneDelivery": delivered ? "accepted" : "unconfirmed" } }, { writeConcern: WRITE.writeConcern });
    return { phoneSent: delivered, retryAfterSeconds: 60, message: delivered
      ? "A verification code has been sent to your WhatsApp number."
      : "The WhatsApp code could not be confirmed as sent. If it arrives, you can use it; otherwise wait 60 seconds and resend." };
  }

  async function options(_req, res) {
    res.set("Cache-Control", "no-store");
    res.json({ mobileOtpRequired: mobileRequired(), mobileOtpChannel: "whatsapp", registrationAvailable: !mobileRequired() || phoneConfigured() });
  }
  async function register(req, res) {
    try {
      const body = req.body || {}, email = identity.normalizeEmail(body.email), phone = identity.normalizePhone(body.phone);
      const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
      if (!email || !phone || !fullName || fullName.length > 150 ||
        !["nationality", "state", "city"].every(key => typeof body[key] === "string" && body[key].trim() && body[key].length <= 100)) {
        return res.status(400).json({ message: "Enter your name, valid email, international mobile number and location details." });
      }
      if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 16 ||
        !/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*_\-+=,.?])/.test(body.password)) {
        return res.status(400).json({ message: "Password must contain 8–16 characters with uppercase, lowercase, a number and a special character." });
      }
      const kyc = automaticKyc();
      if (kyc && (typeof body.residenceCountry !== "string" || !body.residenceCountry.trim() || body.residenceCountry.length > 100)) return res.status(400).json({ message: "Please select your country of residence." });
      if (kyc && [body.nationality, body.residenceCountry].some(isUae)) return res.status(403).json({ message: "We don't accept UAE clients." });
      if (mobileRequired() && !phoneConfigured()) return unavailable(res);
      if (mobileRequired() && body.whatsappOtpConsent !== true) return res.status(400).json({ message: "Please agree to receive your mobile verification code on WhatsApp." });
      if (!env.JWT_SECRET) return unavailable(res);
      await ensureStorage();
      const existing = await users.findOne({ $or: [{ email: identity.emailPattern(email) }, { phone: identity.phonePattern(phone) },
        { phone: identity.legacyNationalPattern(phone) },
        { registrationEmailKey: email }, { registrationPhoneKey: phone }] }).select("_id");
      if (existing) return res.status(409).json({ message: "This email address or mobile number is already registered. Sign in or recover your existing account." });
      let referralCode, referredByIB = null;
      if (typeof body.referralCode === "string" && body.referralCode.length <= 100 && body.referralCode) {
        const broker = await brokers.findOne({ referralCode: body.referralCode, status: "approved" });
        if (broker) { referralCode = body.referralCode; referredByIB = broker._id; }
      }
      const user = new users({ fullName, email, phone, registrationEmailKey: email, registrationPhoneKey: phone,
        nationality: body.nationality.trim(), state: body.state.trim(), city: body.city.trim(),
        country: kyc ? body.residenceCountry.trim() : body.nationality.trim(),
        residenceCountry: kyc ? body.residenceCountry.trim() : undefined, kycProvider: kyc ? "veriff" : "manual",
        marketingConsent: body.marketingConsent === true,
        ...(body.marketingConsent === true ? { marketingConsentAt: now(), marketingConsentVersion: require("../services/emailMarketing.service").VERSION } : {}),
        password: await bcrypt.hash(body.password, 10), referralCode, referredByIB, isVerified: false });
      const token = randomToken(), code = randomCode(), nonce = randomId();
      user.registration = { tokenHash: hashToken(token), expiresAt: new Date(now().getTime() + 15 * 60000), mobileRequired: mobileRequired(),
        ...(mobileRequired() ? { whatsappConsentAt: now() } : {}), emailChallengeId: nonce,
        emailHash: hashCode(user._id, "email", nonce, code), emailExpiresAt: new Date(now().getTime() + FIVE_MINUTES),
        emailAttempts: 0, emailSends: 1, emailSentAt: now(), phoneAttempts: 0, phoneSends: 0 };
      await user.save({ w: "majority", j: true });
      let emailSent = false; try { await emailCode(user, code); emailSent = true; } catch { /* Saved registration can be resumed with this token. */ }
      res.set("Cache-Control", "no-store");
      return res.json({ message: emailSent ? "OTP sent to email" : "Registration saved. The email could not be confirmed as sent. If it arrives, use it; otherwise resend after 60 seconds.",
        registrationToken: token, emailSent, ...view(user) });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ message: "This email address or mobile number is already registered. Sign in or recover your existing account." });
      return unavailable(res);
    }
  }
  async function verifyOTP(req, res) {
    try {
      const email = identity.normalizeEmail(req.body?.email), code = req.body?.otp, token = req.body?.registrationToken;
      if (!email || typeof code !== "string" || !/^\d{6}$/.test(code)) return invalid(res);
      let user = await selected(users.findOne({ email: identity.emailPattern(email), isVerified: false }));
      if (!user) return invalid(res);
      // Preserve only the short-lived email challenges issued before this release.
      if (!user.registration?.tokenHash) {
        user = await selected(users.findOneAndUpdate({ _id: user._id, isVerified: false, otpExpires: { $gt: now() },
          $or: [{ legacyOtpAttempts: { $exists: false } }, { legacyOtpAttempts: { $lt: 5 } }] }, { $inc: { legacyOtpAttempts: 1 } }, WRITE));
        if (!user || typeof user.otp !== "string" || !sameHash(hashToken(code), hashToken(user.otp))) return invalid(res);
        return activate(user, { otp: user.otp, otpExpires: { $gt: now() } }, res);
      }
      if (!tokenValid(token) || !sameHash(hashToken(token), user.registration.tokenHash) || new Date(user.registration.expiresAt) <= now()) return invalid(res);
      if (user.emailVerifiedAt) return res.json({ ...view(user), ...await attemptPhone(user) });
      user = await selected(users.findOneAndUpdate({ _id: user._id, ...pendingQuery(token),
        "registration.emailExpiresAt": { $gt: now() }, "registration.emailAttempts": { $lt: 5 } },
      { $inc: { "registration.emailAttempts": 1 } }, WRITE));
      if (!user || !sameHash(hashCode(user._id, "email", user.registration.emailChallengeId, code), user.registration.emailHash)) return invalid(res);
      if (!user.registration.mobileRequired) return activate(user, { "registration.tokenHash": user.registration.tokenHash,
        "registration.emailHash": user.registration.emailHash, "registration.emailExpiresAt": { $gt: now() } }, res);
      user = await selected(users.findOneAndUpdate({ _id: user._id, ...pendingQuery(token),
        "registration.emailHash": user.registration.emailHash, "registration.emailExpiresAt": { $gt: now() } }, { $set: { emailVerifiedAt: now() } }, WRITE));
      if (!user) return invalid(res);
      return res.json({ ...view(user), ...await attemptPhone(user) });
    } catch { return unavailable(res); }
  }
  async function sendMobile(req, res) {
    try {
      const token = req.body?.registrationToken;
      if (!tokenValid(token)) return invalid(res);
      const user = await selected(users.findOne({ ...pendingQuery(token), emailVerifiedAt: { $ne: null }, "registration.mobileRequired": true }));
      if (!user) return invalid(res);
      const result = await attemptPhone(user);
      return res.status(result.phoneSent ? 200 : result.retryAfterSeconds ? 429 : 503).json({ ...view(user), ...result });
    } catch { return unavailable(res); }
  }
  async function verifyMobile(req, res) {
    try {
      const token = req.body?.registrationToken, code = req.body?.otp;
      if (!tokenValid(token) || typeof code !== "string" || !/^\d{6}$/.test(code)) return invalid(res);
      const user = await selected(users.findOneAndUpdate({ ...pendingQuery(token), emailVerifiedAt: { $ne: null },
        "registration.mobileRequired": true, "registration.phoneExpiresAt": { $gt: now() }, "registration.phoneAttempts": { $lt: 5 } },
      { $inc: { "registration.phoneAttempts": 1 } }, WRITE));
      if (!user || !sameHash(hashCode(user._id, "phone", user.registration.phoneChallengeId, code), user.registration.phoneHash)) return invalid(res);
      return activate(user, { "registration.tokenHash": user.registration.tokenHash, "registration.phoneHash": user.registration.phoneHash,
        "registration.phoneExpiresAt": { $gt: now() }, emailVerifiedAt: { $ne: null } }, res, true);
    } catch { return unavailable(res); }
  }
  async function resendEmail(req, res) {
    try {
      const token = req.body?.registrationToken;
      if (!tokenValid(token)) return invalid(res);
      const nonce = randomId(), code = randomCode();
      const current = await selected(users.findOne({ ...pendingQuery(token), emailVerifiedAt: null }));
      if (!current) return invalid(res);
      const user = await selected(users.findOneAndUpdate({ _id: current._id, ...pendingQuery(token), emailVerifiedAt: null,
        "registration.emailSends": { $lt: 3 }, "registration.emailAttempts": { $lt: 5 },
        "registration.emailSentAt": { $lte: new Date(now().getTime() - COOLDOWN) } },
      { $set: { "registration.emailChallengeId": nonce, "registration.emailHash": hashCode(current._id, "email", nonce, code),
        "registration.emailExpiresAt": codeExpiry(current), "registration.emailSentAt": now() }, $inc: { "registration.emailSends": 1 } }, WRITE));
      if (!user) return res.status(429).json({ message: "Please wait 60 seconds before resending. A registration allows at most three email codes and five verification attempts.", retryAfterSeconds: 60 });
      try { await emailCode(user, code); return res.json({ message: "A new email verification code has been sent.", retryAfterSeconds: 60 }); }
      catch { return res.status(503).json({ message: "The email could not be confirmed as sent. If it arrives, use it; otherwise wait 60 seconds before resending.", retryAfterSeconds: 60 }); }
    } catch { return unavailable(res); }
  }
  return { options, register, verifyOTP, sendMobile, verifyMobile, resendEmail };
}
module.exports = { ...createController(), createController };
