const axios = require("axios");
const Order = require("../models/Order");
const Account = require("../models/account.model");
const crypto = require("crypto");
const { MIN_DEPOSIT_USD } = require("../config/depositLimits");

// const generateCregisSignature = (params) => {
//   const sortedString = Object.keys(params)
//     .filter(
//       (key) =>
//         key !== "sign" &&
//         params[key] !== undefined &&
//         params[key] !== null &&
//         params[key] !== ""
//     )
//     .sort()
//     .map((key) => `${key}${params[key]}`)
//     .join("");

//   return crypto
//     .createHash("md5")
//     .update(`${process.env.CREGIS_DEPOSIT_API_KEY}${sortedString}`)
//     .digest("hex")
//     .toLowerCase();
// };

// exports.createCregisCheckout = async (req, res) => {
//   try {
//     const { accountNo, amount } = req.body;

//     console.log("Cregis deposit request:", accountNo, amount);

//     const numericAmount = Number(amount);

//     // Validate request
//     if (
//       !accountNo ||
//       !Number.isFinite(numericAmount) ||
//       numericAmount < 1000
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "A valid account number and minimum amount of 1000 are required",
//       });
//     }

//     // Validate Cregis configuration
//     if (!process.env.CREGIS_DEPOSIT_API_KEY || !process.env.CREGIS_DEPOSIT_PID) {
//       console.error("Cregis deposit: CREGIS credentials are not configured");

//       return res.status(503).json({
//         success: false,
//         message: "Cregis is not configured",
//       });
//     }

//     // Find account
//     const account = await Account.findOne({ accountNo }).populate(
//       "user",
//       "fullName phone email"
//     );

//     if (!account) {
//       return res.status(404).json({
//         success: false,
//         message: "Account not found",
//       });
//     }

//     // Generate unique merchant order ID
//     const merchantOrderId = `ORD${Date.now()}${Math.floor(
//       Math.random() * 1000
//     )}`;

//     // Cregis requires a 6-character nonce
//     const nonce = crypto
//       .randomBytes(4)
//       .toString("hex")
//       .slice(0, 6);

//     // 13-digit timestamp
//     const timestamp = Date.now();

//     /*
//      * IMPORTANT:
//      *
//      * order_currency must be the currency you want the
//      * Cregis order to be denominated in.
//      *
//      * Change USD to your actual configured currency if required.
//      */
//     const payload = {
//       nonce,
//       pid: Number(process.env.CREGIS_DEPOSIT_PID),
//       timestamp,

//       order_amount: numericAmount.toFixed(2),
//       order_currency: "USD",

//       order_id: merchantOrderId,

//       payer_id: String(account.accountNo),

//       payer_email:
//         account.user?.email ||
//         `account-${account.accountNo}@example.com`,

//       payer_name:
//         account.user?.fullName ||
//         String(account.accountNo),

//       valid_time: 30,

//       callback_url: "https://billion-doller-backend.onrender.com/api/payment/cregis/callback",

//       success_url: "https://www.billiondollarfx.com/transactions",

//       cancel_url: "https://www.billiondollarfx.com/transactions",

//       language: "en",

//       remark: `Deposit for account ${account.accountNo}`,

//       /*
//        * Optional:
//        *
//        * Restrict payment currencies here.
//        *
//        * Example:
//        * tokens: "USDT-TRC20"
//        *
//        * Leave empty if all supported tokens should be accepted.
//        */
//       // tokens: "USDT-TRC20",

//       accept_partial_payment: "false",
//       accept_over_payment: "false",
//     };

//     // Generate Cregis signature
//     payload.sign = generateCregisSignature(payload);

//     console.log("Cregis checkout request:", {
//       ...payload,
//       sign: "[HIDDEN]",
//     });

//     // Create Cregis checkout
//     const { data } = await axios.post(
//       `https://t-jcgfykxv.cregis.io/api/v2/checkout`,
//       payload,
//       {
//         headers: {
//           "Content-Type": "application/json",
//         },
//         timeout: 15000,
//       }
//     );

//     console.log("Cregis response:", data);

//     // Validate Cregis response
//     if (
//       data?.code !== "00000" ||
//       !data?.data?.cregis_id ||
//       !data?.data?.checkout_url
//     ) {
//       console.error(
//         "Cregis checkout rejected:",
//         data?.msg || data
//       );

//       if (data?.code === "E0001") {
//         return res.status(400).json({
//           success: false,
//           message:
//             "Cregis rejected the checkout request",
//         });
//       }

//       return res.status(502).json({
//         success: false,
//         message:
//           data?.msg ||
//           "Cregis did not create the checkout",
//       });
//     } 

//     const cregisOrder = data.data;

//     // Save order in database
//     const order = await Order.create({
//       orderid: merchantOrderId,

//       account: account._id,
//       accountNo: String(account.accountNo),

//       amount: numericAmount,

//       status: "PENDING",

//       // Recommended provider information
//       provider: "CREGIS",

//       providerOrderId: String(cregisOrder.cregis_id),
//     });

//     return res.json({
//       success: true,
//       message: "Cregis checkout created successfully",

//       // Internal order
//       order_id: order.orderid,

//       // Cregis order
//       cregis_id: cregisOrder.cregis_id,

//       checkout_url: cregisOrder.checkout_url,

//       order_amount: cregisOrder.order_amount,

//       order_currency: cregisOrder.order_currency,

//       created_time: cregisOrder.created_time,

//       expire_time: cregisOrder.expire_time,

//       payment_info: cregisOrder.payment_info || [],
//     });
//   } catch (err) {
//     console.log("Cregis deposit error:", err.response?.data || err.message);
//     console.error(
//       "Cregis deposit error:",
//       err.response?.data || err.message
//     );

//     return res.status(502).json({
//       success: false,
//       message:
//         err.response?.data?.msg ||
//         "Unable to create Cregis deposit",
//     });
//   }
// }

/**
 * Helper to generate Cregis Signature
 * Algorithm:
 * 1. Filter out empty fields & 'sign'
 * 2. Key-sort lexicographically
 * 3. Concatenate key1value1key2value2...
 * 4. Prepend CREGIS_DEPOSIT_API_KEY
 * 5. MD5 hash (lowercase)
 */
function generateCregisSignature(params) {
  const apiKey = process.env.CREGIS_DEPOSIT_API_KEY;

  const sortedKeys = Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();

  let stringToSign = "";
  for (const key of sortedKeys) {
    stringToSign += `${key}${params[key]}`;
  }

  stringToSign = apiKey + stringToSign;

  return crypto.createHash("md5").update(stringToSign).digest("hex").toLowerCase();
}

/**
 * CREATE CREGIS CHECKOUT (USD Native)
 */
// Cregis charges a payment-processing fee on each transaction. Whether we pass
// it on to the payer (by asking for slightly more than they intend to
// deposit) is controlled by CREGIS_PAYMENT_CHARGE_ENABLED in .env, so it can
// be toggled without a code change. Rate is also env-configurable, defaulting
// to Cregis's actual 0.5% fee when enabled.
const CREGIS_PAYMENT_CHARGE_ENABLED =
  String(process.env.CREGIS_PAYMENT_CHARGE_ENABLED || "false").toLowerCase() === "true";
const CREGIS_PAYMENT_CHARGE_RATE = CREGIS_PAYMENT_CHARGE_ENABLED
  ? Number(process.env.CREGIS_PAYMENT_CHARGE_RATE) || 0.005
  : 0;

exports.createCregisCheckout = async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    console.log("Cregis deposit request:", accountNo, amount);

    const requestedAmount = Number(amount);

    // 1. Validate request (based on what the payer asked to deposit)
    if (!accountNo || !Number.isFinite(requestedAmount) || requestedAmount < MIN_DEPOSIT_USD) {
      return res.status(400).json({
        success: false,
        message: `A valid account number and minimum deposit of $${MIN_DEPOSIT_USD} USD are required`,
      });
    }

    // Add Cregis's payment charge on top of the requested deposit - this becomes
    // the actual order amount asked from the payer and credited on completion.
    const paymentChargeAmount = Number((requestedAmount * CREGIS_PAYMENT_CHARGE_RATE).toFixed(2));
    const numericAmount = Number((requestedAmount + paymentChargeAmount).toFixed(2));

    // 2. Validate Cregis configuration
    if (!process.env.CREGIS_DEPOSIT_API_KEY || !process.env.CREGIS_DEPOSIT_PID) {
      console.error("Cregis deposit: CREGIS credentials are not configured");
      return res.status(503).json({
        success: false,
        message: "We’re unable to process your deposit right now. Please try again in a few moments.",
      });
    }

    // 3. Find MT5 Account
    const account = await Account.findOne({ accountNo }).populate(
      "user",
      "fullName phone email"
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // 4. Generate unique identifiers
    const merchantOrderId = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const nonce = crypto.randomBytes(4).toString("hex").slice(0, 6);
    const timestamp = Date.now();

    // 5. Build Cregis payload in USD
    const payload = {
      nonce,
      pid: Number(process.env.CREGIS_DEPOSIT_PID),
      timestamp,

      order_amount: numericAmount.toFixed(2), // e.g. "100.00"
      order_currency: "USD",                 // USD Input

      order_id: merchantOrderId,
      payer_id: String(account.accountNo),
      payer_email: account.user?.email || `account-${account.accountNo}@example.com`,
      payer_name: account.user?.fullName || String(account.accountNo),

      valid_time: 30, // 30 minutes expiration
      callback_url: "https://billion-doller-backend.onrender.com/api/payment/cregis/callback",
      success_url: "https://www.billiondollarfx.com/transactions",
      cancel_url: "https://www.billiondollarfx.com/transactions",

      language: "en",
      remark: `USD Deposit for MT5 Account ${account.accountNo}`,

      accept_partial_payment: "true",
      accept_over_payment: "true",

      // Lock USDT/USDC -> USD at a fixed 1:1 rate instead of a live CoinMarketCap
      // rate, so a customer paying in a stablecoin can't fall out of sync with the
      // quoted amount while the order is open (reduces paid_partial/paid_over).
      stablecoin_realtime_rate: "false",
    };

    // 6. Append Signature
    payload.sign = generateCregisSignature(payload);

    console.log("Sending Cregis Checkout Payload:", { ...payload, sign: "[HIDDEN]" });

    // 7. Request Checkout URL from Cregis
    const { data } = await axios.post(
      "https://t-jcgfykxv.cregis.io/api/v2/checkout",
      payload,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    console.log("Cregis API response:", data);

    if (data?.code !== "00000" || !data?.data?.cregis_id || !data?.data?.checkout_url) {
      console.error("Cregis checkout rejected:", data?.msg || data);
      return res.status(502).json({
        success: false,
        message: data?.msg || "failed to generate checkout link",
      });
    }

    const cregisOrder = data.data;

    // 8. Save Pending Order to Database
    const order = await Order.create({
      orderid: merchantOrderId,
      account: account._id,
      accountNo: String(account.accountNo),
      amount: numericAmount, // Amount in USD, includes the Cregis payment charge
      paymentChargeAmount,
      status: "PENDING",
      provider: "CREGIS",
      providerOrderId: String(cregisOrder.cregis_id),
    });

    return res.json({
      success: true,
      message: "Cregis checkout created successfully",
      order_id: order.orderid,
      cregis_id: cregisOrder.cregis_id,
      checkout_url: cregisOrder.checkout_url,
      requested_amount: requestedAmount,
      payment_charge_amount: paymentChargeAmount,
      order_amount: cregisOrder.order_amount,
      order_currency: cregisOrder.order_currency,
      created_time: cregisOrder.created_time,
      expire_time: cregisOrder.expire_time,
      payment_info: cregisOrder.payment_info || [],
    });
  } catch (err) {
    console.error("Cregis deposit error:", err.response?.data || err.message);
    return res.status(502).json({
      success: false,
      message: "We’re having trouble processing your deposit. Please try again shortly.",
    });
  }
};