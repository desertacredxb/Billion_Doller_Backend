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

/**
 * 📌 Register IB Request (User Side)
 */
const registerIB = async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ message: 'Sign in to apply as an IB.' });
    const {
      email: requestedEmail,
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB,
      yourShare,
      clientShare,
    } = req.body;

    // Derive the applicant from the signed session, never a submitted email.
    const user = await User.findById(req.user.id);
    if (!user || !user.isVerified ||
        typeof requestedEmail !== 'string' || requestedEmail.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(403).json({ message: 'This account cannot submit this IB application.' });
    }
    const email = user.email;

    // check if already requested
    const existingIB = await IB.findOne({ email });
    if (existingIB) {
      return res.status(400).json({ message: "IB request already submitted" });
    }

    const newIB = new IB({
      email,
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB,
      yourShare,
      clientShare,
    });

    // Only a completed provider review can approve a new IB automatically.
    if (process.env.BDFX_KYC_AUTOMATION_ENABLED === 'true' &&
        process.env.BDFX_KYC_RELEASE_APPROVED === 'true' &&
        process.env.SUMSUB_MODE === 'production' && process.env.SUMSUB_CLIENT_ID &&
        process.env.SUMSUB_LEVEL_NAME && process.env.SUMSUB_LEVEL_NAME !== 'bdfx-kyc-sandbox' &&
        user.isKycVerified && user.kycAutomation?.status === 'approved' &&
        user.kycAutomation.provider === 'sumsub' && user.kycAutomation.reviewId &&
        user.kycAutomation.processedAt) {
      const crypto = require('node:crypto');
      newIB.status = 'approved';
      newIB.referralCode = `IB${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    }

    await newIB.save();
    if (newIB.status === 'approved') {
      await User.updateOne({ _id: user._id }, { $set: { isApprovedIB: true } });
      await sendEmail({ to: user.email, subject: 'Your BDFX IB application is approved',
        text: `Your IB application is approved. Your referral code is ${newIB.referralCode}.` });
      return res.status(201).json({ message: 'IB application approved', referralCode: newIB.referralCode });
    }

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "🚀 New IB Request Submitted",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #1abc9c;">New Introducing Broker Request</h2>
          <p>A user has submitted a new IB request. Please review and approve in the admin dashboard.</p>
          
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
            <li><strong>Expected Commission (Sub IB):</strong> ${expectedCommissionSubIB}</li>
            <li><strong>Your Share:</strong> ${yourShare}</li>
            <li><strong>Client Share:</strong> ${clientShare}</li>
          </ul>

          <p>✅ Next Step: Please approve this IB request in the dashboard and contact the user if necessary.</p>

          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
        </div>
      `,
    });

    res
      .status(201)
      .json({ message: "IB request submitted successfully", newIB });
  } catch (err) {
    console.error("❌ Error submitting IB request:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Get All IB Requests (Admin Side)
 */
const getAllIBRequests = async (req, res) => {
  try {
    const ibRequests = await IB.find().sort({ createdAt: -1 });
    // Attach commission from User schema
    const result = await Promise.all(
      ibRequests.map(async (ib) => {
        const user = await User.findOne({ email: ib.email }, "commission");
        return {
          ...ib.toObject(),
          commission: user ? user.commission : null, // add commission field
        };
      })
    );

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

    if (ib.status === "rejected") {
      return res.status(400).json({ message: "IB is already rejected" });
    }

    // If this IB was previously approved, rejection is a revocation: stop
    // the referral code from matching new signups. Existing clients keep
    // their historical User.referralCode for record-keeping - only the IB's
    // outbound code and dashboard access are revoked.
    const wasApproved = ib.status === "approved";

    ib.status = "rejected";
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

          <p>If you believe this was a mistake or would like to reapply, please contact our support team for further guidance.</p>
          
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
      return res.status(404).json({ message: "IB not found" });
    }

    // assuming your schema has `referralCode` field
    return res.json({ referralCode: ib.referralCode });
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
