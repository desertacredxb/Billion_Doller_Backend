const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const Reviews = require("../models/KycReview");
const { isUae, phonePattern } = require("../utils/veriffPolicy");
const sendEmail = require("../utils/sendEmail");
const ibAutoApproval = require("../services/ibAutoApproval.service");

const commonFields = ["approved", "reviewedDocuments", "reason", "source"];
const veriffFields = ["sessionId", "expectedRevision"];
const ownerFields = ["expectedUserId", "expectedUpdatedAt", "documentCountry", "evidenceReference"];
const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const validVersion = value => value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);

function createController({ users = User, reviews = Reviews, transaction = work => User.db.transaction(work, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }), ensure = async () => { try { await Reviews.createCollection(); } catch (e) { if (e.code !== 48) throw e; } }, send = sendEmail, syncIB = (id, options) => ibAutoApproval.syncUser(id, options), now = () => new Date() } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.principal?.isAdmin || req.principal.adminRole !== "owner") return res.status(403).json({ message: "Only an owner can record a manual KYC decision." });
    const body = req.body || {};
    const source = body.source === undefined ? "veriff" : body.source;
    const independent = source === "owner_documents";
    const fields = independent ? ownerFields : veriffFields;
    if (typeof body.approved !== "boolean" || body.reviewedDocuments !== true || typeof body.reason !== "string" ||
        body.reason.trim().length < 20 || body.reason.length > 1000 || /[\x00-\x1f\x7f]/.test(body.reason) ||
        (!independent && source !== "veriff") || Object.keys(body).some(key => !commonFields.includes(key) && !fields.includes(key))) {
      return res.status(400).json({ message: "Confirm document review and enter a review reason of 20–1000 characters." });
    }
    if (independent) {
      if (typeof body.expectedUserId !== "string" || !/^[a-f\d]{24}$/i.test(body.expectedUserId) || !validVersion(body.expectedUpdatedAt) ||
          typeof body.documentCountry !== "string" || !/^[A-Z]{2}$/.test(body.documentCountry) ||
          body.documentCountry === "ZZ" || !regions.of(body.documentCountry) ||
          typeof body.evidenceReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/.test(body.evidenceReference)) {
        return res.status(400).json({ message: "Select the document issuing country and enter the internal KYC evidence reference." });
      }
    } else if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
        typeof body.sessionId !== "string" || !/^[a-f\d-]{36}$/i.test(body.sessionId)) {
      return res.status(400).json({ message: "Refresh the client record before reviewing the Veriff submission." });
    }
    let result;
    const reject = (status, message) => { const e = Error(message); e.httpStatus = status; throw e; };
    try {
      await ensure();
      result = await transaction(async session => {
        const user = await users.findOne({ email: req.params.email }).select("+kycManualReview").session(session);
        if (!user) reject(404, "User not found.");
        if (!user.isVerified || user.kycProvider !== "veriff") reject(409, "A verified BDFX account is required before manual review.");
        const current = user.veriff;
        let reviewedVersion;
        if (independent) {
          const updatedAt = user.updatedAt ? new Date(user.updatedAt).toISOString() : null;
          if (String(user._id) !== body.expectedUserId || updatedAt !== body.expectedUpdatedAt) reject(409, "The client record changed. Refresh before reviewing.");
          if (body.approved && user.isKycVerified) reject(409, "This client's KYC is already verified.");
          if (!body.approved && user.kycManualReview?.source !== "owner_documents") reject(409, "Use the submitted Veriff review to record this rejection.");
          reviewedVersion = { updatedAt: user.updatedAt ?? null };
        } else {
          if (!user.hasSubmittedDocuments || !current?.sessionId) reject(409, "A submitted Veriff document session is required for Veriff-based review.");
          if (current.revision !== body.expectedRevision || current.sessionId !== body.sessionId || ["creating", "created", "not_started"].includes(current.status)) {
            reject(409, "The verification session changed or is still in progress. Refresh before reviewing.");
          }
          reviewedVersion = { "veriff.sessionId": body.sessionId, "veriff.revision": current.revision };
        }
        if (body.approved) {
          if (!independent && current.mode !== "live") reject(409, "Test verification sessions cannot be used for live KYC approval.");
          if ([user.nationality, user.residenceCountry, user.country, body.documentCountry].some(isUae) || /UAE/.test(current?.message || "")) reject(409, "BDFX does not accept UAE clients or UAE-issued identity documents.");
          if (independent && !user.residenceCountry?.trim()) reject(409, "Confirm the client's country of residence before approval.");
          const phone = phonePattern(user.phone);
          if (!phone || await users.exists({ _id: { $ne: user._id }, phone }).session(session)) reject(409, "Correct the missing or duplicate mobile number before approval.");
        }
        const reviewId = randomUUID(), reviewedAt = now();
        const decision = { reviewId, source, approved: body.approved, reviewerId: req.principal.id, reviewedAt };
        const updated = await users.findOneAndUpdate({ _id: user._id, isVerified: true, isKycVerified: user.isKycVerified,
          kycProvider: "veriff", ...reviewedVersion,
        }, { $set: { isKycVerified: body.approved,
          kycManualReview: independent ? decision : { ...decision, sessionId: body.sessionId } },
          ...(current ? { $inc: { "veriff.revision": 1 } } : {}),
        }, { new: true, session, runValidators: true });
        if (!updated) reject(409, "Verification changed. Refresh and review again.");
        await reviews.create([{ ...decision, userId: user._id, reviewerEmail: req.principal.email,
          reason: body.reason.trim(), providerSessionId: current?.sessionId,
          providerStatus: current?.status, providerReasonCode: current?.reasonCode,
          ...(independent ? { evidenceReference: body.evidenceReference, documentCountry: body.documentCountry } : {}),
        }], { session });
        return updated;
      });
      req.auditEvent = body.approved ? "kyc:manual-approved" : "kyc:manual-rejected"; req.auditTargetId = String(result._id);
      // Recheck an existing application only after the owner's review commits.
      // Keep the KYC result truthful if the separate IB transaction needs a retry.
      let ibResult, ibSyncFailed = false;
      try {
        if (!independent || !body.approved) ibResult = await syncIB(result._id, { reconsiderRejected: body.approved });
      }
      catch { ibSyncFailed = true; }
      // A notification failure never reverses a committed review.
      try { await send({ to: result.email, subject: "BDFX identity review update", text: `Your BDFX identity review has been ${body.approved ? "approved" : "declined"} following a manual review. For assistance contact +447999283366 on WhatsApp.` }); } catch {}
      const kycMessage = body.approved ? "Manual KYC approval recorded." : "Manual KYC rejection recorded.";
      const ibMessage = ibSyncFailed ? " IB update could not be confirmed. Open IB and use Approve using verified KYC to retry approval." :
        ibResult?.managed ? (ibResult.status === "approved" ? " IB automatically approved." : ` IB ${ibResult.status}: ${ibResult.statusReason}`) : "";
      return res.json({ message: kycMessage + ibMessage, approved: result.isKycVerified,
        updatedAt: result.updatedAt, veriffRevision: result.veriff?.revision,
        ibStatus: ibSyncFailed ? "update_required" : ibResult?.status, ibSyncFailed });
    } catch (error) { return res.status(error.httpStatus || 503).json({ message: error.httpStatus ? error.message : "Manual review could not be saved. No approval is confirmed; refresh and try again." }); }
  };
}
module.exports = { createController, review: createController() };
