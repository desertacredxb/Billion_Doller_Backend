const { default: mongoose } = require("mongoose");
const Withdrawal = require("../../models/withdrawal");
const sendEmail = require("../../utils/sendEmail");
const fetchRate = require("./fetchRate");
const {
  MIN_WITHDRAWAL_INR,
  WITHDRAWAL_COOLDOWN_MINUTES,
  MAX_WITHDRAWALS_PER_DAY,
} = require("../../config/withdrawalLimits");

exports.handleManualPaymentRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { ifsc, name, mobile, amount, note, accountNo, bankName, paymentMethod, upiId } = req.body;

    if (!name || !mobile || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    const method = paymentMethod === "upi" ? "upi" : "bank";

    if (method === "bank" && (!ifsc || !bankName || !accountNo)) {
      return res.status(400).json({
        success: false,
        message: "IFSC, Bank Name, and Account Number are required for bank transfer",
      });
    }

    if (method === "upi" && !upiId) {
      return res.status(400).json({
        success: false,
        message: "UPI ID is required",
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid withdrawal amount" });
    }

    // This manual flow is INR-only (bank transfer / UPI), see config/withdrawalLimits.js.
    if (numericAmount < MIN_WITHDRAWAL_INR) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL_INR}.`,
      });
    }

    // 🔒 1️⃣ BLOCK MULTIPLE PENDING
    const existingPending = await Withdrawal.findOne(
      { accountNo, status: "Pending" },
      null,
      { session },
    );

    if (existingPending) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "You already have a pending withdrawal request.",
      });
    }

    // COOLDOWN CHECK
    const lastWithdrawal = await Withdrawal.findOne({ accountNo }, null, {
      session,
    }).sort({ createdAt: -1 });

    if (lastWithdrawal) {
      const diff = Date.now() - new Date(lastWithdrawal.createdAt).getTime();
      const cooldownMs = WITHDRAWAL_COOLDOWN_MINUTES * 60 * 1000;

      if (diff < cooldownMs) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `You can only request withdrawal once every ${WITHDRAWAL_COOLDOWN_MINUTES} minutes.`,
        });
      }
    }

    // DAILY LIMIT CHECK
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await Withdrawal.countDocuments(
      {
        accountNo,
        createdAt: { $gte: startOfDay },
      },
      { session },
    );

    if (todayCount >= MAX_WITHDRAWALS_PER_DAY) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Daily withdrawal limit reached (${MAX_WITHDRAWALS_PER_DAY} per day).`,
      });
    }

    const orderid = `WDR${Date.now()}`;

    // 🔹 First, deduct from MoneyPlant to lock balance
    const usdRate = await fetchRate();
    const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

    // 🔹 Save withdrawal record in Pending state
    const withdrawalRecord = new Withdrawal({
      orderid,
      name,
      mobile,
      amount,
      note,
      accountNo,
      status: "Pending",
      isManual: true,
      bankName: method === "bank" ? bankName : "",
      ifsc: method === "bank" ? ifsc : "",
      upiId: method === "upi" ? upiId : null,
    });
    await withdrawalRecord.save();

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "📤 New Manual Withdrawal Request Submitted",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #f39c12;">New Manual Withdrawal Request Submitted</h2>

      <p>
        A new withdrawal request has been submitted by a user using manually entered bank details and is awaiting review.
      </p>

      <ul>
        <li><strong>Withdrawal Type:</strong> Manual Bank Details Submission</li>
        <li><strong>Name:</strong> ${name}</li>
        <li><strong>Order ID:</strong> ${orderid}</li>
        <li><strong>Amount:</strong> ₹${amount} (≈ $${amountUSD})</li>
        <li><strong>Payment Method:</strong> ${method === "upi" ? "UPI" : "Bank Transfer"}</li>
          ${method === "bank"
          ? `<li><strong>Bank Name:</strong> ${bankName}</li>
       <li><strong>Account Number:</strong> ${accountNo}</li>
       <li><strong>IFSC:</strong> ${ifsc}</li>`
          : `<li><strong>UPI ID:</strong> ${upiId}</li>`
        }
        <li><strong>Mobile:</strong> ${mobile}</li>
        <li><strong>Note:</strong> ${note || "N/A"}</li>
      </ul>

      <p>
        Please log in to the admin dashboard to review and process this withdrawal request.
      </p>

      <br />
      <p>
        Regards,<br />
        <strong>Billion Dollar FX System</strong>
      </p>
    </div>
  `,
    });

    res.json({
      success: true,
      message: "Withdrawal request submitted",
      withdrawalRecord,
    });
  } catch (err) {
    console.error("❌ Error saving withdrawal request:", err.message);
    res.status(500).json({ success: false, error: "Failed to save request" });
  }
};
