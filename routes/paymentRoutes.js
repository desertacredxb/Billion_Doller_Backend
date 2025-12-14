// route/paymentRoutes.js
const axios = require("axios");
const express = require("express");
const router = express.Router();
const {
  handlePaymentCallback,
  handleRameeCallback,
  handleCryptoCallback,
} = require("../controllers/paymentController");
const {
  encryptData,
  decryptData,
  decryptDataCrypto,
  encryptDataCrypto,
} = require("../utils/rameeCrypto");
require("dotenv").config();
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Account = require("../models/account.model");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const checkMargin = require("../middleware/checkMargin");

router.post("/callback", handlePaymentCallback);
router.post("/rameePay/callback", handleRameeCallback);
router.post("/crypto/callback", handleCryptoCallback);

let DIGIPAY_TOKEN = null;
let TOKEN_EXPIRY = null;

// Login helper
async function digiPayLogin() {
  const res = await axios.post("https://digipay247.pgbackend.xyz/login", {
    username: process.env.DIGIPAY_USERNAME,
    password: process.env.DIGIPAY_PASSWORD,
  });

  DIGIPAY_TOKEN = res.data.data.token;
  TOKEN_EXPIRY = Date.now() + res.data.data.expires_in * 1000;
  return DIGIPAY_TOKEN;
}

// Deposit route
// ✅ DIGIPAY Deposit Route
router.post("/deposit", async (req, res) => {
  try {
    const { amount, merchant_user_id } = req.body;

    if (!amount || !merchant_user_id) {
      return res.status(400).json({
        status: "FAILED",
        message: "amount and merchant_user_id required",
      });
    }

    // 1️⃣ Find account and populate user
    const account = await Account.findOne({
      accountNo: merchant_user_id,
    }).populate("user", "fullName email");
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // 2️⃣ Ensure valid token
    if (!DIGIPAY_TOKEN || Date.now() > TOKEN_EXPIRY) {
      await digiPayLogin();
    }

    // 3️⃣ Generate unique transaction/order id
    const merchant_txn_id = "ODP" + Date.now();

    // 4️⃣ Create a new Order (before hitting DigiPay)
    const newOrder = new Order({
      orderid: merchant_txn_id,
      account: account._id, // ✅ link to Account
      accountNo: account.accountNo,
      amount,
      status: "PENDING",
    });
    await newOrder.save();

    // 5️⃣ Call DigiPay API
    const response = await axios.post(
      "https://digipay247.pgbackend.xyz/payin/generate",
      {
        gateway_id: 23, // configurable
        amount: parseInt(amount, 10),
        merchant_txn_id,
        merchant_user_id,
      },
      {
        headers: { Authorization: `Bearer ${DIGIPAY_TOKEN}` },
      }
    );

    // 6️⃣ Return payment info
    return res.json({
      success: true,
      status: response.data.status,
      message: response.data.message,
      payment_url: response.data.data.url,
      transaction_id: response.data.data.transaction_id,
      merchant_txn_id,
      order: {
        orderid: newOrder.orderid,
        amount: newOrder.amount,
        status: newOrder.status,
        createdAt: newOrder.createdAt,
        accountNo: newOrder.accountNo,
        name: account.user?.fullName || "Unknown", // ✅ name now works
      },
    });
  } catch (err) {
    console.error("Deposit error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "FAILED",
      error: err.response?.data?.message || err.message,
    });
  }
});

const AGENT_CODE = process.env.RAMEEPAY_AGENT_CODE;
const CRYPTO_AGENT_CODE = process.env.CRYPTO_AGENT_CODE;
const RAMEEPAY_API = "https://apis.rameepay.io/order/generate";
const RAMEEPAY_Crypto_API = "https://crypto-apis.rameepay.io/v1/order";

router.post("/ramee/deposit", async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    if (!accountNo || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    // 1️⃣ Generate unique orderid
    const orderid = "ORP" + Date.now();

    // 2️⃣ Find account (to save reference)
    const account = await Account.findOne({ accountNo });
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // 3️⃣ Save new order
    const newOrder = new Order({
      orderid,
      account: account._id, // ✅ link to Account
      accountNo: account.accountNo, // backup string
      amount,
      status: "PENDING", // default
    });
    await newOrder.save();

    // 4️⃣ Prepare payload for RameePay (only orderid & amount required)
    const orderData = { orderid, amount };

    // Encrypt payload
    const encryptedData = encryptData(orderData);

    const body = {
      reqData: encryptedData,
      agentCode: AGENT_CODE,
    };

    //  5️⃣ Send to RameePay
    const { data } = await axios.post(RAMEEPAY_API, body, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(data);

    // 6️⃣Decrypt response if exists
    let decryptedResponse = {};
    if (data.data) {
      decryptedResponse = decryptData(data.data);
      console.log("✅ Decrypted Response:", decryptedResponse);
    }

    // 7️⃣ Return response to frontend
    res.json({
      success: true,
      message: "Order created & sent to RameePay",
      order: {
        orderid: newOrder.orderid,
        amount: newOrder.amount,
        status: newOrder.status,
        createdAt: newOrder.createdAt,
        accountNo: newOrder.accountNo,
        name: account.user?.fullName || "Unknown", // ✅ now included
      },
      raw: data,
      decrypted: decryptedResponse,
    });
  } catch (err) {
    console.error("❌ Deposit Error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: "ServerError",
      message: err.message,
    });
  }
});

router.post("/crypto/deposit", async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    if (!accountNo || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    // 1️⃣ Generate unique orderid
    const orderid = "OCP" + Date.now();

    // 2️⃣ Find account (to save reference)
    const account = await Account.findOne({ accountNo });
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // 3️⃣ Save new order
    const newOrder = new Order({
      orderid,
      account: account._id, // ✅ link to Account
      accountNo: account.accountNo, // backup string
      amount,
      status: "PENDING", // default
    });
    await newOrder.save();

    // 4️⃣ Prepare payload for RameePay (only orderid & amount required)
    const orderData = { orderid, amount };

    // Encrypt payload
    const encryptedData = encryptDataCrypto(orderData);
    console.log("Encrypted Data:", encryptedData);

    const body = {
      data: encryptedData,
      agentCode: CRYPTO_AGENT_CODE,
    };
    console.log(body);

    //  5️⃣ Send to RameePay
    const { data } = await axios.post(RAMEEPAY_Crypto_API, body, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(data);

    // 6️⃣Decrypt response if exists
    let decryptedResponse = {};
    if (data.data) {
      decryptedResponse = decryptDataCrypto(data.data);
      console.log("✅ Decrypted Response:", decryptedResponse);
    }

    // 7️⃣ Return response to frontend
    res.json({
      success: true,
      message: "Order created & sent to RameePay",
      order: {
        orderid: newOrder.orderid,
        amount: newOrder.amount,
        status: newOrder.status,
        createdAt: newOrder.createdAt,
        accountNo: newOrder.accountNo,
        name: account.user?.fullName || "Unknown", // ✅ now included
      },
      raw: data,
      decrypted: decryptedResponse,
    });
  } catch (err) {
    console.error("❌ Deposit Error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: "ServerError",
      message: err.message,
    });
  }
});

async function fetchRate() {
  try {
    const res = await axios.get(
      "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD"
    );
    return res.data.rates.USD; // 1 INR = ? USD
  } catch (err) {
    console.error("Error fetching INR→USD rate:", err.message);
    return 0.012; // fallback rate if API fails
  }
}

const RAMEEPAY_WITHDRAWAL_API = "https://apis.rameepay.io/withdrawal/account";

// Save withdrawal request as Pending
router.post("/request", checkMargin, async (req, res) => {
  try {
    const { account, ifsc, name, mobile, amount, note, accountNo } = req.body;

    if (!account || !ifsc || !name || !mobile || !amount || !accountNo) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    const orderid = `WDR${Date.now()}`;

    // 🔹 First, deduct from MoneyPlant to lock balance
    const usdRate = await fetchRate();
    const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

    await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
      {
        accountno: accountNo,
        amount: -Math.abs(amountUSD),
        orderid,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    // 🔹 Save withdrawal record in Pending state
    const withdrawalRecord = new Withdrawal({
      orderid,
      account,
      ifsc,
      name,
      mobile,
      amount,
      note,
      accountNo,
      status: "Pending",
    });
    await withdrawalRecord.save();

    // ✅ Send email to admin
    await sendEmail({
      to: "chandanpms@gmail.com",
      subject: "⚠️ New Withdrawal Request Pending Approval",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #e74c3c;">New Withdrawal Request</h2>
          <p>A user has requested a withdrawal. Please review and approve in the admin dashboard.</p>

          <p><strong>User Details:</strong></p>
          <ul>
            <li><strong>Name:</strong> ${name}</li>
            <li><strong>Account:</strong> ${account}</li>
            <li><strong>Account No:</strong> ${accountNo}</li>
            <li><strong>IFSC:</strong> ${ifsc}</li>
            <li><strong>Mobile:</strong> ${mobile}</li>
          </ul>

          <p><strong>Withdrawal Details:</strong></p>
          <ul>
            <li><strong>Order ID:</strong> ${orderid}</li>
            <li><strong>Amount:</strong> ₹${amount} (≈ $${amountUSD})</li>
            <li><strong>Note:</strong> ${note || "N/A"}</li>
            <li><strong>Status:</strong> Pending</li>
          </ul>

          <p>✅ Next Step: Please approve this withdrawal in the dashboard and contact the user if necessary.</p>

          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
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
});

router.post("/approve/:id", async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    if (withdrawal.status !== "Pending") {
      return res
        .status(400)
        .json({ success: false, message: "Already processed" });
    }

    const { account, ifsc, name, mobile, amount, note, orderid, accountNo } =
      withdrawal;

    // 🔹 Payload for RameePay (amount must be string with 2 decimals)
    const payload = {
      account,
      ifsc,
      name,
      mobile,
      amount: parseFloat(amount).toFixed(2), // e.g. "1000.00"
      note,
      orderid,
    };

    // Encrypt
    const encryptedData = encryptData(payload);
    const body = { reqData: encryptedData, agentCode: AGENT_CODE };

    // Call API
    const { data } = await axios.post(RAMEEPAY_WITHDRAWAL_API, body, {
      headers: { "Content-Type": "application/json" },
    });

    console.log("🔒 Raw RameePay Response:", data);

    let decryptedResponse = {};
    if (data.data) {
      if (typeof data.data === "string") {
        decryptedResponse = decryptData(data.data);
      } else {
        console.error(
          "Expected string in data.data, got:",
          typeof data.data,
          data.data
        );
        decryptedResponse = data.data; // fallback, store raw object
      }
    }

    console.log("🔓 Decrypted RameePay Response:", decryptedResponse);

    // ✅ Check based on decryptedResponse.success
    if (decryptedResponse && decryptedResponse.success === true) {
      withdrawal.status = "Completed";
      withdrawal.response = decryptedResponse;
      await withdrawal.save();

      // Send success email
      const user = await User.findOne({ phone: withdrawal.mobile });
      if (user) {
        const usdRate = await fetchRate();
        const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

        await sendEmail({
          to: user.email,
          subject: "Withdrawal Successful",
          html: `
    <p>Hi ${user.fullName},</p>
    <p>Your withdrawal of ₹${amount} (≈ $${amountUSD}) is successful.</p>
    <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Withdrawal_Processed_p4rluh.jpg" 
         alt="Withdrawal Processed" 
         style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
    <p>Thank you for using our service!</p>
  `,
        });
      }

      return res.json({
        success: true,
        message: decryptedResponse.message || "Withdrawal completed",
        response: decryptedResponse,
      });
    } else {
      // ❌ Failed → refund via MoneyPlant
      const usdRate = await fetchRate();
      const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);
      const refundOrderId = `RF${Date.now()}`;

      await axios.post(
        "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
        {
          accountno: accountNo,
          amount: +Math.abs(amountUSD),
          orderid: refundOrderId,
        },
        { headers: { "Content-Type": "application/json" } }
      );

      withdrawal.status = "Failed";
      withdrawal.response = decryptedResponse;
      await withdrawal.save();

      return res.json({
        success: false,
        message:
          decryptedResponse?.message || "Withdrawal failed, amount refunded",
        response: decryptedResponse,
      });
    }
  } catch (err) {
    console.error("Withdrawal approval error:", err);

    const decryptedData =
      err.response?.data?.data && typeof err.response.data.data === "string"
        ? decryptData(err.response.data.data)
        : null;

    res.status(500).json({
      success: false,
      error:
        decryptedData?.message || err.message || "Withdrawal processing failed",
    });
  }
});

// Reject withdrawal request (Admin action)
router.post("/reject/:id", async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) {
      return res
        .status(404)
        .json({ success: false, message: "Withdrawal not found" });
    }

    if (withdrawal.status !== "Pending") {
      return res
        .status(400)
        .json({ success: false, message: "Withdrawal already processed" });
    }

    // 🔹 Refund via MoneyPlant
    const usdRate = await fetchRate();
    const amountUSD = (parseFloat(withdrawal.amount) * usdRate).toFixed(2);

    const refundOrderId = `RF${Date.now()}`;

    console.log(withdrawal.accountNo, amountUSD, refundOrderId);

    await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
      {
        accountno: withdrawal.accountNo,
        amount: +Math.abs(amountUSD),
        orderid: refundOrderId,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    withdrawal.status = "Rejected";
    withdrawal.response = { message: "Rejected by admin" };
    await withdrawal.save();

    // Notify user
    const user = await User.findOne({ phone: withdrawal.mobile });
    // console.log(user);
    if (user) {
      await sendEmail({
        to: user.email,
        subject: "Withdrawal Request Rejected",
        html: `
          <p>Dear ${user.fullName || "Customer"},</p>
          <p>Your withdrawal request (Order ID: <b>${
            withdrawal.orderid
          }</b>) has been <b>rejected</b> by the admin.</p>
          <p>Amount Requested: ₹${withdrawal.amount}</p>
          <p>The amount has been refunded to your account.</p>
          <br/>
          <p>Best Regards,<br/>Support Team</p>
        `,
      });
    }

    res.json({ success: true, message: "Withdrawal rejected & refunded" });
  } catch (err) {
    console.error(
      "❌ Reject withdrawal error:",
      err.message,
      err.response?.data
    );
    res.status(500).json({
      success: false,
      error:
        err.response?.data?.message ||
        err.message ||
        "Failed to reject withdrawal",
    });
  }
});

router.get("/withdrawals", async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ status: "Pending" }).sort({
      createdAt: -1,
    });
    res.json({ success: true, data: withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/deposit/:accountNo", async (req, res) => {
  try {
    const { accountNo } = req.params;

    // Find all deposits for this account, sorted by latest first
    const deposits = await Order.find({ accountNo }).sort({ createdAt: -1 });

    // ✅ Return success with empty array if no deposits
    if (!deposits || deposits.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        deposits: [],
        message: "No deposits found for this account",
      });
    }

    res.status(200).json({
      success: true,
      count: deposits.length,
      deposits,
    });
  } catch (err) {
    console.error("❌ Error fetching deposits:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/withdrawal/:accountNo", async (req, res) => {
  try {
    const { accountNo } = req.params;

    // Find all withdrawals for this account, latest first
    const withdrawals = await Withdrawal.find({ accountNo }).sort({
      createdAt: -1,
    });

    if (!withdrawals || withdrawals.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        withdrawals: [],
        message: "No withdrawals found for this account",
      });
    }

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      withdrawals,
    });
  } catch (err) {
    console.error("❌ Error fetching withdrawals:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/deposit", async (req, res) => {
  try {
    const deposits = await Order.find()
      .sort({ createdAt: -1 })
      .populate({
        path: "account",
        select: "accountNo balance user", // pick only what you need
        populate: {
          path: "user",
          select: "fullName email", // adjust based on your User schema
        },
      });

    if (!deposits || deposits.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No deposits found",
      });
    }

    const formatted = deposits.map((d) => ({
      orderid: d.orderid,
      amount: d.amount,
      status: d.status,
      createdAt: d.createdAt,
      accountNo: d.account?.accountNo || d.accountNo, // fallback
      balance: d.account?.balance || 0,
      userName: d.account?.user?.fullName || "Unknown",
    }));

    res.status(200).json({
      success: true,
      count: formatted.length,
      deposits: formatted,
    });
  } catch (err) {
    console.error("❌ Error fetching deposits:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/withdrawal", async (req, res) => {
  try {
    // Find all withdrawals for this account, latest first
    const withdrawals = await Withdrawal.find().sort({
      createdAt: -1,
    });

    if (!withdrawals || withdrawals.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No withdrawals found ",
      });
    }

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      withdrawals,
    });
  } catch (err) {
    console.error("❌ Error fetching withdrawals:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
module.exports = router;
