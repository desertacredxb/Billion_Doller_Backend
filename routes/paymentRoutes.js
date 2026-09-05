// route/paymentRoutes.js
const axios = require("axios");
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const {
  handlePaymentCallback,
  handleRameeCallback,
  handleCryptoCallback,
  handleManualPaymentRequest,
  handleTruepay9Callback, 
  handleCregisCallback,
  handleTrustpay24Callback} = require("../controllers/paymentController");
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

const rateLimit = require("express-rate-limit");
const { createCregisCheckout } = require("../controllers/paymentOrder.controller");
const { createPayoutRequest, approvePayoutReq } = require("../controllers/payout.controller");
const { updateMT5Balance } = require("../utils/MT5/mt5Balance");

const withdrawalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2,
  message: "Too many withdrawal attempts. Please wait.",
});

router.post("/callback", handlePaymentCallback);
router.post("/rameePay/callback", handleRameeCallback);
router.post("/crypto/callback", handleCryptoCallback);
router.post("/truepay9/callback", handleTruepay9Callback);
router.post("/trustpay24/callback", handleTrustpay24Callback);
router.post("/cregis/callback", handleCregisCallback);


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
      },
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
const TRUEPAY9_API = "https://truepay9.com/api/iframe/createOrder";
const TRUSTPAY_API = "https://trustpay24.online";

// router.post("/truepay9/deposit", async (req, res) => {
//   try {
//     const { accountNo, amount } = req.body;
//     console.log(accountNo, amount)
//     const numericAmount = Number(amount);

//     if (!accountNo || !Number.isFinite(numericAmount) || numericAmount < 1000) {
//       return res.status(400).json({
//         success: false,
//         message: "A valid account number and minimum amount of 1000 are required",
//       });
//     }

//     if (!process.env.TRUEPAY9_ACCESS_KEY) {
//       console.error("Truepay9 deposit: TRUEPAY9_ACCESS_KEY is not configured");
//       return res.status(503).json({
//         success: false,
//         message: "Truepay9 is not configured",
//       });
//     }

//     const account = await Account.findOne({ accountNo });
//     if (!account) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Account not found" });
//     }

//     const { data } = await axios.post(
//       TRUEPAY9_API,
//       {
//         amount: numericAmount,
//         access_key: process.env.TRUEPAY9_ACCESS_KEY,
//         username: String(account.accountNo),
//       },
//       { headers: { "Content-Type": "application/json" } },
//     );

//     const providerOrderId = data?.data?.order_id;
//     const paymentUrl = data?.data?.pay;

//     if (!data?.status || !providerOrderId || !paymentUrl) {
//       console.error("Truepay9 create order rejected:", data?.message);
//       return res.status(502).json({
//         success: false,
//         message: data?.message || "Truepay9 did not create the order",
//       });
//     }

//     const order = await Order.create({
//       orderid: String(providerOrderId),
//       account: account._id,
//       accountNo: String(account.accountNo),
//       amount: numericAmount,
//       status: "PENDING",
//     });

//     return res.json({
//       success: true,
//       message: data.message || "Order created successfully",
//       payment_url: paymentUrl,
//       order_id: order.orderid,
//     });
//   } catch (err) {
//     console.error("Truepay9 deposit error:", err.response?.data || err.message);
//     return res.status(502).json({
//       success: false,
//       message:
//         err.response?.data?.message || "Unable to create Truepay9 deposit",
//     });
//   }
// });

// router.post("/trustpay24/deposit", async (req, res) => {
//   try {
//     const { accountNo, amount } = req.body;
//     console.log(accountNo, amount)
//     const numericAmount = Number(amount);

//     if (!accountNo || !Number.isFinite(numericAmount) || numericAmount < 1000) {
//       return res.status(400).json({
//         success: false,
//         message: "A valid account number and minimum amount of 1000 are required",
//       });
//     }

//     if (!process.env.TRUEPAY9_ACCESS_KEY) {
//       console.error("Truepay9 deposit: TRUEPAY9_ACCESS_KEY is not configured");
//       return res.status(503).json({
//         success: false,
//         message: "Truepay9 is not configured",
//       });
//     }

//     const account = await Account.findOne({ accountNo }).populate('user', 'fullName phone');
//     if (!account) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Account not found" });
//     }

//     const { data } = await axios.post(
//       TRUSTPAY_API,
//       {
//         merchant_order_id: "ORD1001",
//         amount: numericAmount,
//         customer_name: String(account.accountNo),
//         customer_mobile: account.user.fullName,
//         webhook_url: "https://billion-doller-backend.onrender.com/api/payment/rameePay/callback",
//         redirect_url: "https://www.billiondollarfx.com/transactions"
//       },
//       {
//         headers: {
//           "x-api-key": process.env.TRUSTPAY_API_KEY,
//           "Content-Type": "application/json",
//         }
//       },
//     );

//     const providerOrderId = data?.data?.order_id;
//     const paymentUrl = data?.data?.pay;

//     if (!data?.status || !providerOrderId || !paymentUrl) {
//       console.error("Truepay9 create order rejected:", data?.message);
//       return res.status(502).json({
//         success: false,
//         message: data?.message || "Truepay9 did not create the order",
//       });
//     }

//     const order = await Order.create({
//       orderid: String(providerOrderId),
//       account: account._id,
//       accountNo: String(account.accountNo),
//       amount: numericAmount,
//       status: "PENDING",
//     });

//     return res.json({
//       success: true,
//       message: data.message || "Order created successfully",
//       payment_url: paymentUrl,
//       order_id: order.orderid,
//     });
//   } catch (err) {
//     console.error("Truepay9 deposit error:", err.response?.data || err.message);
//     return res.status(502).json({
//       success: false,
//       message:
//         err.response?.data?.message || "Unable to create Truepay9 deposit",
//     });
//   }
// });

router.post("/cregis/deposit", createCregisCheckout);

router.post("/trustpay24/deposit", async (req, res) => {
  try {
    const { accountNo, amount } = req.body;
    console.log("Deposit request:", accountNo, amount);

    const numericAmount = Number(amount);

    // Validate request
    if (
      !accountNo ||
      !Number.isFinite(numericAmount) ||
      numericAmount < 1000
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid account number and minimum amount of 1000 are required",
      });
    }

    // console.log("process.env.TRUSTPAY_API_KEY", process.env.TRUSTPAY_API_KEY)
    // Validate API key
    if (!process.env.TRUSTPAY_API_KEY) {
      console.error(
        "TrustPay24 deposit: TRUSTPAY_API_KEY is not configured"
      );

      return res.status(503).json({
        success: false,
        message: "TrustPay24 is not configured",
      });
    }

    // Find account
    const account = await Account.findOne({ accountNo }).populate(
      "user",
      "fullName phone"
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // Generate unique merchant order ID
    const merchantOrderId = `ORD${Date.now()}${Math.floor(
      Math.random() * 1000
    )}`;

    // TrustPay24 checkout API
    const { data } = await axios.post(
      `${TRUSTPAY_API}/api/payin/checkout/create`,
      {
        merchant_order_id: merchantOrderId,
        amount: numericAmount,
        customer_name: account.user?.fullName || String(account.accountNo),
        customer_mobile: account.user?.phone || "",
        webhook_url:
          "https://billion-doller-backend.onrender.com/api/payment/trustpay24/callback",
        redirect_url: "https://www.billiondollarfx.com/transactions",
      },
      {
        headers: {
          "x-api-key": process.env.TRUSTPAY_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("TrustPay24 response:", data);

    // Validate provider response
    if (
      !data?.success ||
      !data?.transaction_ref ||
      !data?.checkout_url
    ) {
      console.error(
        "TrustPay24 create checkout rejected:",
        data?.message || data
      );

      return res.status(502).json({
        success: false,
        message:
          data?.message || "TrustPay24 did not create the checkout",
      });
    }

    // Save order in database
    const order = await Order.create({
      orderid: String(data.transaction_ref),
      account: account._id,
      accountNo: String(account.accountNo),
      amount: numericAmount,
      status: "PENDING",
    });

    return res.json({
      success: true,
      message: "Checkout created successfully",

      // Internal order
      order_id: order.orderid,

      // TrustPay24 details
      transaction_id: data.transaction_id,
      transaction_ref: data.transaction_ref,
      merchant_order_id: data.merchant_order_id,
      amount: data.amount,
      status: data.status,
      checkout_url: data.checkout_url,
      expires_at: data.expires_at,
      expires_in_seconds: data.expires_in_seconds,
    });
  } catch (err) {
    console.error(
      "TrustPay24 deposit error:",
      err.response?.data || err.message
    );

    return res.status(502).json({
      success: false,
      message:
        err.response?.data?.message ||
        "Unable to create TrustPay24 deposit",
    });
  }
});

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
    console.log("encryypted data", encryptedData)

    const body = {
      reqData: encryptedData,
      agentCode: AGENT_CODE,
    };

    // //  5️⃣ Send to RameePay
    // const res = await axios.post(RAMEEPAY_API, body, {
    //   headers: { "Content-Type": "application/json" },
    // });
    // console.log("res", res);

    // // 6️⃣Decrypt response if exists
    // let decryptedResponse = {};
    // if (data.data) {
    //   decryptedResponse = decryptData(data.data);
    //   console.log("✅ Decrypted Response:", decryptedResponse);
    // }

    // // 7️⃣ Return response to frontend
    // res.json({
    //   success: true,
    //   message: "Order created & sent to RameePay",
    //   order: {
    //     orderid: newOrder.orderid,
    //     amount: newOrder.amount,
    //     status: newOrder.status,
    //     createdAt: newOrder.createdAt,
    //     accountNo: newOrder.accountNo,
    //     name: account.user?.fullName || "Unknown", // ✅ now included
    //   },
    //   raw: data,
    //   decrypted: decryptedResponse,
    // });

    //  5️⃣ Send to RameePay
    const apiRes = await axios.post(RAMEEPAY_API, body, {
      headers: { "Content-Type": "application/json" },
    });
    console.log("res", apiRes.data);

    // 6️⃣ Decrypt response if exists
    let decryptedResponse = {};
    if (apiRes.data?.data) {
      decryptedResponse = decryptData(apiRes.data.data);
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
        name: account.user?.fullName || "Unknown",
      },
      raw: apiRes.data,
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

exports.fetchRate = async () => {
  try {
    const res = await axios.get(
      "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD",
    );
    return res.data.rates.USD; // 1 INR = ? USD
  } catch (err) {
    console.error("Error fetching INR→USD rate:", err.message);
    return 0.012; // fallback rate if API fails
  }
}

const RAMEEPAY_WITHDRAWAL_API = "https://apis.rameepay.io/withdrawal/account";

// Save withdrawal request as Pending
// router.post("/request", withdrawalLimiter, checkMargin, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const { account, ifsc, name, mobile, amount, note, accountNo } = req.body;

//     if (!account || !ifsc || !name || !mobile || !amount || !accountNo) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Missing fields" });
//     }

//     const numericAmount = parseFloat(amount);
//     if (isNaN(numericAmount) || numericAmount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, message: "Invalid withdrawal amount" });
//     }

//     // 🔒 1️⃣ BLOCK MULTIPLE PENDING
//     const existingPending = await Withdrawal.findOne(
//       { accountNo, status: "Pending" },
//       null,
//       { session },
//     );

//     if (existingPending) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({
//         success: false,
//         message: "You already have a pending withdrawal request.",
//       });
//     }

//     // 5 MINUTE COOLDOWN
//     const lastWithdrawal = await Withdrawal.findOne({ accountNo }, null, {
//       session,
//     }).sort({ createdAt: -1 });

//     if (lastWithdrawal) {
//       const diff = Date.now() - new Date(lastWithdrawal.createdAt).getTime();
//       const fiveMinutes = 5 * 60 * 1000;

//       if (diff < fiveMinutes) {
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(400).json({
//           success: false,
//           message: "You can only request withdrawal once every 5 minutes.",
//         });
//       }
//     }

//     // DAILY LIMIT (3 per day)
//     const startOfDay = new Date();
//     startOfDay.setHours(0, 0, 0, 0);

//     const todayCount = await Withdrawal.countDocuments(
//       {
//         accountNo,
//         createdAt: { $gte: startOfDay },
//       },
//       { session },
//     );

//     if (todayCount >= 3) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({
//         success: false,
//         message: "Daily withdrawal limit reached (3 per day).",
//       });
//     }

//     const orderid = `WDR${Date.now()}`;

//     // 🔹 First, deduct from MoneyPlant to lock balance
//     const usdRate = await fetchRate();
//     const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

//     await axios.post(
//       "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
//       {
//         accountno: accountNo,
//         amount: -Math.abs(amountUSD),
//         orderid,
//       },
//       { headers: { "Content-Type": "application/json" } },
//     );

//     // const mt5Response = await axios.post(
//     //   `${process.env.MT5_WEB_API_URL}/api/trade/balance`,
//     //   null,
//     //   {
//     //     params: {
//     //       login: accountno, // keep existing accountno variable
//     //       type: 2, // balance operation (deposit)
//     //       balance: -Math.abs(amountUSD), // keeping your existing USD conversion
//     //       comment: `WED-${orderid}`.substring(0, 32), // MT5 max comment length = 32 chars
//     //     },
//     //   }
//     // );

//     // console.log("💰 MT5 Response:", mt5Response.data);

//     // if (
//     //   mt5Response.data.retcode !== "0 Done" &&
//     //   mt5Response.data.retcode !== 0
//     // ) {
//     //   throw new Error(
//     //     `MT5 Deposit Failed: ${mt5Response.data.retcode}`
//     //   );
//     // }

//     // 🔹 Save withdrawal record in Pending state
//     const withdrawalRecord = new Withdrawal({
//       orderid,
//       account,
//       ifsc,
//       name,
//       mobile,
//       amount,
//       note,
//       accountNo,
//       status: "Pending",
//     });
//     await withdrawalRecord.save();

//     // ✅ Send email to admin
//     await sendEmail({
//       to: "support@billiondollarfx.com",
//       subject: "⚠️ New Withdrawal Request Pending Approval",
//       html: `
//         <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
//           <h2 style="color: #e74c3c;">New Withdrawal Request</h2>
//           <p>A user has requested a withdrawal. Please review and approve in the admin dashboard.</p>

//           <p><strong>User Details:</strong></p>
//           <ul>
//             <li><strong>Name:</strong> ${name}</li>
//             <li><strong>Account:</strong> ${account}</li>
//             <li><strong>Account No:</strong> ${accountNo}</li>
//             <li><strong>IFSC:</strong> ${ifsc}</li>
//             <li><strong>Mobile:</strong> ${mobile}</li>
//           </ul>

//           <p><strong>Withdrawal Details:</strong></p>
//           <ul>
//             <li><strong>Order ID:</strong> ${orderid}</li>
//             <li><strong>Amount:</strong> ₹${amount} (≈ $${amountUSD})</li>
//             <li><strong>Note:</strong> ${note || "N/A"}</li>
//             <li><strong>Status:</strong> Pending</li>
//           </ul>

//           <p>✅ Next Step: Please approve this withdrawal in the dashboard and contact the user if necessary.</p>

//           <br/>
//           <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
//         </div>
//       `,
//     });

//     res.json({
//       success: true,
//       message: "Withdrawal request submitted",
//       withdrawalRecord,
//     });
//   } catch (err) {
//     console.error("❌ Error saving withdrawal request:", err.message);
//     res.status(500).json({ success: false, error: "Failed to save request" });
//   }
// });

router.post("/request", withdrawalLimiter, checkMargin, createPayoutRequest);

router.post("/request_v2", withdrawalLimiter, checkMargin, handleManualPaymentRequest);

router.post("/approve/:id", approvePayoutReq);

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
    // const amountUSD = (parseFloat(withdrawal.amount) * usdRate).toFixed(2);
    const amountUSD = withdrawal.amount;

    const refundOrderId = `RF${Date.now()}`;

    console.log(withdrawal.accountNo, amountUSD, refundOrderId);

    const mt5Response = await updateMT5Balance({
            login: withdrawal.accountNo,
            type: 2,
            balance: -amountUSD,
            comment: `refundOrderId`.substring(0, 32),
        });

        console.log(
            "MT5 Response:",
            mt5Response.data
        );

        // --------------------------------------------
        // Validate MT5 response
        // --------------------------------------------
        if (
            mt5Response.data.retcode !== "0 Done" &&
            mt5Response.data.retcode !== 0
        ) {
            throw new Error(
                `MT5 Deposit Failed: ${mt5Response.data.retcode}`
            );
        }

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
          <p>Your withdrawal request (Order ID: <b>${withdrawal.orderid
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
      err.response?.data,
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
