const { randomUUID } = require("node:crypto");
const User = require("../models/User");
const Reviews = require("../models/KycReview");
const { isUae, phonePattern } = require("../utils/veriffPolicy");
const sendEmail = require("../utils/sendEmail");
function createController({ users = User, reviews = Reviews, transaction = work => User.db.transaction(work, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }), ensure = async () => { try { await Reviews.createCollection(); } catch (e) { if (e.code !== 48) throw e; } }, send = sendEmail, now = () => new Date() } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.principal?.isAdmin || req.principal.adminRole !== "owner") return res.status(403).json({ message: "Only an owner can record a manual KYC decision." });
    const body = req.body || {};
    if (typeof body.approved !== "boolean" || body.reviewedDocuments !== true || typeof body.reason !== "string" ||
        body.reason.trim().length < 20 || body.reason.length > 1000 || /[\x00-\x1f\x7f]/.test(body.reason) ||
        (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) ||
        typeof body.sessionId !== "string" || !/^[a-f\d-]{36}$/i.test(body.sessionId) ||
        Object.keys(body).some(key => !["approved", "reviewedDocuments", "reason", "sessionId", "expectedRevision"].includes(key))) return res.status(400).json({ message: "Confirm document review and enter a review reason of 20–1000 characters." });
    let result;
    const reject = (status, message) => { const e = Error(message); e.httpStatus = status; throw e; };
    try {
      await ensure();
      result = await transaction(async session => {
        const user = await users.findOne({ email: req.params.email }).select("+kycManualReview").session(session);
        if (!user) reject(404, "User not found.");
        if (!user.isVerified || user.kycProvider !== "veriff" || !user.hasSubmittedDocuments || !user.veriff?.sessionId) reject(409, "A verified account and submitted Veriff document session are required before manual review.");
        if (user.veriff.revision !== body.expectedRevision || user.veriff.sessionId !== body.sessionId || ["creating", "created", "not_started"].includes(user.veriff.status)) reject(409, "The verification session changed or is still in progress. Refresh before reviewing.");
        if (body.approved) {
          if (user.veriff.mode !== "live") reject(409, "Test verification sessions cannot be used for live KYC approval.");
          if ([user.nationality, user.residenceCountry, user.country].some(isUae) || /UAE/.test(user.veriff.message || "")) reject(409, "BDFX does not accept UAE clients or UAE-issued identity documents.");
          const phone = phonePattern(user.phone);
          if (!phone || await users.exists({ _id: { $ne: user._id }, phone }).session(session)) reject(409, "Correct the missing or duplicate mobile number before approval.");
        }
        const reviewId = randomUUID(), reviewedAt = now();
        const updated = await users.findOneAndUpdate({ _id: user._id, "veriff.sessionId": body.sessionId,
          "veriff.revision": user.veriff.revision, isKycVerified: user.isKycVerified,
        }, { $set: { isKycVerified: body.approved, kycManualReview: { reviewId, approved: body.approved,
          reviewerId: req.principal.id, reviewedAt, sessionId: body.sessionId } }, $inc: { "veriff.revision": 1 } }, { new: true, session, runValidators: true });
        if (!updated) reject(409, "Verification changed. Refresh and review again.");
        await reviews.create([{ reviewId, userId: user._id, reviewerId: req.principal.id, reviewerEmail: req.principal.email,
          approved: body.approved, reason: body.reason.trim(), providerSessionId: body.sessionId,
          providerStatus: user.veriff.status, providerReasonCode: user.veriff.reasonCode, reviewedAt }], { session });
        return updated;
      });
      req.auditEvent = body.approved ? "kyc:manual-approved" : "kyc:manual-rejected"; req.auditTargetId = String(result._id);
      // A notification failure never reverses a committed review.
      try { await send({ to: result.email, subject: "BDFX identity review update", text: `Your BDFX identity review has been ${body.approved ? "approved" : "declined"} following a manual review. For assistance contact +447999283366 on WhatsApp.` }); } catch {}
      return res.json({ message: body.approved ? "Manual KYC approval recorded." : "Manual KYC rejection recorded.", approved: result.isKycVerified });
    } catch (error) { return res.status(error.httpStatus || 503).json({ message: error.httpStatus ? error.message : "Manual review could not be saved. No approval is confirmed; refresh and try again." }); }
  };
}
module.exports = { createController, review: createController() };
