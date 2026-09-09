const Order = require("../../models/Order");
const Withdrawal = require("../../models/withdrawal");
const Account = require("../../models/account.model");
const User = require("../../models/User");
const sendEmail = require("../../utils/sendEmail");
const { updateMT5Balance } = require("../../utils/MT5/mt5Balance");
const fetchRate = require("./fetchRate");

/**
 * Truepay9 PG - single callback endpoint for Deposit, Withdraw, and Rollback notifications
 * Truepay9 expects: { status: boolean, message: string }
 */
exports.handleTruepay9Callback = async (req, res) => {
  try {
    const { status, type, amount, order_id, bank_tid, username, remark } = req.body;

    if (!type || !order_id || status === undefined) {
      return res.status(200).json({ status: false, message: "Invalid payload" });
    }

    const isSuccess = String(status) === "1";

    switch (type) {
      case "Deposit":
        return await handleTruepay9Deposit(req, res, { isSuccess, amount, order_id, bank_tid });
      case "Withdraw":
        return await handleTruepay9Withdraw(req, res, { isSuccess, amount, order_id, bank_tid });
      case "Rollback":
        return await handleTruepay9Rollback(req, res, { amount, order_id, bank_tid });
      default:
        console.error("❌ Truepay9 Callback: Unknown type:", type);
        return res.status(200).json({ status: false, message: "Unknown type" });
    }
  } catch (error) {
    console.error("❌ Truepay9 Callback Error:", error);
    return res.status(200).json({ status: false, message: "Server error" });
  }
};

// 🔹 Deposit notification
async function handleTruepay9Deposit(req, res, { isSuccess, amount, order_id, bank_tid }) {
  const order = await Order.findOne({ orderid: order_id });
  if (!order) {
    console.error("❌ Truepay9 Deposit: Order not found:", order_id);
    return res.status(200).json({ status: false, message: "Order not found" });
  }

  // 🔒 Idempotency guard - don't double-credit on retried callbacks
  if (order.status === "SUCCESS") {
    return res.status(200).json({ status: true, message: "Already processed" });
  }

  if (!isSuccess) {
    order.status = "FAILED";
    await order.save();
    return res.status(200).json({ status: true, message: "Deposit marked as failed" });
  }

  try {
    const accountno = order.accountNo;
    const amountINR = Number(amount);

    // 💱 Convert INR → USD
    const usdRate = await fetchRate();
    const amountUSD = (amountINR * usdRate).toFixed(2);

    const mt5Answer = await updateMT5Balance({
      login: accountno,
      type: 2,
      balance: amountUSD,
      comment: `DEP-${order_id}`.substring(0, 32),
    });

    if (mt5Answer.retcode !== "0 Done" && mt5Answer.retcode !== 0) {
      throw new Error(`MT5 Deposit Failed: ${mt5Answer.retcode}`);
    }

    order.status = "SUCCESS";
    await order.save();

    // ✅ Notify user
    const account = await Account.findOne({ accountNo: accountno }).populate("user");
    if (account) {
      await sendEmail({
        to: account.user.email,
        subject: "Deposit Successful - Balance Updated",
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
            <p>Dear ${account.user.fullName || "Customer"},</p>
            <p>Your deposit has been successfully processed and your trading balance has been updated.</p>
            <p><strong>Transaction Details:</strong></p>
            <ul>
              <li><strong>Order ID:</strong> ${order_id}</li>
              <li><strong>UTR/Bank Ref:</strong> ${bank_tid || "N/A"}</li>
              <li><strong>Amount Deposited:</strong> ₹${amountINR} (≈ $${amountUSD})</li>
              <li><strong>Status:</strong> Successful</li>
              <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
            </ul>
            <p>The amount has been credited to your trading account <strong>${accountno}</strong>.</p>
            <br/>
            <p>Best Regards,<br/>The Support Team</p>
          </div>
        `,
      });
    }

    return res.status(200).json({ status: true, message: "Deposit processed successfully" });
  } catch (err) {
    console.error("❌ Truepay9 Deposit processing error:", err.message);
    return res.status(200).json({ status: false, message: "Deposit processing failed" });
  }
}

// 🔹 Withdraw notification
async function handleTruepay9Withdraw(req, res, { isSuccess, amount, order_id, bank_tid }) {
  const withdrawal = await Withdrawal.findOne({ orderid: order_id });
  if (!withdrawal) {
    console.error("❌ Truepay9 Withdraw: Withdrawal not found:", order_id);
    return res.status(200).json({ status: false, message: "Withdrawal not found" });
  }

  if (withdrawal.status === "Completed" || withdrawal.status === "Rejected") {
    return res.status(200).json({ status: true, message: "Already processed" });
  }

  if (isSuccess) {
    withdrawal.status = "Completed";
    withdrawal.response = { bank_tid, remark: req.body.remark, provider: "truepay9" };
    await withdrawal.save();

    const user = await User.findOne({ phone: withdrawal.mobile });
    if (user) {
      await sendEmail({
        to: user.email,
        subject: "Withdrawal Successful",
        html: `
          <p>Hi ${user.fullName},</p>
          <p>Your withdrawal of ₹${withdrawal.amount} has been processed successfully.</p>
          <p><strong>Order ID:</strong> ${order_id}</p>
          <p><strong>UTR/Bank Ref:</strong> ${bank_tid || "N/A"}</p>
          <p>Thank you for using our service!</p>
        `,
      });
    }

    return res.status(200).json({ status: true, message: "Withdrawal marked as completed" });
  }

  // ❌ Failed → refund to MT5 balance
  try {
    const usdRate = await fetchRate();
    const amountUSD = (parseFloat(withdrawal.amount) * usdRate).toFixed(2);
    const refundOrderId = `RF${Date.now()}`;

    const mt5Answer = await updateMT5Balance({
      login: withdrawal.accountNo,
      type: 2,
      balance: +Math.abs(amountUSD),
      comment: `REF-${refundOrderId}`.substring(0, 32),
    });

    withdrawal.status = "Failed";
    withdrawal.response = { bank_tid, remark: req.body.remark, provider: "truepay9" };
    await withdrawal.save();

    const user = await User.findOne({ phone: withdrawal.mobile });
    if (user) {
      await sendEmail({
        to: user.email,
        subject: "Withdrawal Failed - Amount Refunded",
        html: `
          <p>Dear ${user.fullName || "Customer"},</p>
          <p>Your withdrawal request (Order ID: <b>${order_id}</b>) could not be completed.</p>
          <p>Amount Requested: ₹${withdrawal.amount}</p>
          <p>The amount has been refunded to your trading account.</p>
        `,
      });
    }

    return res.status(200).json({ status: true, message: "Withdrawal marked as failed and refunded" });
  } catch (err) {
    console.error("❌ Truepay9 Withdraw refund error:", err.message);
    return res.status(200).json({ status: false, message: "Refund processing failed" });
  }
}

// 🔹 Rollback notification (reverses a previously successful deposit)
async function handleTruepay9Rollback(req, res, { amount, order_id, bank_tid }) {
  const order = await Order.findOne({ orderid: order_id });
  if (!order) {
    console.error("❌ Truepay9 Rollback: Order not found:", order_id);
    return res.status(200).json({ status: false, message: "Order not found" });
  }

  if (order.status !== "SUCCESS") {
    return res.status(200).json({ status: false, message: "Order was not successful, nothing to roll back" });
  }

  try {
    const accountno = order.accountNo;
    const amountINR = Number(amount);
    const usdRate = await fetchRate();
    const amountUSD = (amountINR * usdRate).toFixed(2);

    // 🔻 Deduct the previously credited balance
    const mt5Answer = await updateMT5Balance({
      login: accountno,
      type: 2,
      balance: -Math.abs(amountUSD),
      comment: `RBK-${order_id}`.substring(0, 32),
    });

    if (mt5Answer.retcode !== "0 Done" && mt5Answer.retcode !== 0) {
      throw new Error(`MT5 Rollback Failed: ${mt5Answer.retcode}`);
    }

    order.status = "FAILED";
    await order.save();

    const account = await Account.findOne({ accountNo: accountno }).populate("user");
    if (account) {
      await sendEmail({
        to: account.user.email,
        subject: "Deposit Reversed",
        html: `
          <p>Dear ${account.user.fullName || "Customer"},</p>
          <p>Your previous deposit (Order ID: <b>${order_id}</b>) of ₹${amountINR} has been reversed by the payment provider.</p>
          <p>The corresponding amount has been deducted from your trading account <strong>${accountno}</strong>.</p>
          <p>If you have questions, please contact our support team.</p>
        `,
      });
    }

    return res.status(200).json({ status: true, message: "Rollback processed successfully" });
  } catch (err) {
    console.error("❌ Truepay9 Rollback processing error:", err.message);
    return res.status(200).json({ status: false, message: "Rollback processing failed" });
  }
}
