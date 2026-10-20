const { randomBytes } = require("node:crypto");
const User = require("../models/User");
const IB = require("../models/Broker.model");
const provider = require("./veriff.service");
const { isUae, phonePattern } = require("../utils/veriffPolicy");

const isEnabled = () => provider.isEnabled() && process.env.VERIFF_IB_AUTO_APPROVAL === "true";

function verifiedForIB(user, config, duplicateMobile) {
  return !!(user.isVerified && user.isKycVerified && user.kycProvider === "veriff" &&
    user.veriff?.status === "approved" && user.veriff.mode === "live" && config.mode === "live" &&
    user.veriff.integrationKeyHash === config.keyHash && user.veriff.sessionId &&
    user.residenceCountry?.trim() && !isUae(user.residenceCountry) && !isUae(user.nationality) &&
    phonePattern(user.phone) && !duplicateMobile);
}

function createService({ users = User, brokers = IB, enabled = isEnabled,
  getConfig = provider.getConfig, transaction = work => User.db.transaction(work) } = {}) {
  async function syncUser(userId) {
    if (!enabled()) return { managed: false };
    const config = getConfig();
    if (!await brokers.exists({ user: userId, approvalProvider: "veriff" })) return { managed: false };
    // The role and referral code must commit together. A failed transaction leaves no partial approval.
    return transaction(async session => {
      const user = await users.findById(userId).select("+veriff.integrationKeyHash").session(session);
      if (!user) return { managed: false };
      const broker = await brokers.findOne({ user: user._id, approvalProvider: "veriff" }).session(session);
      if (!broker) return { managed: false };
      if (broker.status === "rejected") return { managed: true, status: "rejected", verificationRequired: false };

      const pattern = phonePattern(user.phone);
      const duplicateMobile = pattern ? !!(await users.exists({ _id: { $ne: user._id }, phone: pattern }).session(session)) : false;
      const eligible = verifiedForIB(user, config, duplicateMobile);
      if (!eligible) {
        const rejected = user.veriff?.status === "declined" || isUae(user.residenceCountry) || isUae(user.nationality);
        const status = rejected ? "rejected" : "pending";
        if (broker.status !== status || broker.referralCode) {
          await brokers.updateOne({ _id: broker._id, approvalProvider: "veriff" }, {
            $set: { status }, $unset: { referralCode: 1, approvalSessionId: 1, approvedAt: 1 },
          }, { session });
        }
        if (user.isApprovedIB) await users.updateOne({ _id: user._id }, { $set: { isApprovedIB: false } }, { session });
        return { managed: true, status, verificationRequired: !rejected };
      }
      const referralCode = broker.referralCode || `IB${randomBytes(5).toString("hex").toUpperCase()}`;
      if (broker.status !== "approved" || broker.approvalSessionId !== user.veriff.sessionId) {
        await brokers.updateOne({ _id: broker._id, approvalProvider: "veriff", status: { $ne: "rejected" } }, {
          $set: { status: "approved", referralCode, approvalSessionId: user.veriff.sessionId, approvedAt: new Date() },
        }, { session });
      }
      if (!user.isApprovedIB) await users.updateOne({ _id: user._id }, { $set: { isApprovedIB: true } }, { session });
      return { managed: true, status: "approved", referralCode, verificationRequired: false };
    });
  }
  return { syncUser };
}

module.exports = { isEnabled, verifiedForIB, createService, ...createService() };
