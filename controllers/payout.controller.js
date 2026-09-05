const axios = require("axios");
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
require("dotenv").config();

const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const Account = require("../models/account.model");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { fetchRate } = require("../routes/paymentRoutes");
const { updateMT5Balance } = require("../utils/MT5/mt5Balance");


const RAMEEPAY_API = "https://apis.rameepay.io/order/generate";
const RAMEEPAY_Crypto_API = "https://crypto-apis.rameepay.io/v1/order";

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

        // 🔒 3️⃣ BLOCK MULTIPLE PENDING REQUESTS
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

        // ⏱️ 4️⃣ 5-MINUTE COOLDOWN CHECK
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

        // 📅 5️⃣ DAILY LIMIT CHECK (3 per day)
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

        // 🔹 Calculate USD Rate Deduction
        const usdRate = await fetchRate();
        const amountUSD = (numericAmount * usdRate).toFixed(2);
        // const amountUSD = numericAmount;

        // 🔹 Lock balance by deducting from system backend / MoneyPlant
        const mt5Response = await updateMT5Balance({
            login: accountNo,
            type: 2,
            balance: -amountUSD,
            comment: `orderid`.substring(0, 32),
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

        // 🔹 Save Withdrawal Record with Full Currency Context
        const withdrawalRecord = new Withdrawal({
            orderid,
            accountNo,
            currency,
            amount: numericAmount,
            amountUSD,
            note,
            status: "Pending",
            // INR Fields
            account: account || "",
            ifsc: ifsc || "",
            upiId: upiId || "",
            name: accountHolderName || name || "",
            mobile: mobile || "",
            // USD Fields
            bankName: bankName || "",
            swiftCode: swiftCode || "",
            // Crypto Fields
            cryptoSymbol: cryptoSymbol || "USDT",
            walletAddress: walletAddress || "",
            network: network || "TRC20",
            memo: memo || "",
        });

        await withdrawalRecord.save({ session });

        // Commit Transaction
        await session.commitTransaction();
        session.endSession();

        // ✉️ Dynamic Admin Email Notification Formatting
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
}


// exports.approvePayoutReq = async (req, res) => {
//   try {
//     const withdrawal = await Withdrawal.findById(req.params.id);
//     if (!withdrawal) {
//       return res.status(404).json({ success: false, message: "Not found" });
//     }

//     if (withdrawal.status !== "Pending") {
//       return res
//         .status(400)
//         .json({ success: false, message: "Already processed" });
//     }

//     const { account, ifsc, name, mobile, amount, note, orderid, accountNo } =
//       withdrawal;

//     // 🔹 Payload for RameePay (amount must be string with 2 decimals)
//     const payload = {
//       account,
//       ifsc,
//       name,
//       mobile,
//       amount: parseFloat(amount).toFixed(2), // e.g. "1000.00"
//       note,
//       orderid,
//     };

//     // Encrypt
//     const encryptedData = encryptData(payload);
//     const body = { reqData: encryptedData, agentCode: AGENT_CODE };

//     // Call API
//     const { data } = await axios.post(RAMEEPAY_WITHDRAWAL_API, body, {
//       headers: { "Content-Type": "application/json" },
//     });

//     console.log("🔒 Raw RameePay Response:", data);

//     let decryptedResponse = {};
//     if (data.data) {
//       if (typeof data.data === "string") {
//         decryptedResponse = decryptData(data.data);
//       } else {
//         console.error(
//           "Expected string in data.data, got:",
//           typeof data.data,
//           data.data,
//         );
//         decryptedResponse = data.data; // fallback, store raw object
//       }
//     }

//     console.log("🔓 Decrypted RameePay Response:", decryptedResponse);

//     // ✅ Check based on decryptedResponse.success
//     if (decryptedResponse && decryptedResponse.success === true) {
//       withdrawal.status = "Completed";
//       withdrawal.response = decryptedResponse;
//       await withdrawal.save();

//       // Send success email
//       const user = await User.findOne({ phone: withdrawal.mobile });
//       if (user) {
//         const usdRate = await fetchRate();
//         const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

//         await sendEmail({
//           to: user.email,
//           subject: "Withdrawal Successful",
//           html: `
//     <p>Hi ${user.fullName},</p>
//     <p>Your withdrawal of ₹${amount} (≈ $${amountUSD}) is successful.</p>
//     <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Withdrawal_Processed_p4rluh.jpg" 
//          alt="Withdrawal Processed" 
//          style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
//     <p>Thank you for using our service!</p>
//   `,
//         });
//       }

//       return res.json({
//         success: true,
//         message: decryptedResponse.message || "Withdrawal completed",
//         response: decryptedResponse,
//       });
//     } else {
//       // ❌ Failed → refund via MoneyPlant
//       const usdRate = await fetchRate();
//       const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);
//       const refundOrderId = `RF${Date.now()}`;

//       await axios.post(
//         "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
//         {
//           accountno: accountNo,
//           amount: +Math.abs(amountUSD),
//           orderid: refundOrderId,
//         },
//         { headers: { "Content-Type": "application/json" } },
//       );

//       // const mt5Response = await axios.post(
//       //   `${process.env.MT5_WEB_API_URL}/api/trade/balance`,
//       //   null,
//       //   {
//       //     params: {
//       //       login: accountno, // keep existing accountno variable
//       //       type: 2, // balance operation (deposit)
//       //       balance:  +Math.abs(amountUSD), // keeping your existing USD conversion
//       //       comment: `REF-${refundOrderId}`.substring(0, 32), // MT5 max comment length = 32 chars
//       //     },
//       //   }
//       // );

//       // console.log("💰 MT5 Response:", mt5Response.data);

//       // if (
//       //   mt5Response.data.retcode !== "0 Done" &&
//       //   mt5Response.data.retcode !== 0
//       // ) {
//       //   throw new Error(
//       //     `MT5 Deposit Failed: ${mt5Response.data.retcode}`
//       //   );
//       // }

//       withdrawal.status = "Failed";
//       withdrawal.response = decryptedResponse;
//       await withdrawal.save();

//       return res.json({
//         success: false,
//         message:
//           decryptedResponse?.message || "Withdrawal failed, amount refunded",
//         response: decryptedResponse,
//       });
//     }
//   } catch (err) {
//     console.error("Withdrawal approval error:", err);

//     const decryptedData =
//       err.response?.data?.data && typeof err.response.data.data === "string"
//         ? decryptData(err.response.data.data)
//         : null;

//     res.status(500).json({
//       success: false,
//       error:
//         decryptedData?.message || err.message || "Withdrawal processing failed",
//     });
//   }
// }



function generateCregisSignature(params, secretKey) {
    const sortedKeys = Object.keys(params).sort();
    let str = "";
    for (const key of sortedKeys) {
        if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
            str += `${key}=${params[key]}&`;
        }
    }
    str += `key=${secretKey}`;
    return crypto.createHash("md5").update(str).digest("hex");
}

exports.approvePayoutReq = async (req, res) => {
    try {
        const { id } = req.params;
        const { processType, txId, adminNote } = req.body; // 'manual' | 'rameepay' | 'cregis'

        const withdrawal = await Withdrawal.findById(id);
        if (!withdrawal) {
            return res.status(404).json({ success: false, message: "Withdrawal not found" });
        }

        if (withdrawal.status !== "Pending") {
            return res.status(400).json({ success: false, message: "Request already processed" });
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

        // Fallback if no processType supplied
        const executionType =
            processType ||
            (withdrawal.isManual ? "manual" : currency === "CRYPTO" ? "cregis" : "rameepay");

        // =========================================================================
        // OPTION 1: MANUAL TRANSFER
        // =========================================================================
        if (executionType === "manual") {
            if (!txId) {
                return res
                    .status(400)
                    .json({ success: false, message: "Transaction ID / Reference Hash is required for manual processing." });
            }

            withdrawal.status = "Completed";
            withdrawal.processType = "Manual";
            withdrawal.transactionReference = txId;
            withdrawal.response = {
                message: "Manually transferred by Admin",
                adminNote: adminNote || "",
                completedAt: new Date(),
            };

            await withdrawal.save();
            await sendSuccessEmail(withdrawal);

            return res.json({
                success: true,
                message: "Withdrawal marked as Completed (Manual Transfer)",
                data: withdrawal,
            });
        }

        // =========================================================================
        // OPTION 2: CREGIS GATEWAY (Crypto Only)
        // =========================================================================
        if (executionType === "cregis") {
            if (!walletAddress) {
                return res.status(400).json({ success: false, message: "Wallet address missing for Cregis payout." });
            }

            const nonce = Math.random().toString(36).substring(2, 8);
            const timestamp = Date.now();

            const cregisPayload = {
                nonce,
                timestamp,
                pid: parseInt(process.env.CREGIS_WITHDRAWAL_PID, 10),
                currency: cryptoSymbol || "195@195", // Default TRC20 USDT currency ID
                address: walletAddress,
                amount: String(amount),
                third_party_id: orderid,
                callback_url: `${process.env.APP_BASE_URL}/api/payment/cregis-callback`,
                remark: note || "Crypto Withdrawal",
                memo: memo || "",
            };

            cregisPayload.sign = generateCregisSignature(cregisPayload, process.env.CREGIS_WITHDRAWAL_API_KEY);

            const { data: cregisRes } = await axios.post(`https://t-jcgfykxv.cregis.io/api/v1/payout`, cregisPayload, {
                headers: { "Content-Type": "application/json" },
            });

            if (cregisRes.code === "00000") {
                withdrawal.status = "Completed";
                withdrawal.processType = "Cregis API";
                withdrawal.cregisCid = cregisRes.data?.cid;
                withdrawal.response = cregisRes;
                await withdrawal.save();

                await sendSuccessEmail(withdrawal);

                return res.json({
                    success: true,
                    message: "Crypto payout initiated successfully via Cregis",
                    response: cregisRes,
                });
            } else {
                await refundToMoneyPlant(accountNo, amount, currency);
                withdrawal.status = "Failed";
                withdrawal.response = cregisRes;
                await withdrawal.save();

                return res.status(400).json({
                    success: false,
                    message: cregisRes.msg || "Cregis payout failed. Amount refunded.",
                });
            }
        }

        // =========================================================================
        // OPTION 3: RAMEEPAY GATEWAY (Supports both INR and Crypto)
        // =========================================================================
        if (executionType === "rameepay") {
            try {
                let payload;

                // Build payload according to RameePay Spec
                if (currency === "CRYPTO") {
                    // RameePay Crypto Spec: Encrypted payload strictly takes amount and orderid
                    payload = {
                        amount: parseFloat(amount).toFixed(2),
                        orderid: String(orderid),
                    };
                } else {
                    // RameePay Fiat / INR Spec
                    payload = {
                        type: "FIAT",
                        account,
                        ifsc,
                        name,
                        mobile,
                        amount: parseFloat(amount).toFixed(2),
                        note: note || "INR Withdrawal payout",
                        orderid: String(orderid),
                    };
                }

                // Determine correct endpoint base URL if different for Crypto vs Fiat
                const endpoint =
                    currency === "CRYPTO"
                        ?  RAMEEPAY_Crypto_API
                        : RAMEEPAY_API;

                // 1. Encrypt payload and send request
                const encryptedReqData = encryptData(payload);

                const { data } = await axios.post(
                    endpoint,
                    {
                        reqData: encryptedReqData,
                        agentCode: process.env.RAMEEPAY_AGENT_CODE,
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 15000, // 15s timeout safeguard
                    }
                );

                // 2. Decrypt response body
                const rawResponseData = data?.data || data?.reqData;
                const responsePayload =
                    typeof rawResponseData === "string"
                        ? decryptData(rawResponseData)
                        : rawResponseData || {};

                // 3. Evaluate Success Status
                // RameePay returns top-level status or inside decrypted object
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

                    // Trigger success email asynchronously
                    sendSuccessEmail(withdrawal).catch((e) =>
                        console.error("Payout Email Failed:", e.message)
                    );

                    return res.json({
                        success: true,
                        message: `Payout initiated via RameePay (${currency})`,
                        response: responsePayload,
                    });
                }

                // If API returned status: false
                throw new Error(
                    responsePayload?.message || responsePayload?.error || "RameePay payout failed at gateway."
                );
            } catch (err) {
                console.error("RameePay Payout Error:", err.response?.data || err.message);

                // Refund MT5 balance if automated payout fails
                await refundToMoneyPlant(accountNo, amount, currency);

                withdrawal.status = "Failed";
                withdrawal.response = err.response?.data || { error: err.message };
                await withdrawal.save();

                return res.status(400).json({
                    success: false,
                    message: err.message || "RameePay payout failed. MT5 Balance refunded.",
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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================
exports.refundToMT5 = async (accountNo, amount, currency) => {
    const usdRate = await fetchRate();
    const amountUSD = currency === "INR"
        ? (parseFloat(amount) / usdRate).toFixed(2)
        : parseFloat(amount).toFixed(2);

    const refundOrderId = `RF${Date.now()}`;


    return updateMT5Balance({
                login: accountNo,
                type: 2,
                balance: amountUSD,
                comment: `REF-${refundOrderId}`,
              });
}

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
}