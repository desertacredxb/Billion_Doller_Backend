const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const provider = require("../services/veriff.service");
const ibApproval = require("../services/ibAutoApproval.service");
const { isUae, phonePattern, normalizeDecision, decisionOutcome, isStaleDecision } = require("../utils/veriffPolicy");

const { reasonMessage } = require("../utils/veriffReasons");
const PRIVATE_FIELDS = "+veriff.reference +veriff.sessionUrl +veriff.integrationKeyHash +kycManualReview";
const ownerId = req => req.user?.id || req.user?.userId;
// Provider failure codes must not hide client correction/reverification actions.
// A new attempt still needs its own signed approval; explicit BDFX holds remain.
const manuallyRejected = user => user.kycManualReview?.sessionId === user.veriff?.sessionId && user.kycManualReview?.approved === false;
const canCorrectIdentity = user => !!user.isVerified && !user.isKycVerified
  && !isUae(user.nationality) && !isUae(user.residenceCountry)
  && !(user.kycManualReview?.sessionId && user.kycManualReview.sessionId === user.veriff?.sessionId);
const canRetry = user => canCorrectIdentity(user) && (
  user.veriff?.status === "declined" && (!user.veriff.message || user.veriff.message === "Your identity could not be verified. Please contact support.") ||
  user.veriff?.status === "review" && (!user.veriff.message || user.veriff.message === "Your verification needs further review. Please contact support.")
);
// Owner-confirmed client flow: edit name, save, then resubmit. Address stays read-only.
const editableFields = { fullName: 150 };
const canEditDetails = user => {
  if (!canCorrectIdentity(user)) return false;
  const current = user.veriff || {};
  if (!current.status || ["not_started", "expired", "abandoned", "error"].includes(current.status) || canRetry(user)) return true;
  return current.status === "resubmission_requested" && (!current.message || current.message === "Please continue verification and resubmit the requested information.");
};
const publicStatus = (user, enabled) => ({
  enabled,
  canRetry: canRetry(user),
  canEditDetails: !!canEditDetails(user),
  resubmissionRequired: !!user.veriff?.resubmissionRequired,
  details: Object.fromEntries(Object.keys(editableFields).map(key => [key, user[key] || ""])),
  managedByVeriff: user.kycProvider === "veriff",
  ibApproved: !!user.isApprovedIB,
  approved: !!user.isKycVerified,
  status: user.isKycVerified ? "approved" : manuallyRejected(user) ? "manual_rejected" : (user.veriff?.status || "not_started"),
  message: user.isKycVerified ? "Your identity has been verified successfully." : manuallyRejected(user) ? "Your manual identity review was declined. Please contact BDFX support on WhatsApp." : (user.veriff?.message || "Complete identity verification to activate your account."),
  residenceCountry: user.residenceCountry || "",
  ...(["declined", "resubmission_requested", "review"].includes(user.veriff?.status) && !user.isKycVerified ? {
    failureReason: user.veriff.status === "review" && !user.veriff.reasonCode
      ? "Your verification is awaiting BDFX review. A Veriff approval can still require additional BDFX eligibility checks. Please contact support."
      : reasonMessage(user.veriff.reasonCode),
    reasonCode: user.veriff.reasonCode || null,
  } : {}),
});

function createController({ users = User, veriff = provider, syncIB = ibApproval.syncUser } = {}) {
  const reasonLookups = new Map();
  const decisionLookups = new Map();
  async function withLatestApproval(user, force = false) {
    const current = user.veriff;
    if (user.isKycVerified || user.kycProvider !== "veriff" || !current?.sessionId ||
        user.kycManualReview?.sessionId === current.sessionId) return user;
    const key = String(user._id) + ":" + current.sessionId;
    if (!force && decisionLookups.get(key) > Date.now()) return user;
    decisionLookups.set(key, Date.now() + 60000);
    if (decisionLookups.size > 500) decisionLookups.delete(decisionLookups.keys().next().value);
    try {
      const config = veriff.getConfig();
      if (current.integrationKeyHash !== config.keyHash || current.mode !== config.mode) return user;
      // GET decisions are authenticated and checked against this exact stored session and reference.
      const decision = await veriff.getDecision(current.sessionId, current.reference, config);
      if (!decision || decision.status !== "approved" || decision.id !== current.sessionId || decision.reference !== current.reference ||
          !Number.isFinite(decision.timestamp) || (current.decisionAt && decision.timestamp < new Date(current.decisionAt).getTime())) return user;
      const pattern = phonePattern(user.phone);
      const duplicate = pattern ? !!(await users.exists({ _id: { $ne: user._id }, phone: pattern })) : false;
      const outcome = decisionOutcome(decision, user, config, duplicate);
      // Refreshing a signed approval never manufactures a review decision or overrides an owner review.
      if (!outcome.approved) return user;
      const updated = await users.findOneAndUpdate({ _id: user._id, isKycVerified: false,
        "veriff.reference": current.reference, "veriff.sessionId": current.sessionId, "veriff.revision": current.revision,
      }, { $set: { "veriff.status": outcome.status, "veriff.message": outcome.message,
        "veriff.reasonCode": decision.reasonCode, "veriff.decisionAt": new Date(decision.timestamp),
        isKycVerified: true, hasSubmittedDocuments: true,
      }, $inc: { "veriff.revision": 1 } }, { new: true });
      if (!updated) { if (force) throw Error("Verification changed"); return user; }
      // An IB transaction is separate; a failure must not misreport committed identity approval.
      try { await syncIB(updated._id); } catch { /* A provider retry or IB action can reconcile this. */ }
      return updated;
    } catch (error) { if (force) throw error; return user; }
  }
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
      const user = found ? await withReason(await withLatestApproval(found)) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      res.set("Cache-Control", "no-store");
      return res.json(publicStatus(user, veriff.isEnabled()));
    } catch {
      return res.status(500).json({ message: "Unable to load verification status." });
    }
  }

  async function syncStatus(req, res) {
    res.set("Cache-Control", "no-store");
    if (!req.principal?.isAdmin || req.principal.adminRole !== "owner") return res.status(403).json({ message: "Only an owner can refresh another client's Veriff result." });
    if (!/^[a-f\d]{24}$/i.test(req.params.userId || "") || typeof req.body?.sessionId !== "string" ||
        !/^[a-f\d-]{36}$/i.test(req.body.sessionId) || !Number.isSafeInteger(req.body.expectedRevision) ||
        req.body.expectedRevision < 0 || Object.keys(req.body).some(key => !["sessionId", "expectedRevision"].includes(key))) {
      return res.status(400).json({ message: "Refresh the client record before checking Veriff." });
    }
    try {
      const found = await users.findById(req.params.userId).select(PRIVATE_FIELDS);
      if (!found) return res.status(404).json({ message: "User not found." });
      if (found.kycProvider !== "veriff" || found.veriff?.sessionId !== req.body.sessionId || found.veriff?.revision !== req.body.expectedRevision) {
        return res.status(409).json({ message: "Verification session changed. Refresh the client record." });
      }
      const user = await withLatestApproval(found, true);
      if (user.isKycVerified && !found.isKycVerified) { req.auditEvent = "kyc:provider-synced"; req.auditTargetId = String(user._id); }
      return res.json({ approved: !!user.isKycVerified,
        message: user.isKycVerified ? "Identity verified from the current signed Veriff approval." : "No eligible Veriff approval was applied. The existing review or verification status is unchanged.",
        veriff: { status: user.veriff?.status, reasonCode: user.veriff?.reasonCode, sessionId: user.veriff?.sessionId, revision: user.veriff?.revision } });
    } catch { return res.status(503).json({ message: "Unable to confirm the current Veriff decision. No new approval is confirmed; refresh before retrying." }); }
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
          (Object.hasOwn(body, "fullName") && !body.fullName.trim())) return res.status(400).json({ message: "Enter your full name exactly as shown on your ID. Other details must be changed through support." });
      const updated = await users.findOneAndUpdate({ _id: user._id, isKycVerified: false,
        "veriff.reference": user.veriff?.reference || null,
        "veriff.revision": user.veriff?.revision == null ? { $exists: false } : user.veriff.revision,
      }, { $set: {
        fullName: body.fullName.trim(),
        // Retire the old correlation atomically: its delayed approval cannot verify changed details.
        veriff: { status: "not_started", revision: (user.veriff?.revision || 0) + 1,
          resubmissionRequired: true, message: "Your name has been saved. Resubmit your identity verification." },
        hasSubmittedDocuments: false,
      } }, { new: true, runValidators: true });
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
  return { getStatus, syncStatus, updateDetails, startSession, decisionWebhook };
}

module.exports = { ...createController(), createController };
