// const axios = require("axios");
// const express = require("express");
// const router = express.Router();
// const mongoose = require("mongoose");
// const crypto = require('crypto');
// require("dotenv").config();

// const Withdrawal = require("../models/withdrawal");
// const User = require("../models/User");
// const sendEmail = require("../utils/sendEmail");
// const { updateMT5Balance } = require("../utils/MT5/mt5Balance");


// const RAMEEPAY_API = "https://apis.rameepay.io/order/generate";
// const RAMEEPAY_Crypto_API = "https://crypto-apis.rameepay.io/v1/order";


// fetchRate = async () => {
//     try {
//         const res = await axios.get(
//             "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD",
//         );
//         return res.data.rates.USD; // 1 INR = ? USD
//     } catch (err) {
//         console.error("Error fetching INR→USD rate:", err.message);
//         return 0.012; // fallback rate if API fails
//     }
// }

// exports.createPayoutRequest = async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const {
//             accountNo,
//             currency = "INR",
//             amount,
//             note,
//             // INR Fields
//             account,
//             ifsc,
//             upiId,
//             accountHolderName,
//             // USD Fields
//             bankName,
//             swiftCode,
//             // Crypto Fields
//             cryptoSymbol,
//             walletAddress,
//             network,
//             memo,
//             // Common / Optional Metadata
//             name,
//             mobile,
//         } = req.body;

//         // 1️⃣ Basic Input Validation
//         if (!accountNo || !amount) {
//             await session.abortTransaction();
//             session.endSession();
//             return res
//                 .status(400)
//                 .json({ success: false, message: "Missing required fields: accountNo and amount" });
//         }

//         const numericAmount = parseFloat(amount);
//         if (isNaN(numericAmount) || numericAmount <= 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res
//                 .status(400)
//                 .json({ success: false, message: "Invalid withdrawal amount" });
//         }

//         // 2️⃣ Dynamic Currency Method Validation
//         if (currency === "CRYPTO") {
//             if (!walletAddress) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res
//                     .status(400)
//                     .json({ success: false, message: "Wallet Address is required for Crypto withdrawal." });
//             }
//         } else if (currency === "INR") {
//             if (!upiId && (!account || !ifsc)) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({
//                     success: false,
//                     message: "Please provide either a UPI ID or Bank Account Number with IFSC code.",
//                 });
//             }
//         } else if (currency === "USD") {
//             if (!account || !bankName) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({
//                     success: false,
//                     message: "Account Number and Bank Name are required for USD wire transfer.",
//                 });
//             }
//         }

//         // 🔒 3️⃣ BLOCK MULTIPLE PENDING REQUESTS
//         const existingPending = await Withdrawal.findOne(
//             { accountNo, status: "Pending" },
//             null,
//             { session }
//         );

//         if (existingPending) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({
//                 success: false,
//                 message: "You already have a pending withdrawal request.",
//             });
//         }

//         // ⏱️ 4️⃣ 5-MINUTE COOLDOWN CHECK
//         const lastWithdrawal = await Withdrawal.findOne({ accountNo }, null, {
//             session,
//         }).sort({ createdAt: -1 });

//         if (lastWithdrawal) {
//             const diff = Date.now() - new Date(lastWithdrawal.createdAt).getTime();
//             const fiveMinutes = 5 * 60 * 1000;

//             if (diff < fiveMinutes) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({
//                     success: false,
//                     message: "You can only request withdrawal once every 5 minutes.",
//                 });
//             }
//         }

//         // 📅 5️⃣ DAILY LIMIT CHECK (3 per day)
//         const startOfDay = new Date();
//         startOfDay.setHours(0, 0, 0, 0);

//         const todayCount = await Withdrawal.countDocuments(
//             {
//                 accountNo,
//                 createdAt: { $gte: startOfDay },
//             },
//             { session }
//         );

//         if (todayCount >= 3) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({
//                 success: false,
//                 message: "Daily withdrawal limit reached (3 per day).",
//             });
//         }

//         const orderid = `WDR${Date.now()}`;

//         // 🔹 Calculate USD Rate Deduction
//         const usdRate = await fetchRate();
//         let amountUSD;
//         if (currency === 'INR') {
//             amountUSD = Number((numericAmount * usdRate).toFixed(2));
//         } else {
//             amountUSD = Number(numericAmount.toFixed(2));
//         }

//         const negativeAmountUSD = -Math.abs(amountUSD);
//         // 🔹 Lock balance by deducting from system backend / MoneyPlant


//         const mt5Response = await updateMT5Balance({
//             login: accountNo,
//             type: 2, // Deposit type
//             balance: negativeAmountUSD,
//             comment: `${orderid}`.substring(0, 31),
//         });

//         console.log("💰 MT5 Response:", mt5Response);

//         const retCode = String(mt5Response.retcode || "");

//         if (!retCode.startsWith("0") && retCode !== "0 Done") {
//             throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
//         }

//         console.log(
//             "MT5 Response:",
//             mt5Response.data
//         );

//         // 🔹 Save Withdrawal Record with Full Currency Context
//         const withdrawalRecord = new Withdrawal({
//             orderid,
//             accountNo,
//             currency,
//             amount: numericAmount,
//             amountUSD,
//             note,
//             status: "Pending",
//             // INR Fields
//             account: account || "",
//             ifsc: ifsc || "",
//             upiId: upiId || "",
//             name: accountHolderName || name || "",
//             mobile: mobile || "",
//             // USD Fields
//             bankName: bankName || "",
//             swiftCode: swiftCode || "",
//             // Crypto Fields
//             cryptoSymbol: cryptoSymbol || "USDT",
//             walletAddress: walletAddress || "",
//             network: network || "TRC20",
//             memo: memo || "",
//         });

//         await withdrawalRecord.save({ session });

//         // Commit Transaction
//         await session.commitTransaction();
//         session.endSession();

//         // ✉️ Dynamic Admin Email Notification Formatting
//         let paymentDetailsHTML = "";
//         if (currency === "CRYPTO") {
//             paymentDetailsHTML = `
//         <li><strong>Asset:</strong> ${cryptoSymbol} (${network})</li>
//         <li><strong>Wallet Address:</strong> ${walletAddress}</li>
//         ${memo ? `<li><strong>Memo/Tag:</strong> ${memo}</li>` : ""}
//       `;
//         } else if (currency === "INR") {
//             paymentDetailsHTML = `
//         <li><strong>Account Holder:</strong> ${accountHolderName || name || "N/A"}</li>
//         ${upiId ? `<li><strong>UPI ID:</strong> ${upiId}</li>` : ""}
//         ${account ? `<li><strong>Bank Account:</strong> ${account}</li>` : ""}
//         ${ifsc ? `<li><strong>IFSC Code:</strong> ${ifsc}</li>` : ""}
//       `;
//         } else if (currency === "USD") {
//             paymentDetailsHTML = `
//         <li><strong>Bank Name:</strong> ${bankName}</li>
//         <li><strong>Account / IBAN:</strong> ${account}</li>
//         <li><strong>SWIFT / BIC:</strong> ${swiftCode || "N/A"}</li>
//       `;
//         }

//         await sendEmail({
//             to: "support@billiondollarfx.com",
//             subject: `⚠️ New Withdrawal Request (${currency}) - Order #${orderid}`,
//             html: `
//         <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
//           <h2 style="color: #e74c3c;">New ${currency} Withdrawal Request</h2>
//           <p>A user has requested a withdrawal. Please review and process it in the admin dashboard.</p>

//           <p><strong>Request Overview:</strong></p>
//           <ul>
//             <li><strong>Order ID:</strong> ${orderid}</li>
//             <li><strong>Source MT5 Account:</strong> ${accountNo}</li>
//             <li><strong>Requested Amount:</strong> $${numericAmount} (≈ $${amountUSD})</li>
//             <li><strong>Payment Method:</strong> ${currency}</li>
//             <li><strong>Note:</strong> ${note || "N/A"}</li>
//           </ul>

//           <p><strong>Payout Details:</strong></p>
//           <ul>
//             ${paymentDetailsHTML}
//           </ul>

//           <br/>
//           <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
//         </div>
//       `,
//         });

//         return res.json({
//             success: true,
//             message: "Withdrawal request submitted successfully",
//             withdrawalRecord,
//         });
//     } catch (err) {
//         await session.abortTransaction();
//         session.endSession();
//         console.log(err)
//         console.error("❌ Error saving withdrawal request:", err.message);
//         return res.status(500).json({ success: false, error: "Failed to save request" });
//     }
// }

// function generateCregisSignature(params, secretKey) {
//     const sortedKeys = Object.keys(params).sort();
//     let str = "";
//     for (const key of sortedKeys) {
//         if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
//             str += `${key}=${params[key]}&`;
//         }
//     }
//     str += `key=${secretKey}`;
//     return crypto.createHash("md5").update(str).digest("hex");
// }

// const getCregisCurrencyId = (network, cryptoSymbol) => {
//     const net = (network || "").toUpperCase();
//     const symbol = (cryptoSymbol || "USDT").toUpperCase();

//     if (symbol === "USDT") {
//         if (net.includes("BEP20") || net.includes("BSC") || net.includes("BNB")) {
//             return "195@56"; // USDT-BEP20
//         }
//         if (net.includes("ERC20") || net.includes("ETH")) {
//             return "195@60"; // USDT-ERC20
//         }
//         if (net.includes("POLYGON") || net.includes("MATIC")) {
//             return "195@137"; // USDT-Polygon
//         }
//         return "195@195"; // USDT-TRC20 (Default)
//     }

//     // Native token fallbacks
//     if (net.includes("BEP20") || net.includes("BSC")) return "56";  // BNB
//     if (net.includes("TRC20") || net.includes("TRX")) return "195"; // TRX
//     if (net.includes("ERC20") || net.includes("ETH")) return "60";  // ETH

//     return "195@195";
// };

// exports.approvePayoutReq = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const { processType, txId, adminNote } = req.body; // 'manual' | 'rameepay' | 'cregis'

//         const withdrawal = await Withdrawal.findById(id);
//         if (!withdrawal) {
//             return res.status(404).json({ success: false, message: "Withdrawal request not found." });
//         }

//         // Only allow processing if the request is still pending
//         if (withdrawal.status !== "Pending") {
//             return res.status(400).json({
//                 success: false,
//                 message: `Request is already ${withdrawal.status}. Cannot re-process.`
//             });
//         }

//         const {
//             currency,
//             account,
//             ifsc,
//             name,
//             mobile,
//             amount,
//             note,
//             orderid,
//             accountNo,
//             walletAddress,
//             cryptoSymbol,
//             memo,
//         } = withdrawal;

//         // Fallback execution type resolution
//         const executionType =
//             processType ||
//             (withdrawal.isManual ? "manual" : currency === "CRYPTO" ? "cregis" : "rameepay");

//         // =========================================================================
//         // OPTION 1: MANUAL TRANSFER
//         // =========================================================================
//         if (executionType === "manual") {
//             if (!txId) {
//                 return res.status(400).json({
//                     success: false,
//                     message: "Transaction ID / Reference Hash is required for manual processing."
//                 });
//             }

//             withdrawal.status = "Completed";
//             withdrawal.processType = "Manual";
//             withdrawal.transactionReference = txId;
//             withdrawal.response = {
//                 message: "Manually processed by Admin",
//                 adminNote: adminNote || "",
//                 completedAt: new Date(),
//             };

//             await withdrawal.save();

//             // Asynchronous success notification
//             sendSuccessEmail(withdrawal).catch((e) =>
//                 console.error("Payout Email Failed:", e.message)
//             );

//             return res.json({
//                 success: true,
//                 message: "Withdrawal marked as Completed (Manual Transfer)",
//                 data: withdrawal,
//             });
//         }

//         // =========================================================================
//         // OPTION 2: CREGIS GATEWAY (Crypto)
//         // =========================================================================
//         if (executionType === "cregis") {
//             if (!walletAddress) {
//                 return res.status(400).json({
//                     success: false,
//                     message: "Wallet address is missing for Cregis payout."
//                 });
//             }

//             const nonce = Math.random().toString(36).substring(2, 8);
//             const timestamp = Date.now();

//             const currencyId = getCregisCurrencyId(withdrawal.network, withdrawal.cryptoSymbol);

//             const cregisPayload = {
//                 nonce,
//                 timestamp,
//                 pid: parseInt(process.env.CREGIS_WITHDRAWAL_PID, 10),
//                 currency: currencyId || "195@195", // Default TRC20 USDT currency ID
//                 address: walletAddress,
//                 amount: String(amount),
//                 third_party_id: String(orderid),
//                 callback_url: `${process.env.APP_BASE_URL}/api/payment/cregis-callback`,
//                 remark: note || "Crypto Withdrawal",
//                 memo: memo || "",
//             };

//             // Generate signature
//             cregisPayload.sign = generateCregisSignature(cregisPayload, process.env.CREGIS_WITHDRAWAL_API_KEY);

//             const { data: cregisRes } = await axios.post(
//                 "https://t-jcgfykxv.cregis.io/api/v1/payout",
//                 cregisPayload,
//                 { headers: { "Content-Type": "application/json" } }
//             );

//             if (cregisRes.code === "00000") {
//                 withdrawal.status = "Completed";
//                 withdrawal.processType = "Cregis API";
//                 withdrawal.cregisCid = cregisRes.data?.cid;
//                 withdrawal.response = cregisRes;
//                 await withdrawal.save();

//                 sendSuccessEmail(withdrawal).catch((e) =>
//                     console.error("Payout Email Failed:", e.message)
//                 );

//                 return res.json({
//                     success: true,
//                     message: "Crypto payout initiated successfully via Cregis",
//                     response: cregisRes,
//                 });
//             } else {
//                 // Mark status as Failed without auto-refunding to MT5
//                 withdrawal.status = "Failed";
//                 withdrawal.response = cregisRes;
//                 await withdrawal.save();

//                 return res.status(400).json({
//                     success: false,
//                     message: cregisRes.msg || "Cregis payout failed. You can process this payout manually.",
//                     gatewayResponse: cregisRes,
//                 });
//             }
//         }

//         // =========================================================================
//         // OPTION 3: RAMEEPAY GATEWAY (INR / Crypto)
//         // =========================================================================
//         if (executionType === "rameepay") {
//             try {
//                 let payload;

//                 if (currency === "CRYPTO") {
//                     payload = {
//                         amount: Number(parseFloat(amount).toFixed(2)),
//                         orderid: String(orderid),
//                     };
//                 } else {
//                     payload = {
//                         type: "FIAT",
//                         account,
//                         ifsc,
//                         name,
//                         mobile,
//                         amount: Number(parseFloat(amount).toFixed(2)),
//                         note: note || "INR Withdrawal payout",
//                         orderid: String(orderid),
//                     };
//                 }

//                 const endpoint = currency === "CRYPTO" ? RAMEEPAY_Crypto_API : RAMEEPAY_API;
//                 const encryptedReqData = encryptData(payload);

//                 const { data } = await axios.post(
//                     endpoint,
//                     {
//                         reqData: encryptedReqData,
//                         agentCode: process.env.RAMEEPAY_AGENT_CODE,
//                     },
//                     {
//                         headers: { "Content-Type": "application/json" },
//                         timeout: 15000,
//                     }
//                 );

//                 const rawResponseData = data?.data || data?.reqData;
//                 const responsePayload =
//                     typeof rawResponseData === "string"
//                         ? decryptData(rawResponseData)
//                         : rawResponseData || {};

//                 const isSuccess =
//                     data?.status === "true" ||
//                     data?.status === true ||
//                     responsePayload?.status === "SUCCESS" ||
//                     responsePayload?.success === true;

//                 if (isSuccess) {
//                     withdrawal.status = "Completed";
//                     withdrawal.processType = `RameePay API (${currency})`;
//                     withdrawal.response = responsePayload;
//                     await withdrawal.save();

//                     sendSuccessEmail(withdrawal).catch((e) =>
//                         console.error("Payout Email Failed:", e.message)
//                     );

//                     return res.json({
//                         success: true,
//                         message: `Payout initiated via RameePay (${currency})`,
//                         response: responsePayload,
//                     });
//                 }

//                 throw new Error(
//                     responsePayload?.message || responsePayload?.error || "RameePay payout failed at gateway."
//                 );
//             } catch (err) {
//                 console.error("RameePay Payout Error:", err.response?.data || err.message);

//                 // Mark as Failed without auto-refunding to MT5
//                 withdrawal.status = "Failed";
//                 withdrawal.response = err.response?.data || { error: err.message };
//                 await withdrawal.save();

//                 return res.status(400).json({
//                     success: false,
//                     message: err.message || "RameePay payout failed. You can process this payout manually.",
//                 });
//             }
//         }

//         return res.status(400).json({ success: false, message: "Invalid processing type specified." });
//     } catch (err) {
//         console.error("Payout Processing Error:", err);
//         res.status(500).json({
//             success: false,
//             message: err.message || "Failed to process withdrawal payout.",
//         });
//     }
// };

// // =============================================================================
// // HELPER FUNCTIONS
// // =============================================================================
// exports.refundToMT5 = async (accountNo, amount, currency) => {
//     try {
//         const usdRate = await fetchRate();
//         const parsedAmount = parseFloat(amount);

//         if (isNaN(parsedAmount) || parsedAmount <= 0) {
//             throw new Error(`Invalid refund amount provided: ${amount}`);
//         }

//         // Convert INR to USD if needed, otherwise format to 2 decimal places
//         const amountUSD = currency === "INR"
//             ? (parsedAmount / usdRate).toFixed(2)
//             : parsedAmount.toFixed(2);

//         const refundOrderId = `RF${Date.now()}`;
//         const formattedComment = `REF-${refundOrderId}`.substring(0, 31);

//         console.log(`🔄 Refunding MT5 Account ${accountNo}: $${amountUSD} USD (Comment: ${formattedComment})`);

//         const mt5Response = await updateMT5Balance({
//             login: accountNo,
//             type: 2, // Deposit/Balance Operation
//             balance: amountUSD,
//             comment: formattedComment,
//         });

//         console.log("💰 MT5 Refund Response:", mt5Response);

//         // Validate retcode directly from the return object
//         const retCode = String(mt5Response.retcode || "");

//         if (!retCode.startsWith("0") && retCode !== "0 Done") {
//             throw new Error(`MT5 Refund Failed for account ${accountNo}: ${mt5Response.retcode}`);
//         }

//         return mt5Response;
//     } catch (error) {
//         console.error("❌ refundToMT5 Error:", error.message);
//         throw error; // Re-throw so caller webhooks log or handle the failure
//     }
// };

// exports.sendSuccessEmail = async (withdrawal) => {
//     const user = await User.findOne({
//         $or: [{ phone: withdrawal.mobile }, { accountNo: withdrawal.accountNo }]
//     });

//     if (user && user.email) {
//         const formattedAmount =
//             withdrawal.currency === "CRYPTO"
//                 ? `${withdrawal.amount} ${withdrawal.cryptoSymbol || "USDT"}`
//                 : withdrawal.currency === "INR"
//                     ? `₹${withdrawal.amount}`
//                     : `$${withdrawal.amount}`;

//         await sendEmail({
//             to: user.email,
//             subject: "Withdrawal Request Processed",
//             html: `
//         <p>Hi ${user.fullName || "Valued Customer"},</p>
//         <p>Your withdrawal request of <strong>${formattedAmount}</strong> (Order ID: ${withdrawal.orderid}) has been successfully processed.</p>
//         ${withdrawal.transactionReference ? `<p><strong>Reference/TxID:</strong> ${withdrawal.transactionReference}</p>` : ''}
//         <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Withdrawal_Processed_p4rluh.jpg" 
//              alt="Withdrawal Processed" 
//              style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
//         <p>Thank you for trading with us!</p>
//       `,
//         });
//     }
// }

const axios = require("axios");
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const Withdrawal = require("../models/withdrawal");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { updateMT5Balance } = require("../utils/MT5/mt5Balance");
const { encryptDataCrypto, encryptData, decryptDataCrypto, decryptData } = require("../utils/rameeCrypto");

const RAMEEPAY_API = "https://apis.rameepay.io/order/generate";
const RAMEEPAY_Crypto_API = "https://crypto-apis.rameepay.io/v1/order";

const fetchRate = async () => {
    try {
        const res = await axios.get(
            "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD"
        );
        return res.data.rates.USD; // 1 INR = ? USD
    } catch (err) {
        console.error("Error fetching INR→USD rate:", err.message);
        return 0.012; // fallback rate if API fails
    }
};

/**
 * Generates Cregis MD5 Signature.
 * Formats keys alphabetically: key1=val1&key2=val2...&key=SECRET_KEY
 * Strips out 'sign' field before hashing.
 */
function generateCregisSignature(params, secretKey) {
    const payloadCopy = { ...params };
    delete payloadCopy.sign; // Never include the sign parameter in MD5 payload

    const sortedKeys = Object.keys(payloadCopy).sort();
    let str = "";
    for (const key of sortedKeys) {
        if (payloadCopy[key] !== undefined && payloadCopy[key] !== null && payloadCopy[key] !== "") {
            str += `${key}=${payloadCopy[key]}&`;
        }
    }
    str += `key=${secretKey}`;
    return crypto.createHash("md5").update(str).digest("hex");
}

/**
 * Maps Network and Token Symbol to official Cregis Currency Codes
 */
const getCregisCurrencyId = (network, cryptoSymbol) => {
    const net = (network || "").toUpperCase();
    const symbol = (cryptoSymbol || "USDT").toUpperCase();

    if (symbol === "USDT") {
        if (net.includes("BEP20") || net.includes("BSC") || net.includes("BNB")) {
            return "195@56"; // USDT-BEP20
        }
        if (net.includes("ERC20") || net.includes("ETH")) {
            return "195@60"; // USDT-ERC20
        }
        if (net.includes("POLYGON") || net.includes("MATIC")) {
            return "195@137"; // USDT-Polygon
        }
        return "195@195"; // USDT-TRC20 (Default)
    }

    // Native token fallbacks
    if (net.includes("BEP20") || net.includes("BSC")) return "56";  // BNB
    if (net.includes("TRC20") || net.includes("TRX")) return "195"; // TRX
    if (net.includes("ERC20") || net.includes("ETH")) return "60";  // ETH

    return "195@195";
};

exports.createPayoutRequest = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const {
            accountNo,
            currency = "INR",
            amount,
            note,
            // INR Fields
            account,
            ifsc,
            upiId,
            accountHolderName,
            // USD Fields
            bankName,
            swiftCode,
            // Crypto Fields
            cryptoSymbol,
            walletAddress,
            network,
            memo,
            // Common / Optional Metadata
            name,
            mobile,
        } = req.body;

        // 1️⃣ Basic Input Validation
        if (!accountNo || !amount) {
            await session.abortTransaction();
            session.endSession();
            return res
                .status(400)
                .json({ success: false, message: "Missing required fields: accountNo and amount" });
        }

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res
                .status(400)
                .json({ success: false, message: "Invalid withdrawal amount" });
        }

        // 2️⃣ Dynamic Currency Method Validation
        if (currency === "CRYPTO") {
            if (!walletAddress) {
                await session.abortTransaction();
                session.endSession();
                return res
                    .status(400)
                    .json({ success: false, message: "Wallet Address is required for Crypto withdrawal." });
            }
        } else if (currency === "INR") {
            if (!upiId && (!account || !ifsc)) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({
                    success: false,
                    message: "Please provide either a UPI ID or Bank Account Number with IFSC code.",
                });
            }
        } else if (currency === "USD") {
            if (!account || !bankName) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({
                    success: false,
                    message: "Account Number and Bank Name are required for USD wire transfer.",
                });
            }
        }

        // 3️⃣ BLOCK MULTIPLE PENDING REQUESTS
        const existingPending = await Withdrawal.findOne(
            { accountNo, status: "Pending" },
            null,
            { session }
        );

        if (existingPending) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: "You already have a pending withdrawal request.",
            });
        }

        // 4️⃣ 5-MINUTE COOLDOWN CHECK
        const lastWithdrawal = await Withdrawal.findOne({ accountNo }, null, {
            session,
        }).sort({ createdAt: -1 });

        if (lastWithdrawal) {
            const diff = Date.now() - new Date(lastWithdrawal.createdAt).getTime();
            const fiveMinutes = 5 * 60 * 1000;

            if (diff < fiveMinutes) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({
                    success: false,
                    message: "You can only request withdrawal once every 5 minutes.",
                });
            }
        }

        // 5️⃣ DAILY LIMIT CHECK (3 per day)
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const todayCount = await Withdrawal.countDocuments(
            {
                accountNo,
                createdAt: { $gte: startOfDay },
            },
            { session }
        );

        if (todayCount >= 3) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: "Daily withdrawal limit reached (3 per day).",
            });
        }

        const orderid = `WDR${Date.now()}`;

        // Calculate USD Rate Deduction
        const usdRate = await fetchRate();
        let amountUSD;
        if (currency === "INR") {
            amountUSD = Number((numericAmount * usdRate).toFixed(2));
        } else {
            amountUSD = Number(numericAmount.toFixed(2));
        }

        const negativeAmountUSD = -Math.abs(amountUSD);

        const mt5Response = await updateMT5Balance({
            login: accountNo,
            type: 2, // Deposit type
            balance: negativeAmountUSD,
            comment: `${orderid}`.substring(0, 31),
        });

        const retCode = String(mt5Response.retcode || "");

        if (!retCode.startsWith("0") && retCode !== "0 Done") {
            throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
        }

        // Save Withdrawal Record
        const withdrawalRecord = new Withdrawal({
            orderid,
            accountNo,
            currency,
            amount: numericAmount,
            amountUSD,
            note,
            status: "Pending",
            account: account || "",
            ifsc: ifsc || "",
            upiId: upiId || "",
            name: accountHolderName || name || "",
            mobile: mobile || "",
            bankName: bankName || "",
            swiftCode: swiftCode || "",
            cryptoSymbol: cryptoSymbol || "USDT",
            walletAddress: walletAddress || "",
            network: network || "TRC20",
            memo: memo || "",
        });

        await withdrawalRecord.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Admin Email Notification
        let paymentDetailsHTML = "";
        if (currency === "CRYPTO") {
            paymentDetailsHTML = `
        <li><strong>Asset:</strong> ${cryptoSymbol} (${network})</li>
        <li><strong>Wallet Address:</strong> ${walletAddress}</li>
        ${memo ? `<li><strong>Memo/Tag:</strong> ${memo}</li>` : ""}
      `;
        } else if (currency === "INR") {
            paymentDetailsHTML = `
        <li><strong>Account Holder:</strong> ${accountHolderName || name || "N/A"}</li>
        ${upiId ? `<li><strong>UPI ID:</strong> ${upiId}</li>` : ""}
        ${account ? `<li><strong>Bank Account:</strong> ${account}</li>` : ""}
        ${ifsc ? `<li><strong>IFSC Code:</strong> ${ifsc}</li>` : ""}
      `;
        } else if (currency === "USD") {
            paymentDetailsHTML = `
        <li><strong>Bank Name:</strong> ${bankName}</li>
        <li><strong>Account / IBAN:</strong> ${account}</li>
        <li><strong>SWIFT / BIC:</strong> ${swiftCode || "N/A"}</li>
      `;
        }

        await sendEmail({
            to: "support@billiondollarfx.com",
            subject: `⚠️ New Withdrawal Request (${currency}) - Order #${orderid}`,
            html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #e74c3c;">New ${currency} Withdrawal Request</h2>
          <p>A user has requested a withdrawal. Please review and process it in the admin dashboard.</p>

          <p><strong>Request Overview:</strong></p>
          <ul>
            <li><strong>Order ID:</strong> ${orderid}</li>
            <li><strong>Source MT5 Account:</strong> ${accountNo}</li>
            <li><strong>Requested Amount:</strong> $${numericAmount} (≈ $${amountUSD})</li>
            <li><strong>Payment Method:</strong> ${currency}</li>
            <li><strong>Note:</strong> ${note || "N/A"}</li>
          </ul>

          <p><strong>Payout Details:</strong></p>
          <ul>
            ${paymentDetailsHTML}
          </ul>

          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
        </div>
      `,
        });

        return res.json({
            success: true,
            message: "Withdrawal request submitted successfully",
            withdrawalRecord,
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error("❌ Error saving withdrawal request:", err.message);
        return res.status(500).json({ success: false, error: "Failed to save request" });
    }
};

exports.approvePayoutReq = async (req, res) => {
    try {
        const { id } = req.params;
        const { processType, txId, adminNote } = req.body;

        const withdrawal = await Withdrawal.findById(id);
        if (!withdrawal) {
            return res.status(404).json({ success: false, message: "Withdrawal request not found." });
        }

        // FIX: Must use AND (&&). Using OR (||) made this condition always evaluate to true.
        if (withdrawal.status !== "Pending" && withdrawal.status !== "Failed") {
            return res.status(400).json({
                success: false,
                message: `Request is already ${withdrawal.status}. Cannot re-process.`
            });
        }

        const {
            currency,
            account,
            ifsc,
            name,
            mobile,
            amount,
            note,
            orderid,
            accountNo,
            walletAddress,
            cryptoSymbol,
            network,
            memo,
        } = withdrawal;

        // Standardize string comparison to lowercase
        const executionType = (
            processType ||
            (withdrawal.isManual ? "manual" : currency === "CRYPTO" ? "cregis" : "rameepay")
        ).toLowerCase();

        // =========================================================================
        // OPTION 1: MANUAL TRANSFER
        // =========================================================================
        if (executionType === "manual") {
            if (!txId) {
                return res.status(400).json({
                    success: false,
                    message: "Transaction ID / Reference Hash is required for manual processing."
                });
            }

            withdrawal.status = "Completed";
            withdrawal.processType = "Manual";
            withdrawal.transactionReference = txId;
            withdrawal.response = {
                message: "Manually processed by Admin",
                adminNote: adminNote || "",
                completedAt: new Date(),
            };

            await withdrawal.save();

            exports.sendSuccessEmail(withdrawal).catch((e) =>
                console.error("Payout Email Failed:", e.message)
            );

            return res.json({
                success: true,
                message: "Withdrawal marked as Completed (Manual Transfer)",
                data: withdrawal,
            });
        }

        // =========================================================================
        // OPTION 2: CREGIS GATEWAY (Crypto)
        // =========================================================================
        if (executionType === "cregis") {
            if (!walletAddress) {
                return res.status(400).json({
                    success: false,
                    message: "Wallet address is missing for Cregis payout."
                });
            }
            if (!process.env.CREGIS_WITHDRAWAL_API_KEY || !process.env.CREGIS_WITHDRAWAL_PID) {
                console.error("Cregis deposit: CREGIS credentials are not configured");
                return res.status(503).json({
                    success: false,
                    message: "We’re unable to process your deposit right now. Please try again in a few moments.",
                });
            }

            const nonce = Math.random().toString(36).substring(2, 8);
            const timestamp = Date.now();
            const currencyId = getCregisCurrencyId(network, cryptoSymbol);

            const cregisPayload = {
                nonce: String(nonce),
                timestamp: Number(timestamp),
                pid: Number(process.env.CREGIS_WITHDRAWAL_PID),
                currency: currencyId,
                address: String(walletAddress),
                amount: String(amount),
                third_party_id: String(orderid),
                callback_url: "https://billion-doller-backend.onrender.com/api/payment/cregis/callback",
                remark: note || "Crypto Withdrawal",
                memo: memo || "",
            };

            // Generate MD5 signature without modifying the original object
            cregisPayload.sign = generateCregisSignature(cregisPayload, process.env.CREGIS_WITHDRAWAL_API_KEY);

            try {
                const { data: cregisRes } = await axios.post(
                    "https://t-jcgfykxv.cregis.io/api/v1/payout",
                    cregisPayload,
                    { headers: { "Content-Type": "application/json" } }
                );

                if (cregisRes.code === "00000") {
                    withdrawal.status = "Completed";
                    withdrawal.processType = "Cregis API";
                    withdrawal.cregisCid = cregisRes.data?.cid;
                    withdrawal.response = cregisRes;
                    await withdrawal.save();

                    exports.sendSuccessEmail(withdrawal).catch((e) =>
                        console.error("Payout Email Failed:", e.message)
                    );

                    return res.json({
                        success: true,
                        message: "Crypto payout initiated successfully via Cregis",
                        response: cregisRes,
                    });
                } else {
                    withdrawal.status = "Failed";
                    withdrawal.response = cregisRes;
                    await withdrawal.save();

                    return res.status(400).json({
                        success: false,
                        message: cregisRes.msg || "Cregis payout failed. You can process this payout manually.",
                        gatewayResponse: cregisRes,
                    });
                }
            } catch (gatewayErr) {
                const errorData = gatewayErr.response?.data || { message: gatewayErr.message };

                withdrawal.status = "Failed";
                withdrawal.response = errorData;
                await withdrawal.save();

                return res.status(400).json({
                    success: false,
                    message: errorData.msg || errorData.message || "Cregis API request failed.",
                    error: errorData,
                });
            }
        }

        // =========================================================================
        // OPTION 3: RAMEEPAY GATEWAY (INR / Crypto)
        // =========================================================================
        if (executionType === "rameepay") {
            try {
                let payload;

                if (currency === "CRYPTO") {
                    payload = {
                        amount: Number(parseFloat(amount).toFixed(2)),
                        orderid: String(orderid),
                    };
                } else {
                    payload = {
                        type: "FIAT",
                        account,
                        ifsc,
                        name,
                        mobile,
                        amount: Number(parseFloat(amount).toFixed(2)),
                        note: note || "INR Withdrawal payout",
                        orderid: String(orderid),
                    };
                }

                const endpoint = currency === "CRYPTO" ? RAMEEPAY_Crypto_API : RAMEEPAY_API;
                const encryptedReqData = currency === "CRYPTO" ? encryptDataCrypto(payload) : encryptData(payload);

                const { data } = await axios.post(
                    endpoint,
                    {
                        reqData: encryptedReqData,
                        agentCode: currency === "CRYPTO"? process.env.CRYPTO_AGENT_CODE :process.env.RAMEEPAY_AGENT_CODE,
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 15000,
                    }
                );

                const rawResponseData =
                    typeof data === "string"
                        ? data
                        : data?.data || data?.reqData || data?.resData || data?.result;

                if (!rawResponseData) {
                    throw new Error(
                        data?.message || data?.msg || "No encrypted response payload received from RameePay."
                    );
                }
                const responsePayload =
                    currency === "CRYPTO"
                        ? decryptDataCrypto(rawResponseData)
                        : typeof rawResponseData === "string"
                            ? decryptData(rawResponseData)
                            : rawResponseData;


                const isSuccess =
                    data?.status === "true" ||
                    data?.status === true ||
                    responsePayload?.status === "SUCCESS" ||
                    responsePayload?.success === true;

                if (isSuccess) {
                    withdrawal.status = "Completed";
                    withdrawal.processType = `RameePay API (${currency})`;
                    withdrawal.response = responsePayload;
                    await withdrawal.save();

                    exports.sendSuccessEmail(withdrawal).catch((e) =>
                        console.error("Payout Email Failed:", e.message)
                    );

                    return res.json({
                        success: true,
                        message: `Payout initiated via RameePay (${currency})`,
                        response: responsePayload,
                    });
                }

                throw new Error(
                    responsePayload?.message || responsePayload?.error || responsePayload?.msg || "RameePay payout failed at gateway."
                );
            } catch (err) {
                console.log("err", err)
                const apiError = err.response?.data || {};
                const detailedMsg = apiError.message || apiError.msg || err.message || "RameePay payout failed.";

                console.error("RameePay Payout Error:", apiError || err.message);

                withdrawal.status = "Failed";
                withdrawal.response = Object.keys(apiError).length > 0 ? apiError : { error: err.message };
                await withdrawal.save();

                return res.status(400).json({
                    success: false,
                    message: detailedMsg,
                    error: apiError,
                });
            }
        }

        return res.status(400).json({ success: false, message: "Invalid processing type specified." });
    } catch (err) {
        console.error("Payout Processing Error:", err);
        res.status(500).json({
            success: false,
            message: err.message || "Failed to process withdrawal payout.",
        });
    }
};

exports.refundToMT5 = async (accountNo, amount, currency) => {
    try {
        const usdRate = await fetchRate();
        const parsedAmount = parseFloat(amount);

        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            throw new Error(`Invalid refund amount provided: ${amount}`);
        }

        const amountUSD = currency === "INR"
            ? (parsedAmount / usdRate).toFixed(2)
            : parsedAmount.toFixed(2);

        const refundOrderId = `RF${Date.now()}`;
        const formattedComment = `REF-${refundOrderId}`.substring(0, 31);

        const mt5Response = await updateMT5Balance({
            login: accountNo,
            type: 2,
            balance: amountUSD,
            comment: formattedComment,
        });

        const retCode = String(mt5Response.retcode || "");

        if (!retCode.startsWith("0") && retCode !== "0 Done") {
            throw new Error(`MT5 Refund Failed for account ${accountNo}: ${mt5Response.retcode}`);
        }

        return mt5Response;
    } catch (error) {
        console.error("❌ refundToMT5 Error:", error.message);
        throw error;
    }
};

exports.sendSuccessEmail = async (withdrawal) => {
    const user = await User.findOne({
        $or: [{ phone: withdrawal.mobile }, { accountNo: withdrawal.accountNo }]
    });

    if (user && user.email) {
        const formattedAmount =
            withdrawal.currency === "CRYPTO"
                ? `${withdrawal.amount} ${withdrawal.cryptoSymbol || "USDT"}`
                : withdrawal.currency === "INR"
                    ? `₹${withdrawal.amount}`
                    : `$${withdrawal.amount}`;

        await sendEmail({
            to: user.email,
            subject: "Withdrawal Request Processed",
            html: `
        <p>Hi ${user.fullName || "Valued Customer"},</p>
        <p>Your withdrawal request of <strong>${formattedAmount}</strong> (Order ID: ${withdrawal.orderid}) has been successfully processed.</p>
        ${withdrawal.transactionReference ? `<p><strong>Reference/TxID:</strong> ${withdrawal.transactionReference}</p>` : ''}
        <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Withdrawal_Processed_p4rluh.jpg" 
             alt="Withdrawal Processed" 
             style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
        <p>Thank you for trading with us!</p>
      `,
        });
    }
};

// Reject withdrawal request (Admin action)
exports.rejectPayoutRequest = async (req, res) => {
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

        // Refund via MoneyPlant
        const usdRate = await fetchRate();
        const amountUSD = withdrawal.amount;

        const refundOrderId = `RF${Date.now()}`;

        console.log(withdrawal.accountNo, amountUSD, refundOrderId);

        const mt5Response = await updateMT5Balance({
            login: withdrawal.accountNo,
            type: 2,
            balance: -amountUSD,
            comment: `refundOrderId`.substring(0, 32),
        });

        console.log("MT5 Response:", mt5Response.data);

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
};