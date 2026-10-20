const crypto = require("node:crypto");
const Enquiry = require("../models/Enquiry");
const { isUae, normalizePhone } = require("../utils/veriffPolicy");

const text = value => typeof value === "string" ? value.trim() : "";
function validateEnquiry(body = {}) {
  const name = text(body.name), email = text(body.email).toLowerCase(), country = text(body.country), message = text(body.message);
  if (name.length < 2 || name.length > 120) return { error: "Enter your full name (2–120 characters)." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (!country || country.length > 100) return { error: "Select your country of residence." };
  if (isUae(country)) return { error: "We don't accept UAE clients." };
  if (message.length < 10 || message.length > 5000) return { error: "Enter a message containing 10–5,000 characters." };
  if (body.privacyAccepted !== true) return { error: "Please acknowledge the privacy notice so we can respond to your enquiry." };
  const phone = text(body.phone);
  if (phone && !normalizePhone(phone)) return { error: "Enter your mobile number with its international country code, or leave it blank." };
  if (typeof body.requestId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(body.requestId)) return { error: "Please refresh the page and submit your enquiry again." };
  const campaign = Object.fromEntries(["source", "medium", "campaign"].map(key => [key, text(body.campaign?.[key]).slice(0, 120)]));
  return { value: { name, email, country, message, phone: phone ? normalizePhone(phone) : "", requestId: body.requestId,
    marketingConsent: body.marketingConsent === true, privacyAcceptedAt: new Date(), campaign } };
}

function createController({ enquiries = Enquiry, notify = () => {}, reference = () => `BDFX-${crypto.randomBytes(6).toString("hex").toUpperCase()}` } = {}) {
  const accepted = (res, item) => res.status(201).json({ success: true, reference: item.reference, message: "Your enquiry has been received. Keep this reference when contacting support." });
  async function create(req, res, next) {
    try {
      if (text(req.body?.website)) return accepted(res, { reference: reference() });
      const result = validateEnquiry(req.body);
      if (result.error) return res.status(400).json({ success: false, message: result.error });
      const existing = await enquiries.findOne({ requestId: result.value.requestId }).select("reference");
      if (existing) return accepted(res, existing);
      const enquiry = await enquiries.create({ ...result.value, reference: reference() });
      accepted(res, enquiry);
      // Notification delivery is backed by persisted queue fields, so an SMTP
      // outage cannot discard a saved enquiry or require the client to reapply.
      Promise.resolve().then(notify).catch(() => console.error("Enquiry notification delivery pending"));
    } catch (error) {
      if (error.code === 11000) {
        const existing = await enquiries.findOne({ requestId: req.body?.requestId }).select("reference");
        if (existing) return accepted(res, existing);
      }
      next(error);
    }
  }
  async function list(req, res, next) {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
      const status = text(req.query.status);
      if (status && !["new", "contacted", "closed"].includes(status)) return res.status(400).json({ message: "Invalid enquiry status." });
      const filter = status ? { status } : {};
      const [data, total] = await Promise.all([enquiries.find(filter).select("-requestId").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), enquiries.countDocuments(filter)]);
      res.json({ data, total, page, limit });
    } catch (error) { next(error); }
  }
  async function update(req, res, next) {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return res.status(404).json({ message: "Enquiry not found." });
      const status = text(req.body?.status), note = text(req.body?.note);
      if (!["new", "contacted", "closed"].includes(status) || note.length > 2000) return res.status(400).json({ message: "Choose a valid status and keep notes below 2,000 characters." });
      const item = await enquiries.findByIdAndUpdate(req.params.id, { $set: { status, note } }, { new: true, runValidators: true });
      if (!item) return res.status(404).json({ message: "Enquiry not found." });
      res.json({ success: true, data: item });
    } catch (error) { next(error); }
  }
  return { create, list, update };
}
module.exports = { createController, validateEnquiry };
