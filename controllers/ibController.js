// controllers/ibController.js
const IB = require("../models/Broker.model");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { calculateClientCommission } = require("../utils/commissionService");
const {
  calculateClientCommissionV2,
  parseToUnixSeconds,
} = require("../utils/commissionServiceV2");
const {
  calculateClientCommission: calculateClientCommissionV3,
} = require("../utils/commissionServiceV3");
const { updateMT5Balance } = require("../utils/MT5/mt5Balance");
const axios = require("axios");
const ibAutoApproval = require("../services/ibAutoApproval.service");

/**
 * 📌 Register IB Request (User Side)
 */
const registerIB = async (req, res) => {
  try {
    const {
      email,
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB,
      yourShare,
      clientShare,
    } = req.body;

    // check if user exists
    const user = await User.findById(req.user.id || req.user.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.isVerified) return res.status(403).json({ message: "Please verify your email before applying." });
    if (email !== user.email) return res.status(403).json({ message: "You can only submit your own IB application." });

    // check if already requested
    const existingIB = await IB.findOne({ email });
    if (existingIB) {
      if (existingIB.approvalProvider === "veriff" && String(existingIB.user) === String(user._id)) {
        const result = await ibAutoApproval.syncUser(user._id, { reconsiderRejected: req.body.reapply === true });
        const details = result.managed ? result : ibAutoApproval.applicationDetails(existingIB, user, require("../services/veriff.service").getConfig());
        return res.json({ message: details.statusReason || "Your IB application is approved.", newIB: details, verificationRequired: details.verificationRequired });
      }
      if (req.body.reapply === true && existingIB.status === "rejected" && (!existingIB.user || String(existingIB.user) === String(user._id))) {
        existingIB.status = "pending";
        existingIB.statusReason = "Your application has been resubmitted and is awaiting support review.";
        existingIB.reasonCode = "manual_review";
        await existingIB.save();
        return res.json({ message: existingIB.statusReason, newIB: ibAutoApproval.applicationDetails(existingIB), verificationRequired: false });
      }
      return res.status(400).json({ message: "IB request already submitted" });
    }

    const automatic = ibAutoApproval.isEnabled();
    if (automatic && (!["2", "4", "6", "8", "10"].includes(String(expectedCommissionDirect)) ||
        !["Yes", "No"].includes(existingClientBase) || !["Yes", "No"].includes(offerEducation) ||
        !["0-10", "10-50", "50-100", "100+"].includes(expectedClientsNext3Months))) {
      return res.status(400).json({ message: "Please complete the IB onboarding questions using the available choices." });
    }

    const newIB = new IB({
      email,
      user: user._id,
      approvalProvider: automatic ? "veriff" : "manual",
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB: automatic ? "0" : expectedCommissionSubIB,
      yourShare: automatic ? Number(expectedCommissionDirect) / 2 : yourShare,
      clientShare: automatic ? Number(expectedCommissionDirect) / 2 : clientShare,
    });

    await newIB.save();
    const approval = automatic ? await ibAutoApproval.syncUser(user._id) : { managed: false };

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "🚀 New IB Request Submitted",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #1abc9c;">New Introducing Broker Request</h2>
          <p>${automatic ? "A new IB application is being processed using Veriff identity verification." : "A user has submitted a new IB request. Please review and approve in the admin dashboard."}</p>
          
          <p><strong>User Details:</strong></p>
          <ul>
            <li><strong>Name:</strong> ${user.fullName || "N/A"}</li>
            <li><strong>Email:</strong> ${email}</li>
          </ul>

          <p><strong>IB Details:</strong></p>
          <ul>
            <li><strong>Existing Client Base:</strong> ${existingClientBase}</li>
            <li><strong>Offer Education:</strong> ${offerEducation}</li>
            <li><strong>Expected Clients (Next 3 Months):</strong> ${expectedClientsNext3Months}</li>
            <li><strong>Expected Commission (Direct):</strong> ${expectedCommissionDirect}</li>
            <li><strong>Expected Commission (Sub IB):</strong> ${newIB.expectedCommissionSubIB}</li>
            <li><strong>Your Share:</strong> ${newIB.yourShare}</li>
            <li><strong>Client Share:</strong> ${newIB.clientShare}</li>
          </ul>

          <p>${automatic ? `Application status: ${approval.status}.` : "Please approve this IB request in the dashboard and contact the user if necessary."}</p>

          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
        </div>
      `,
    });

    res
      .status(201)
      .json({ message: approval.statusReason || "IB request submitted successfully",
        newIB: { ...newIB.toObject(), ...(approval.managed ? { ...approval } : {}) },
        verificationRequired: !!approval.verificationRequired });
  } catch (err) {
    res.status(err.code === 11000 ? 409 : 503).json({ message: err.code === 11000 ? "IB request already submitted. Please refresh." : "Unable to finish your IB application. Please try again shortly." });
  }
};

/**
 * 📌 Get All IB Requests (Admin Side)
 */
const getAllIBRequests = async (req, res) => {
  try {
    const ibRequests = await IB.find().sort({ createdAt: -1 });
    const users = await User.find({ email: { $in: ibRequests.map(ib => ib.email) } })
      .select("email commission isVerified isKycVerified kycProvider residenceCountry nationality phone veriff +veriff.integrationKeyHash +kycManualReview").lean();
    const usersByEmail = new Map(users.map(user => [user.email, user]));
    const config = ibRequests.some(ib => ib.approvalProvider === "veriff") ? require("../services/veriff.service").getConfig() : null;
    const result = ibRequests.map(ib => {
      const user = usersByEmail.get(ib.email);
      return { ...ib.toObject(), ...ibAutoApproval.applicationDetails(ib, user, config), commission: user?.commission ?? null };
    });

    res.json(result);
  } catch (err) {
    console.error("❌ Error fetching IB requests:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Approve IB Request (Admin Side)
 */
const approveIBByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const ib = await IB.findOne({ email });
    if (!ib) return res.status(404).json({ message: "IB request not found" });
    if (ib.approvalProvider === "veriff") {
      if (req.principal?.adminRole !== "owner") return res.status(403).json({ message: "Only an owner can approve an IB application using reviewed KYC." });
      const result = await ibAutoApproval.syncUser(ib.user, { reconsiderRejected: true });
      if (result.status !== "approved") return res.status(409).json({ message: result.statusReason || "IB approval requires valid live identity verification or a recorded owner KYC approval, plus the normal eligibility checks." });
      req.auditEvent = "ib:approved-from-reviewed-kyc"; req.auditTargetId = String(ib._id);
      return res.json({ message: "IB approved using verified KYC.", referralCode: result.referralCode });
    }

    if (ib.status === "approved") {
      return res.status(400).json({
        message: "IB is already approved",
        referralCode: ib.referralCode,
      });
    }

    // generate referral code
    const referralCode =
      "IB" + Math.random().toString(36).substring(2, 8).toUpperCase();

    // update IB
    ib.status = "approved";
    ib.statusReason = undefined;
    ib.reasonCode = undefined;
    ib.referralCode = referralCode;
    await ib.save();

    // update user
    const user = await User.findOneAndUpdate({ email }, { isApprovedIB: true });
    // 🔹 Send approval email
    await sendEmail({
      to: user.email,
      subject: "Your Introducing Broker Application Approved",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #2c3e50;">Congratulations ${
            user.fullName || "Broker"
          }!</h2>
          <p>Your application as an Introducing Broker has been <strong style="color:green;">approved</strong>.</p>
          
          <p><strong>Details:</strong></p>
          <ul>
            <li><strong>Email:</strong> ${user.email}</li>
            <li><strong>Referral Key:</strong> ${ib.referralCode}</li>
            <li><strong>Status:</strong> Approved</li>
            <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
          </ul>

          <p>You can now start referring clients using your referral key.</p>
          
          <p>If you have any questions, feel free to contact our support team.</p>
          <br/>
          <p>Best Regards,<br/>The Support Team</p>
        </div>
      `,
    });
    res.json({ message: "IB approved successfully", referralCode });
  } catch (err) {
    console.error("❌ Error approving IB:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Reject IB Request (Admin Side)
 */
const rejectIBByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const ib = await IB.findOne({ email });
    if (!ib) return res.status(404).json({ message: "IB request not found" });
    if (ib.approvalProvider === "veriff") return res.status(409).json({ message: "This IB application is managed by Veriff identity verification." });

    if (ib.status === "rejected") {
      return res.status(400).json({ message: "IB is already rejected" });
    }

    const rejectionReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (rejectionReason.length < 10 || rejectionReason.length > 1000) return res.status(400).json({ message: "Please give a clear rejection reason (10–1000 characters)." });

    // If this IB was previously approved, rejection is a revocation: stop
    // the referral code from matching new signups. Existing clients keep
    // their historical User.referralCode for record-keeping - only the IB's
    // outbound code and dashboard access are revoked.
    const wasApproved = ib.status === "approved";

    ib.status = "rejected";
    ib.statusReason = rejectionReason;
    ib.reasonCode = "manual_rejection";
    if (wasApproved) {
      ib.referralCode = undefined;
    }
    await ib.save();

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (wasApproved) {
      user.isApprovedIB = false;
    }
    await user.save();

    // 🔹 Send rejection email
    await sendEmail({
      to: user.email,
      subject: "Your Introducing Broker Application Rejected",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #c0392b;">Application Update</h2>
          <p>Dear ${user.fullName || "Broker"},</p>
          <p>We regret to inform you that your application as an Introducing Broker has been <strong style="color:red;">rejected</strong> at this time.</p>
          
          <p><strong>Details:</strong></p>
          <ul>
            <li><strong>Email:</strong> ${user.email}</li>
            <li><strong>Status:</strong> Rejected</li>
            <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
          </ul>

          <p><strong>Reason:</strong> ${rejectionReason.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</p>
          <p>You can apply again from your IB page. For help, contact WhatsApp support at +447999283366.</p>
          
          <br/>
          <p>Best Regards,<br/>The Support Team</p>
        </div>
      `,
    });
    res.json({ message: "IB rejected successfully" });
  } catch (err) {
    console.error("❌ Error rejecting IB:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const referralCode = async (req, res) => {
  try {
    const { email } = req.params;

    // find user by email
    const ib = await IB.findOne({ email });

    if (!ib) {
      return res.json({ status: "not_applied", canReapply: false });
    }

    // assuming your schema has `referralCode` field
    const user = ib.approvalProvider === "veriff" ? await User.findOne({ email }).select("+veriff.integrationKeyHash +kycManualReview") : null;
    return res.json(ibAutoApproval.applicationDetails(ib, user, ib.approvalProvider === "veriff" ? require("../services/veriff.service").getConfig() : null));
  } catch (err) {
    console.error("❌ Error fetching referral code:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Update IB commission for all their clients
 */
const updateIBCommission = async (req, res) => {
  const { email, sdate, edate } = req.body;

  if (!email || !sdate || !edate) {
    return res
      .status(400)
      .json({ success: false, message: "email, sdate, edate required" });
  }

  try {
    // 1️⃣ Find the IB record
    const ibRecord = await IB.findOne({ email });
    if (!ibRecord) {
      return res
        .status(404)
        .json({ success: false, message: "IB record not found" });
    }

    const referralCode = ibRecord.referralCode;
    if (!referralCode) {
      return res
        .status(400)
        .json({ success: false, message: "IB does not have a referral code" });
    }

    // 2️⃣ Find all users with the same referral code and populate accounts
    const clients = await User.find({ referralCode }).populate("accounts");
    console.log(`Found ${clients.length} clients for IB ${email}`);

    // 3️⃣ Calculate total commission
    let totalCommissionEarned = 0;

    for (const client of clients) {
      if (!client.accounts || client.accounts.length === 0) continue;

      for (const acc of client.accounts) {
        const clientCommission = await calculateClientCommission(
          acc.accountNo, // Use account number from populated Account
          sdate,
          edate
        );

        if (clientCommission > 0) {
          totalCommissionEarned += clientCommission;
        }
      }
    }

    // 4️⃣ Update IB's commission in User model
    const ibUser = await User.findOne({ email });
    if (!ibUser) {
      return res
        .status(404)
        .json({ success: false, message: "User record for IB not found" });
    }

    ibUser.commission = totalCommissionEarned;
    await ibUser.save();

    res.status(200).json({
      success: true,
      message: "IB commission updated successfully",
      totalCommission: ibUser.commission,
    });
  } catch (err) {
    console.error("Error updating IB commission:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * MT5-based IB commission calculation (v2) - companion to
 * updateIBCommission above, which is left untouched and still uses
 * MoneyPlant. This version:
 *  - resolves clients via the stable `referredByIB` ObjectId link instead
 *    of a live referralCode string match, so it isn't affected by the
 *    IB's code being rotated/revoked after clients were referred;
 *  - pulls trade history from MT5 (utils/commissionServiceV2.js) instead
 *    of MoneyPlant;
 *  - is read-only: it reports a computed total but does NOT write to
 *    User.commission, so it can be run side by side with the v1 flow for
 *    comparison without risking the real commission ledger.
 */
const updateIBCommissionV2 = async (req, res) => {
  const { email, sdate, edate } = req.body;

  if (!email || !sdate || !edate) {
    return res
      .status(400)
      .json({ success: false, message: "email, sdate, edate required" });
  }

  try {
    const ibRecord = await IB.findOne({ email });
    if (!ibRecord) {
      return res
        .status(404)
        .json({ success: false, message: "IB record not found" });
    }

    let fromUnix, toUnix;
    try {
      fromUnix = parseToUnixSeconds(sdate, "sdate");
      toUnix = parseToUnixSeconds(edate, "edate");
    } catch (parseError) {
      return res
        .status(400)
        .json({ success: false, message: parseError.message });
    }

    const clients = await User.find({ referredByIB: ibRecord._id }).populate(
      "accounts"
    );
    console.log(`[v2] Found ${clients.length} clients for IB ${email}`);

    let totalCommissionEarned = 0;
    const breakdown = [];

    for (const client of clients) {
      if (!client.accounts || client.accounts.length === 0) continue;

      for (const acc of client.accounts) {
        const clientCommission = await calculateClientCommissionV2(
          acc.accountNo,
          fromUnix,
          toUnix
        );

        if (clientCommission > 0) {
          totalCommissionEarned += clientCommission;
          breakdown.push({
            clientEmail: client.email,
            accountNo: acc.accountNo,
            commission: clientCommission,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message:
        "IB commission calculated (v2, MT5-based) - not saved to User.commission",
      totalCommission: totalCommissionEarned,
      clientsChecked: clients.length,
      breakdown,
    });
  } catch (err) {
    console.error("Error calculating IB commission (v2):", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * MT5-webhook-based IB commission calculation (v3) - companion to
 * updateIBCommission (v1, MoneyPlant) and updateIBCommissionV2 (v2, live
 * MT5 DealGetPage calls) above, both left untouched. This version reads
 * from the local `Deal` collection (utils/commissionServiceV3.js), which
 * is populated by MT5's own server-side trade webhook
 * (controllers/mt5WebhookController.js) instead of calling MT5 live for
 * every request. Same as v2, this is read-only: it reports a computed
 * total but does NOT write to User.commission.
 */
const updateIBCommissionV3 = async (req, res) => {
  const { email, sdate, edate } = req.body;

  if (!email || !sdate || !edate) {
    return res
      .status(400)
      .json({ success: false, message: "email, sdate, edate required" });
  }

  try {
    const ibRecord = await IB.findOne({ email });
    if (!ibRecord) {
      return res
        .status(404)
        .json({ success: false, message: "IB record not found" });
    }

    const clients = await User.find({ referredByIB: ibRecord._id }).populate(
      "accounts"
    );
    console.log(`[v3] Found ${clients.length} clients for IB ${email}`);

    let totalCommissionEarned = 0;
    const breakdown = [];

    for (const client of clients) {
      if (!client.accounts || client.accounts.length === 0) continue;

      for (const acc of client.accounts) {
        const clientCommission = await calculateClientCommissionV3(
          acc.accountNo,
          sdate,
          edate
        );

        if (clientCommission > 0) {
          totalCommissionEarned += clientCommission;
          breakdown.push({
            clientEmail: client.email,
            accountNo: acc.accountNo,
            commission: clientCommission,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message:
        "IB commission calculated (v3, from locally stored MT5 deal webhooks) - not saved to User.commission",
      totalCommission: Number(totalCommissionEarned.toFixed(2)),
      clientsChecked: clients.length,
      breakdown,
    });
  } catch (err) {
    console.error("Error calculating IB commission (v3):", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const withdrawCommission = async (req, res) => {
  try {
    const { email, accountno, amount } = req.body;

    if (!email || !accountno || !amount) {
      return res.status(400).json({
        success: false,
        message: "email, accountno and amount are required",
      });
    }

    orderid = "ORD" + Date.now();

    // 🔹 Get the user
    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // 🔹 Check commission balance
    if (user.commission < 75) {
      return res.status(400).json({
        success: false,
        message: "Minimum $75 commission required to withdraw",
      });
    }

    if (amount > user.commission) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal amount exceeds available commission",
      });
    }

    // 🔹 Call MoneyPlant FX API to add balance
    const response = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
      { accountno, amount, orderid },
      { headers: { "Content-Type": "application/json" } }
    );

    const { response: status, message } = response.data;

    if (status === "success") {
      // 🔹 Deduct commission and save withdrawal date
      user.commission -= amount;
      user.lastWithdrawalDate = new Date();
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Withdrawal successful",
        newCommission: user.commission,
        lastWithdrawalDate: user.lastWithdrawalDate,
      });
    } else {
      return res.status(400).json({ success: false, message });
    }
  } catch (error) {
    console.error("Commission withdrawal error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * MT5-based commission withdrawal (v2) - companion to withdrawCommission
 * above, which is left completely untouched and still calls MoneyPlant.
 * This version:
 *  - credits the MT5 account via updateMT5Balance (utils/MT5/mt5Balance.js,
 *    already used elsewhere for deposits) instead of calling MoneyPlant
 *    directly;
 *  - validates amount > 0 (v1 only checks amount > commission, so a
 *    negative amount could pass and, if the payment API doesn't reject it
 *    either, would increase the ledger via `commission -= amount`);
 *  - reserves the withdrawal amount with an atomic, balance-guarded
 *    decrement BEFORE calling MT5, instead of v1's read-then-subtract-
 *    after. This is what actually closes the TOCTOU double-spend window:
 *    two concurrent requests can no longer both read the same balance,
 *    both pass validation, and both get paid out - only one can win the
 *    atomic reservation. If the MT5 call then fails, the reservation is
 *    rolled back so the ledger isn't left short for a payout that never
 *    happened.
 */
const withdrawCommissionV2 = async (req, res) => {
  try {
    const { email, accountno, amount } = req.body;

    if (!email || !accountno || !amount) {
      return res.status(400).json({
        success: false,
        message: "email, accountno and amount are required",
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a positive number",
      });
    }

    const orderid = "ORD" + Date.now();

    // Eligibility check against the current balance - not itself the
    // concurrency guard (the atomic reservation below is), just an early,
    // friendly rejection for the common "not enough commission yet" case.
    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.commission < 75) {
      return res.status(400).json({
        success: false,
        message: "Minimum $75 commission required to withdraw",
      });
    }

    if (numericAmount > user.commission) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal amount exceeds available commission",
      });
    }

    // Atomically reserve the amount - only one concurrent request can
    // succeed here even if both passed the check above against the same
    // stale read.
    const reservedUser = await User.findOneAndUpdate(
      { email, commission: { $gte: numericAmount } },
      { $inc: { commission: -numericAmount } },
      { new: true }
    );

    if (!reservedUser) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal amount exceeds available commission",
      });
    }

    let mt5Answer;
    try {
      mt5Answer = await updateMT5Balance({
        login: accountno,
        type: 2,
        balance: numericAmount,
        comment: `IB commission withdrawal ${orderid}`.substring(0, 31),
      });
    } catch (mt5Error) {
      // Payout never happened - roll back the reservation.
      await User.updateOne(
        { email },
        { $inc: { commission: numericAmount } }
      );
      console.error(
        `MT5 balance update failed (v2 withdrawal), reservation rolled back for ${email} (orderid ${orderid}):`,
        mt5Error
      );
      return res.status(502).json({
        success: false,
        message: "MT5 balance update failed, withdrawal was not processed",
        error: typeof mt5Error === "string" ? mt5Error : mt5Error?.message,
      });
    }

    const lastWithdrawalDate = new Date();
    await User.updateOne({ email }, { $set: { lastWithdrawalDate } });

    return res.status(200).json({
      success: true,
      message: "Withdrawal successful (v2, MT5-based)",
      newCommission: reservedUser.commission,
      lastWithdrawalDate,
      mt5Ticket: mt5Answer?.ticket ?? null,
    });
  } catch (error) {
    console.error("Commission withdrawal error (v2):", error.message || error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

module.exports = {
  registerIB,
  getAllIBRequests,
  approveIBByEmail,
  rejectIBByEmail,
  referralCode,
  updateIBCommission,
  updateIBCommissionV2,
  updateIBCommissionV3,
  withdrawCommission,
  withdrawCommissionV2,
};
