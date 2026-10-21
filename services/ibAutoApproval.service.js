const { randomBytes } = require("node:crypto");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const provider = require("./veriff.service");
const { isUae, phonePattern } = require("../utils/veriffPolicy");

const isEnabled = () => provider.isEnabled() && process.env.VERIFF_IB_AUTO_APPROVAL === "true";

function verifiedForIB(user, config, duplicateMobile) {
  const manualIdentityApproved = user.kycManualReview?.approved === true &&
    user.kycManualReview.sessionId === user.veriff?.sessionId && user.kycManualReview.reviewId &&
    user.kycManualReview.reviewerId && user.kycManualReview.reviewedAt;
  return !!(user.isVerified && user.isKycVerified && user.kycProvider === "veriff" &&
    (user.veriff?.status === "approved" || manualIdentityApproved) && user.veriff.mode === "live" && config.mode === "live" &&
    user.veriff.integrationKeyHash === config.keyHash && user.veriff.sessionId &&
    user.residenceCountry?.trim() && !isUae(user.residenceCountry) && !isUae(user.nationality) &&
    phonePattern(user.phone) && !duplicateMobile);
}

function eligibilityReason(user, config, duplicateMobile) {
  if (isUae(user.residenceCountry) || isUae(user.nationality)) return { reasonCode: "country_ineligible", statusReason: "The IB program is not available for UAE residents or nationals." };
  if (!user.isVerified) return { reasonCode: "email_unverified", statusReason: "Verify your email before applying for the IB program." };
  if (!user.residenceCountry?.trim()) return { reasonCode: "country_missing", statusReason: "Complete your country of residence in your profile." };
  if (!phonePattern(user.phone)) return { reasonCode: "phone_invalid", statusReason: "Add a valid mobile number with its country code in your profile." };
  if (duplicateMobile) return { reasonCode: "phone_duplicate", statusReason: "This mobile number is already registered on another account. Contact WhatsApp support to resolve it." };
  if (verifiedForIB(user, config, false)) return null;
  if (user.kycManualReview?.approved === false && user.kycManualReview.sessionId === user.veriff?.sessionId) return { reasonCode: "identity_manual_review", statusReason: "Your identity was not approved during the support review. Check the identity verification page for the review reason and contact WhatsApp support." };
  if (user.veriff?.status === "declined") return { reasonCode: "identity_declined", statusReason: require("../utils/veriffReasons").reasonMessage(user.veriff.reasonCode) };
  if (user.veriff?.mode === "test" || config.mode !== "live") return { reasonCode: "identity_test", statusReason: "Live identity verification is required; a test verification cannot approve an IB application." };
  return { reasonCode: "identity_required", statusReason: "Complete live identity verification, or ask support to review your submitted ID. Then apply again to have your eligibility checked automatically." };
}

function applicationDetails(broker, user, config) {
  const managed = broker.approvalProvider === "veriff";
  let reason = broker.status === "approved" ? null : (broker.statusReason ? { statusReason: broker.statusReason, reasonCode: broker.reasonCode } : null);
  if (!reason && broker.status !== "approved") reason = managed && user ? eligibilityReason(user, config, false) : null;
  return { status: broker.status, referralCode: broker.status === "approved" ? broker.referralCode : undefined,
    statusReason: reason?.statusReason || (broker.status === "rejected" ? "Your earlier application was rejected. Apply again to request a fresh eligibility review." : broker.status === "pending" ? "Your application is awaiting review." : "Your IB application is approved."),
    reasonCode: reason?.reasonCode, canReapply: broker.status === "rejected",
    verificationRequired: managed && broker.status === "pending" && reason?.reasonCode === "identity_required" };
}

function createService({ users = User, brokers = IB, enabled = isEnabled,
  getConfig = provider.getConfig, transaction = work => User.db.transaction(work) } = {}) {
  async function syncUser(userId, { reconsiderRejected = false } = {}) {
    if (!enabled()) return { managed: false };
    const config = getConfig();
    if (!await brokers.exists({ user: userId, approvalProvider: "veriff" })) return { managed: false };
    // The role and referral code must commit together. A failed transaction leaves no partial approval.
    return transaction(async session => {
      const user = await users.findById(userId).select("+veriff.integrationKeyHash +kycManualReview").session(session);
      if (!user) return { managed: false };
      const broker = await brokers.findOne({ user: user._id, approvalProvider: "veriff" }).session(session);
      if (!broker) return { managed: false };
      if (broker.status === "rejected" && !reconsiderRejected) return { managed: true, status: "rejected", verificationRequired: false, ...applicationDetails(broker, user, config) };

      const pattern = phonePattern(user.phone);
      const duplicateMobile = pattern ? !!(await users.exists({ _id: { $ne: user._id }, phone: pattern }).session(session)) : false;
      const reason = eligibilityReason(user, config, duplicateMobile);
      const eligible = !reason;
      if (!eligible) {
        const rejected = user.veriff?.status === "declined" || reason.reasonCode === "identity_manual_review" || isUae(user.residenceCountry) || isUae(user.nationality);
        const status = rejected ? "rejected" : "pending";
        if (broker.status !== status || broker.referralCode || broker.statusReason !== reason.statusReason) {
          await brokers.updateOne({ _id: broker._id, approvalProvider: "veriff" }, {
            $set: { status, ...reason }, $unset: { referralCode: 1, approvalSessionId: 1, approvedAt: 1 },
          }, { session });
        }
        if (user.isApprovedIB) await users.updateOne({ _id: user._id }, { $set: { isApprovedIB: false } }, { session });
        return { managed: true, status, ...reason, canReapply: rejected, verificationRequired: !rejected && reason.reasonCode === "identity_required" };
      }
      const referralCode = broker.referralCode || `IB${randomBytes(5).toString("hex").toUpperCase()}`;
      if (broker.status !== "approved" || broker.approvalSessionId !== user.veriff.sessionId) {
        await brokers.updateOne({ _id: broker._id, approvalProvider: "veriff", ...(reconsiderRejected ? {} : { status: { $ne: "rejected" } }) }, {
          $set: { status: "approved", referralCode, approvalSessionId: user.veriff.sessionId, approvedAt: new Date() },
          $unset: { statusReason: 1, reasonCode: 1 },
        }, { session });
      }
      if (!user.isApprovedIB) await users.updateOne({ _id: user._id }, { $set: { isApprovedIB: true } }, { session });
      return { managed: true, status: "approved", referralCode, statusReason: "Your IB application is approved.", canReapply: false, verificationRequired: false };
    });
  }
  return { syncUser };
}

module.exports = { isEnabled, verifiedForIB, eligibilityReason, applicationDetails, createService, ...createService() };
