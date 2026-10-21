const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const provider = require("../services/veriff.service");
const ibApproval = require("../services/ibAutoApproval.service");
const { isUae, phonePattern, normalizeDecision, decisionOutcome, isStaleDecision } = require("../utils/veriffPolicy");

const { reasonMessage, retryable } = require("../utils/veriffReasons");
const PRIVATE_FIELDS = "+veriff.reference +veriff.sessionUrl +veriff.integrationKeyHash +kycManualReview";
const ownerId = req => req.user?.id || req.user?.userId;
// Retry provider verification failures, while retaining policy and review blocks.
const manuallyRejected = user => user.kycManualReview?.sessionId === user.veriff?.sessionId && user.kycManualReview?.approved === false;
const canRetry = user => !manuallyRejected(user) && user.veriff?.status === "declined"
  && user.veriff.message === "Your identity could not be verified. Please contact support."
  && retryable.has(user.veriff.reasonCode)
  && !isUae(user.nationality) && !isUae(user.residenceCountry);
const editableFields = { fullName: 150, address: 300, state: 100, city: 100, postalCode: 30 };
const canEditDetails = user => !manuallyRejected(user) && user.isVerified && !user.isKycVerified &&
  (!user.veriff?.status || ["not_started", "expired", "abandoned", "error"].includes(user.veriff.status) || canRetry(user));
const publicStatus = (user, enabled) => ({
  enabled,
  canRetry: canRetry(user),
  canEditDetails: !!canEditDetails(user),
  details: Object.fromEntries(Object.keys(editableFields).map(key => [key, user[key] || ""])),
  managedByVeriff: user.kycProvider === "veriff",
  ibApproved: !!user.isApprovedIB,
  approved: !!user.isKycVerified,
  status: user.isKycVerified ? "approved" : manuallyRejected(user) ? "manual_rejected" : (user.veriff?.status || "not_started"),
  message: user.isKycVerified ? "Your identity has been verified successfully." : manuallyRejected(user) ? "Your manual identity review was declined. Please contact BDFX support on WhatsApp." : (user.veriff?.message || "Complete identity verification to activate your account."),
  residenceCountry: user.residenceCountry || "",
  ...(["declined", "resubmission_requested", "review"].includes(user.veriff?.status) && !user.isKycVerified ? { failureReason: reasonMessage(user.veriff.reasonCode), reasonCode: user.veriff.reasonCode || null } : {}),
});

function createController({ users = User, veriff = provider, syncIB = ibApproval.syncUser } = {}) {
  const reasonLookups = new Map();
  async function withReason(user) {
    const current = user.veriff;
    if (user.kycManualReview || !current?.sessionId || current.reasonCode || !["declined", "resubmission_requested", "review"].includes(current.status)) return user;
    const key = String(user._id) + ":" + current.sessionId;
    if (reasonLookups.get(key) > Date.now()) return user;
    reasonLookups.set(key, Date.now() + 60000);
    if (reasonLookups.size > 500) reasonLookups.delete(reasonLookups.keys().next().value);
    try {
      const config = veriff.getConfig();
      if (current.integrationKeyHash !== config.keyHash || current.mode !== config.mode) return user;
      const decision = await veriff.getDecisionReason(current.sessionId, current.reference, config);
      if (!decision?.reasonCode || decision.status !== current.status) return user;
      return await users.findOneAndUpdate({ _id: user._id, "veriff.reference": current.reference,
        "veriff.sessionId": current.sessionId, "veriff.revision": current.revision,
      }, { $set: { "veriff.reasonCode": decision.reasonCode } }, { new: true }) || user;
    } catch { return user; }
  }
  async function getStatus(req, res) {
    try {
      const found = await users.findById(ownerId(req)).select(PRIVATE_FIELDS);
      const user = found ? await withReason(found) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      res.set("Cache-Control", "no-store");
      return res.json(publicStatus(user, veriff.isEnabled()));
    } catch {
      return res.status(500).json({ message: "Unable to load verification status." });
    }
  }

  async function updateDetails(req, res) {
    res.set("Cache-Control", "no-store");
    try {
      const found = await users.findById(ownerId(req)).select(PRIVATE_FIELDS);
      const user = found ? await withReason(found) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!canEditDetails(user)) return res.status(409).json({ message: "Details cannot be changed during an active verification or after approval. Please contact support on WhatsApp." });
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length ||
          Object.keys(body).some(key => !Object.hasOwn(editableFields, key) || typeof body[key] !== "string" || body[key].trim().length > editableFields[key] || /[\x00-\x1f\x7f]/.test(body[key])) ||
          (Object.hasOwn(body, "fullName") && !body.fullName.trim())) return res.status(400).json({ message: "Enter valid name and address details exactly as shown on your ID." });
      const updated = await users.findOneAndUpdate({ _id: user._id, isKycVerified: false,
        "veriff.reference": user.veriff?.reference || null,
        "veriff.revision": user.veriff?.revision == null ? { $exists: false } : user.veriff.revision,
      }, { $set: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value.trim()])) }, { new: true, runValidators: true });
      if (!updated) return res.status(409).json({ message: "Verification changed. Refresh before editing details." });
      return res.json(publicStatus(updated, veriff.isEnabled()));
    } catch { return res.status(503).json({ message: "Unable to save details. Please try again." }); }
  }

  async function startSession(req, res) {
    let reference;
    try {
      const config = veriff.getConfig();
      const found = await users.findById(ownerId(req)).select(PRIVATE_FIELDS);
      const user = found ? await withReason(found) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!user.isVerified) return res.status(403).json({ message: "Please verify your email first." });
      res.set("Cache-Control", "no-store");
      const reverifyForIB = req.body?.purpose === "ib" && ibApproval.isEnabled() && user.kycProvider !== "veriff";
      if (user.isKycVerified && !reverifyForIB) return res.json(publicStatus(user, true));

      const residenceCountry = user.residenceCountry || req.body?.residenceCountry;
      if (typeof residenceCountry !== "string" || !residenceCountry.trim() || residenceCountry.length > 100) {
        return res.status(400).json({ message: "Please select your country of residence." });
      }
      if (isUae(user.nationality) || isUae(residenceCountry)) {
        return res.status(403).json({ message: "We don't accept UAE clients." });
      }
      const pattern = phonePattern(user.phone);
      if (!pattern) return res.status(400).json({ message: "Please contact support to correct your mobile number, including country code." });
      if (await users.exists({ _id: { $ne: user._id }, phone: pattern })) {
        return res.status(409).json({ message: "This mobile number is already registered. Please contact support." });
      }
      if (manuallyRejected(user)) return res.status(409).json({ message: "Your manual identity review was declined. Please contact BDFX support on WhatsApp." });
      const current = user.veriff || {};
      if (["declined", "review", "test_approved"].includes(current.status) && !canRetry(user)) {
        return res.status(409).json({ message: current.message || "Please contact support about your verification." });
      }
      if (current.sessionUrl && ["created", "resubmission_requested"].includes(current.status) &&
          Date.now() - new Date(current.sessionCreatedAt).getTime() < 7 * 86400000) {
        if (current.integrationKeyHash !== config.keyHash || current.mode !== config.mode) {
          return res.status(409).json({ message: "Verification configuration changed. Please contact support." });
        }
        return res.json({ ...publicStatus(user, true), url: current.sessionUrl });
      }
      if (current.status === "creating" && Date.now() - new Date(current.creationStartedAt).getTime() < 120000) {
        return res.status(202).json({ ...publicStatus(user, true), message: "Your verification link is being prepared. Please try again shortly." });
      }
      reference = randomUUID();
      const claimed = await users.findOneAndUpdate({
        _id: user._id,
        isKycVerified: user.isKycVerified,
        "veriff.reference": current.reference || null,
        "veriff.revision": current.revision == null ? { $exists: false } : current.revision,
      }, { $set: {
        kycProvider: "veriff",
        kycManualReview: null,
        isKycVerified: false,
        residenceCountry: residenceCountry.trim(),
        veriff: {
          reference, mode: config.mode, integrationKeyHash: config.keyHash,
          status: "creating", creationStartedAt: new Date(), revision: 0,
        },
      } }, { new: true });
      if (!claimed) return res.status(409).json({ message: "Verification changed. Please refresh and try again." });

      const sessionConfig = { ...config };
      if (req.body?.purpose === "ib") {
        const callback = new URL(config.callbackUrl);
        callback.searchParams.set("returnTo", "ib");
        sessionConfig.callbackUrl = callback.href;
      }
      const session = await veriff.createSession(reference, sessionConfig);
      const filter = { _id: user._id, "veriff.reference": reference,
        $or: [{ "veriff.sessionId": null }, { "veriff.sessionId": session.id }] };
      const sessionFields = { "veriff.sessionId": session.id, "veriff.sessionUrl": session.url, "veriff.sessionCreatedAt": new Date() };
      // Do not overwrite a decision webhook that arrived before the API response.
      let updated = await users.findOneAndUpdate({ ...filter, "veriff.status": "creating" }, {
        $set: { ...sessionFields, "veriff.status": "created" }, $inc: { "veriff.revision": 1 },
      }, { new: true });
      if (!updated) updated = await users.findOneAndUpdate(filter, {
        $set: sessionFields, $inc: { "veriff.revision": 1 },
      }, { new: true });
      if (!updated) return res.status(409).json({ message: "Verification session changed. Please refresh." });
      return res.status(201).json({ ...publicStatus(updated, true), url: session.url });
    } catch (error) {
      if (reference) {
        await users.updateOne({ _id: ownerId(req), "veriff.reference": reference, "veriff.status": "creating" }, {
          $set: { "veriff.status": "error", "veriff.message": "Unable to start verification. Please try again." },
        }).catch(() => {});
      }
      // Provider error objects can contain API headers and sensitive session URLs.
      return res.status(error.status === 503 ? 503 : 502).json({
        message: error.status === 503 ? error.message : "Unable to start verification. Please try again shortly.",
      });
    }
  }

  async function decisionWebhook(req, res) {
    try {
      const config = veriff.getConfig();
      if (!veriff.authenticateWebhook(req.body, req.headers, config)) {
        return res.status(401).json({ message: "Invalid webhook authentication" });
      }
      let payload;
      try { payload = JSON.parse(req.body.toString("utf8")); }
      catch { return res.status(400).json({ message: "Invalid JSON" }); }
      const decision = normalizeDecision(payload, config.webhookType);
      if (!decision) return res.status(400).json({ message: "Unsupported decision payload" });
      const user = await users.findOne({ "veriff.reference": decision.reference }).select(PRIVATE_FIELDS);
      // Unknown/stale sessions cannot change any user. Acknowledge obsolete deliveries.
      if (!user) return res.json({ received: true, ignored: true });
      const current = user.veriff;
      if (current.integrationKeyHash !== config.keyHash || current.mode !== config.mode ||
          (current.sessionId && current.sessionId !== decision.id)) {
        return res.status(400).json({ message: "Verification session mismatch" });
      }
      if (isStaleDecision(decision, current)) {
        // Retry a previously failed IB transaction using the CURRENT verified user state.
        await syncIB(user._id);
        return res.json({ received: true, ignored: true });
      }
      const pattern = phonePattern(user.phone);
      const duplicate = pattern ? !!(await users.exists({ _id: { $ne: user._id }, phone: pattern })) : false;
      const outcome = decisionOutcome(decision, user, config, duplicate);
      const updated = await users.findOneAndUpdate({
        _id: user._id,
        "veriff.reference": decision.reference,
        "veriff.revision": current.revision,
      }, { $set: {
        "veriff.sessionId": decision.id,
        "veriff.status": outcome.status,
        "veriff.message": outcome.message,
        "veriff.reasonCode": decision.reasonCode,
        "veriff.decisionAt": new Date(decision.timestamp),
        isKycVerified: user.kycManualReview?.sessionId === decision.id ? user.kycManualReview.approved : outcome.approved,
        hasSubmittedDocuments: !["expired", "abandoned"].includes(decision.status),
      }, $inc: { "veriff.revision": 1 } }, { new: true });
      // A concurrent update should be retried by Veriff rather than acknowledged/lost.
      if (!updated) return res.status(503).json({ message: "Please retry webhook delivery" });
      await syncIB(updated._id);
      return res.json({ received: true });
    } catch (error) {
      return res.status(error.status === 503 ? 503 : 500).json({ message: "Unable to process verification decision" });
    }
  }
  return { getStatus, updateDetails, startSession, decisionWebhook };
}

module.exports = { ...createController(), createController };
