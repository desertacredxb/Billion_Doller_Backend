const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const provider = require("../services/veriff.service");
const ibApproval = require("../services/ibAutoApproval.service");
const { isUae, phonePattern, normalizeDecision, decisionOutcome, isStaleDecision } = require("../utils/veriffPolicy");

const PRIVATE_FIELDS = "+veriff.reference +veriff.sessionUrl +veriff.integrationKeyHash";
const ownerId = req => req.user?.id || req.user?.userId;
// Retry provider verification failures, while retaining policy and review blocks.
const canRetry = user => user.veriff?.status === "declined"
  && user.veriff.message === "Your identity could not be verified. Please contact support."
  && !isUae(user.nationality) && !isUae(user.residenceCountry);
const publicStatus = (user, enabled) => ({
  enabled,
  canRetry: canRetry(user),
  managedByVeriff: user.kycProvider === "veriff",
  ibApproved: !!user.isApprovedIB,
  approved: !!user.isKycVerified,
  status: user.isKycVerified ? "approved" : (user.veriff?.status || "not_started"),
  message: user.isKycVerified ? "Your identity has been verified successfully." : (user.veriff?.message || "Complete identity verification to activate your account."),
  residenceCountry: user.residenceCountry || "",
});

function createController({ users = User, veriff = provider, syncIB = ibApproval.syncUser } = {}) {
  async function getStatus(req, res) {
    try {
      const user = await users.findById(ownerId(req));
      if (!user) return res.status(404).json({ message: "User not found" });
      res.set("Cache-Control", "no-store");
      return res.json(publicStatus(user, veriff.isEnabled()));
    } catch {
      return res.status(500).json({ message: "Unable to load verification status." });
    }
  }

  async function startSession(req, res) {
    let reference;
    try {
      const config = veriff.getConfig();
      const user = await users.findById(ownerId(req)).select(PRIVATE_FIELDS);
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
        "veriff.decisionAt": new Date(decision.timestamp),
        isKycVerified: outcome.approved,
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
  return { getStatus, startSession, decisionWebhook };
}

module.exports = { ...createController(), createController };
