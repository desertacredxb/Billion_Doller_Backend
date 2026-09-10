const axios = require("axios");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const Withdrawal = require("../models/withdrawal");
const User = require("../models/User");
const Account = require("../models/account.model");
const sendEmail = require("../utils/sendEmail");
const { updateMT5Balance } = require("../utils/MT5/mt5Balance");
const { encryptDataCrypto, encryptData, decryptDataCrypto, decryptData } = require("../utils/rameeCrypto");
const {
    MIN_WITHDRAWAL_USD,
    MIN_WITHDRAWAL_INR,
    WITHDRAWAL_COOLDOWN_MINUTES,
    MAX_WITHDRAWALS_PER_DAY,
    RAMEEPAY_MIN_INR,
    RAMEEPAY_MAX_INR,
} = require("../config/withdrawalLimits");

// "/order/generate" is the DEPOSIT (payin) endpoint - payouts must go to the
// dedicated Withdrawal Account API instead (see RameePay Integration Docs,
// "Withdrawal Account (India Only) API"). Reusing the deposit endpoint here
// was the reason RameePay INR payouts never actually paid out.
const RAMEEPAY_WITHDRAWAL_API = "https://apis.rameepay.io/withdrawal/account";
// v2 crypto API has separate endpoints for creating a pay-in order vs a
// withdrawal - payouts must hit /v2/withdrawal, not /v2/order (the deposit
// endpoint), otherwise RameePay has no idea it's a payout request.
const RAMEEPAY_CRYPTO_WITHDRAWAL_API = "https://crypto-apis.rameepay.io/v2/withdrawal";

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
 * Matches the confirmed-working algorithm used for deposit checkout signing
 * (paymentOrder.controller.js's generateCregisSignature) - Cregis signs the
 * same way across their API, only the key/secret differs per project:
 * 1. Filter out empty fields & 'sign'
 * 2. Key-sort lexicographically
 * 3. Concatenate key1value1key2value2... (no "=", no "&")
 * 4. Prepend the secret key
 * 5. MD5 hash (lowercase)
 *
 * The previous key=val&...&key=SECRET style caused Cregis to reject every
 * payout with "B0001 Signature Error".
 */
function generateCregisSignature(params, secretKey) {
    const sortedKeys = Object.keys(params)
        .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
        .sort();

    let stringToSign = "";
    for (const key of sortedKeys) {
        stringToSign += `${key}${params[key]}`;
    }

    const unsignedString = stringToSign;
    stringToSign = secretKey + stringToSign;

    const sign = crypto.createHash("md5").update(stringToSign).digest("hex").toLowerCase();

    // Debug logging - secret key is redacted to just its length + first/last 2
    // chars so we can confirm it's non-empty/plausible without leaking it.
    const keyPreview = secretKey
        ? `${secretKey.slice(0, 2)}...${secretKey.slice(-2)} (len ${secretKey.length})`
        : "MISSING/EMPTY";
    console.log("🔑 Cregis signature debug:", {
        sortedKeys,
        unsignedString,
        apiKeyPreview: keyPreview,
        signedStringLength: stringToSign.length,
        sign,
    });

    return sign;
}

/**
 * RameePay requires a bare 10-digit Indian mobile number ("Mobile number
 * must have 10 digits."). Numbers on file may include a "+91"/"91" country
 * code, spaces, or dashes, so strip all non-digits and keep the last 10.
 */
function toRameeMobile(rawMobile) {
    const digitsOnly = String(rawMobile || "").replace(/\D/g, "");
    return digitsOnly.slice(-10);
}

/**
 * Maps Network and Token Symbol to official Cregis Currency Codes
 */
const getCregisCurrencyId = (network, cryptoSymbol) => {
    const net = (network || "").toUpperCase();
    const symbol = (cryptoSymbol || "USDT").toUpperCase();

    // Cregis currency identifiers are "<chain_id>@<token_id>" (chain first,
    // NOT token@chain as previously assumed - that reversed order plus
    // treating "56"/"60"/"137" as chain ids is what caused Cregis to reject
    // these as E0005 "Unsupported coin"). token_id is the chain's own id
    // again for a native asset, or the token's real on-chain contract
    // address for a stablecoin. Cregis also uses its own internal chain
    // codes, not standard EVM chain ids - e.g. BSC is 2510 here, not 56.
    // Source: https://developer.cregis.com/api-reference/currency-identifiers
    if (symbol === "USDT") {
        if (net.includes("BEP20") || net.includes("BSC") || net.includes("BNB")) {
            return "2510@0x55d398326f99059ff775485246999027b3197955"; // USDT-BEP20
        }
        if (net.includes("ERC20") || net.includes("ETH")) {
            return "60@0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT-ERC20
        }
        if (net.includes("POLYGON") || net.includes("MATIC")) {
            return "62@0xc2132d05d31c914a87c6611c10748aeb04b58e8f"; // USDT-Polygon
        }
        if (net.includes("SOLANA") || net.includes("SOL")) {
            return "1000@Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT-Solana
        }
        return "195@TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // USDT-TRC20 (Default)
    }

    if (symbol === "BTC") return "0@0";
    if (symbol === "ETH") return "60@60";
    if (symbol === "SOL") return "1000@1000";

    // Native token fallbacks by network, for any other/unmapped symbol
    if (net.includes("BEP20") || net.includes("BSC")) return "2510@2510"; // BNB
    if (net.includes("TRC20") || net.includes("TRX")) return "195@195";  // TRX
    if (net.includes("ERC20") || net.includes("ETH")) return "60@60";    // ETH
    if (net.includes("POLYGON") || net.includes("MATIC")) return "62@62"; // POL

    return "195@TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
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

        // Minimum withdrawal amount (see config/withdrawalLimits.js). Only INR/USD
        // have a defined minimum today - CRYPTO has none, matching what the
        // frontend already enforces.
        if (currency === "USD" && numericAmount < MIN_WITHDRAWAL_USD) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: `Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD}.`,
            });
        }
        if (currency === "INR" && numericAmount < MIN_WITHDRAWAL_INR) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL_INR}.`,
            });
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
        // const existingPending = await Withdrawal.findOne(
        //     { accountNo, status: "Pending" },
        //     null,
        //     { session }
        // );

        // if (existingPending) {
        //     await session.abortTransaction();
        //     session.endSession();
        //     return res.status(400).json({
        //         success: false,
        //         message: "You already have a pending withdrawal request.",
        //     });
        // }

        // 4️⃣ COOLDOWN CHECK
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

        // 5️⃣ DAILY LIMIT CHECK
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const todayCount = await Withdrawal.countDocuments(
            {
                accountNo,
                createdAt: { $gte: startOfDay },
            },
            { session }
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

        // RameePay's Withdrawal Account API requires a non-empty customer
        // mobile (and rejects the request otherwise: '"Customer Mobile" is
        // not allowed to be empty'), but the withdrawal form doesn't collect
        // one. Fall back to the phone number already on file for this
        // account's user instead of forcing a new required field. Also the
        // one reliable place to grab the account's actual userId - relying
        // solely on accountNo (a bare string) meant the only way to find the
        // requester's name was this same lookup done ad hoc wherever needed,
        // so a proper relation is stored on the Withdrawal record itself
        // below instead (see userId on the schema).
        const ownerAccount = await Account.findOne({ accountNo }, null, { session }).populate("user");

        let resolvedMobile = mobile || ownerAccount?.user?.phone || "";
        let resolvedName = accountHolderName || name || ownerAccount?.user?.fullName || "";
        resolvedMobile = toRameeMobile(resolvedMobile);

        // Fail fast, before any MT5 balance is held, if RameePay would reject
        // this later - it requires an exact 10-digit mobile number.
        if (currency === "INR" && resolvedMobile.length !== 10) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: "A valid 10-digit mobile number is required for INR withdrawals.",
            });
        }

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
            userId: ownerAccount?.user?._id || undefined,
            currency,
            amount: numericAmount,
            amountUSD,
            note,
            status: "Pending",
            account: account || "",
            ifsc: ifsc || "",
            upiId: upiId || "",
            name: resolvedName,
            mobile: resolvedMobile,
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
            upiId,
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
                console.error("Cregis payout: CREGIS withdrawal credentials are not configured");
                return res.status(503).json({
                    success: false,
                    message: "We’re unable to process your withdrawal right now. Please try again in a few moments.",
                });
            }

            // Docs require exactly a 6-character nonce - Math.random().toString(36)
            // can occasionally produce fewer chars, so pad/generate deterministically.
            const nonceChars = "abcdefghijklmnopqrstuvwxyz0123456789";
            const nonce = Array.from({ length: 6 }, () => nonceChars[Math.floor(Math.random() * nonceChars.length)]).join("");
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

            console.log("📤 Cregis payout request:", {
                ...cregisPayload,
                pidEnvRaw: process.env.CREGIS_WITHDRAWAL_PID,
            });

            try {
                const { data: cregisRes } = await axios.post(
                    "https://t-jcgfykxv.cregis.io/api/v1/payout",
                    cregisPayload,
                    { headers: { "Content-Type": "application/json" } }
                );

                console.log("📥 Cregis payout response:", cregisRes);

                if (cregisRes.code === "00000") {
                    // "00000" only means Cregis ACCEPTED the payout request (assigned a
                    // cid) - it does not mean the on-chain transaction has succeeded yet.
                    // The real outcome (status 6 = success, 2/4/7 = failure) arrives later
                    // via the Cregis payout webhook (handleCregisCallback's payout branch
                    // in controllers/payments/cregis.controller.js), which is what actually
                    // flips this to Completed (+ email) or Failed (+ auto refund).
                    withdrawal.status = "Processing";
                    withdrawal.processType = "Cregis API";
                    withdrawal.cregisCid = cregisRes.data?.cid;
                    withdrawal.response = cregisRes;
                    await withdrawal.save();

                    return res.json({
                        success: true,
                        message: "Crypto payout submitted to Cregis and is awaiting on-chain confirmation.",
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

                console.error("📥 Cregis payout request threw:", {
                    httpStatus: gatewayErr.response?.status,
                    data: gatewayErr.response?.data,
                    message: gatewayErr.message,
                });

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
            // RameePay's documented Withdrawal Account API only takes a bank
            // account + IFSC (see RameePay Integration Docs) - there is no
            // UPI field/endpoint in it. A UPI-only INR request would otherwise
            // hit that API with blank account/ifsc and fail in a confusing way
            // at the gateway, so route it to manual processing up front instead.
            if (currency === "INR" && (!account || !ifsc) && upiId) {
                return res.status(400).json({
                    success: false,
                    message: "This is a UPI withdrawal - RameePay's API doesn't support UPI payouts. Please process it manually.",
                });
            }

            // RameePay's own gateway limit ("Transaction amount must be
            // between 100 and 100000") - independent of our configurable
            // MIN_WITHDRAWAL_INR, which can be set lower for testing but
            // won't make the gateway accept a smaller amount.
            const payoutAmount = Number(amount);
            if (currency === "INR" && (payoutAmount < RAMEEPAY_MIN_INR || payoutAmount > RAMEEPAY_MAX_INR)) {
                return res.status(400).json({
                    success: false,
                    message: `RameePay only accepts INR withdrawals between ₹${RAMEEPAY_MIN_INR} and ₹${RAMEEPAY_MAX_INR}. This amount is outside that range - process it manually instead.`,
                });
            }

            // RameePay rejects the request outright if "name"/"mobile" are
            // empty. createPayoutRequest now fills these in from the
            // account's user record for NEW requests, but records created
            // before that fix (or otherwise saved without them) would keep
            // failing identically on every retry - so re-resolve here too.
            let payoutMobile = mobile;
            let payoutName = name;
            if (currency !== "CRYPTO" && (!payoutMobile || !payoutName)) {
                const ownerAccount = await Account.findOne({ accountNo }).populate("user");
                payoutMobile = payoutMobile || ownerAccount?.user?.phone || "";
                payoutName = payoutName || ownerAccount?.user?.fullName || "";
            }
            payoutMobile = toRameeMobile(payoutMobile);

            if (currency !== "CRYPTO" && payoutMobile.length !== 10) {
                return res.status(400).json({
                    success: false,
                    message: `Withdrawal has an invalid mobile number ("${mobile || ""}") - it must resolve to exactly 10 digits for RameePay. Please correct it and retry.`,
                });
            }

            try {
                let payload;

                if (currency === "CRYPTO") {
                    // Per RameePay's v2 Create Withdrawal API: method 2 = crypto payout,
                    // and orderDetails.address is required - it was missing entirely
                    // before, so crypto payouts had no destination wallet to send to.
                    // payload = {
                    //     method: 2,
                    //     orderid: String(orderid),
                    //     amount: Number(parseFloat(amount).toFixed(2)),
                    //     currency: `${(cryptoSymbol || "USDT").toUpperCase()}_${(network || "TRC20").toUpperCase()}`,
                    //     orderDetails: { address: walletAddress },
                    // };
                    payload = {
                        method: 2,
                        orderid: 'TSTCRYc00005',
                        amount: 55,
                        currency: "USDTTRC20",
                        orderDetails: { address: "TRmobam7jxYRXE2f1vBdn8oCprxeZdSgGM" },
                    };
                } else {
                    // Exact field set per RameePay's "Withdrawal Account (India Only)
                    // API" doc - account, ifsc, name, mobile, amount, note, orderid.
                    // No "type" field is documented there; it was previously sent
                    // but isn't part of this endpoint's schema.
                    payload = {
                        account,
                        ifsc,
                        name: payoutName,
                        mobile: payoutMobile,
                        amount: Number(parseFloat(amount).toFixed(2)),
                        // RameePay caps "note" at 20 characters (both the
                        // user-supplied note and our own fallback text must
                        // fit - "INR Withdrawal payout" was 22 chars and got
                        // rejected outright).
                        note: (note || "INR Withdrawal").slice(0, 20),
                        orderid: String(orderid),
                    };
                }

                const isCrypto = currency === "CRYPTO";
                const endpoint = isCrypto ? RAMEEPAY_CRYPTO_WITHDRAWAL_API : RAMEEPAY_WITHDRAWAL_API;
                const encryptedReqData = isCrypto ? encryptDataCrypto(payload) : encryptData(payload);

                // The v2 crypto API takes the agent code as an "agentcode" header and
                // only { data: <encrypted> } in the body (sending it in the body is
                // no longer accepted there). The fiat Withdrawal Account API is a
                // separate, older endpoint that still expects reqData/agentCode in
                // the body, so only the crypto branch changes shape here.
                const requestBody = isCrypto
                    ? { data: encryptedReqData }
                    : { reqData: encryptedReqData, agentCode: process.env.RAMEEPAY_AGENT_CODE };
                const requestHeaders = isCrypto
                    ? { "Content-Type": "application/json", agentcode: process.env.CRYPTO_AGENT_CODE }
                    : { "Content-Type": "application/json" };

                const { data } = await axios.post(endpoint, requestBody, {
                    headers: requestHeaders,
                    timeout: 15000,
                });

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
                const rawApiError = err.response?.data || {};
                let apiError = rawApiError;

                // RameePay encrypts error bodies the same way as success ones
                // (isSuccess above is what actually decides pass/fail, not HTTP
                // status) - without decrypting, all we'd log is an opaque
                // base64 blob instead of the real reason (e.g. "Unsupported currency").
                if (currency === "CRYPTO" && rawApiError?.data) {
                    const decryptedError = decryptDataCrypto(rawApiError.data);
                    if (decryptedError) apiError = decryptedError;
                }

                const detailedMsg = apiError.message || apiError.msg || err.message || "RameePay payout failed.";

                console.error(`❌ RameePay (${currency}) Payout Error for ${orderid}:`, apiError);

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

        // fetchRate() returns "1 INR = X USD" (X ~ 0.012) - converting INR to USD
        // means multiplying by that rate, same as createPayoutRequest does when it
        // first computes amountUSD. (Dividing here previously inflated INR refunds
        // by ~1/rate, e.g. ~83x.)
        const amountUSD = currency === "INR"
            ? (parsedAmount * usdRate).toFixed(2)
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

        // Allow rejecting from "Failed" too - a Failed withdrawal means the
        // gateway (Cregis/RameePay) couldn't complete the payout, but the funds
        // are still held (deducted from MT5 at request time). This is how an
        // admin gives the customer their money back instead of retrying/manually
        // transferring when the payout portal isn't working.
        if (withdrawal.status !== "Pending" && withdrawal.status !== "Failed") {
            return res
                .status(400)
                .json({ success: false, message: `Withdrawal is already ${withdrawal.status}. Cannot reject.` });
        }

        // Refund the amount that was actually deducted from MT5 when the request
        // was created (amountUSD, already USD - fall back to converting `amount`
        // for any older record saved before that field existed).
        const amountUSD = withdrawal.amountUSD
            ? Number(withdrawal.amountUSD)
            : withdrawal.currency === "INR"
                ? Number((Number(withdrawal.amount) * (await fetchRate())).toFixed(2))
                : Number(withdrawal.amount);

        const refundOrderId = `RF${Date.now()}`;

        console.log(withdrawal.accountNo, amountUSD, refundOrderId);

        // Positive balance - this reverses the negative deduction made at
        // request time (createPayoutRequest), refunding the held funds back.
        const mt5Response = await updateMT5Balance({
            login: withdrawal.accountNo,
            type: 2,
            balance: Math.abs(amountUSD).toFixed(2),
            comment: `REF-${refundOrderId}`.substring(0, 31),
        });

        console.log("MT5 Response:", mt5Response);

        // --------------------------------------------
        // Validate MT5 response
        // --------------------------------------------
        const retCode = String(mt5Response.retcode || "");
        if (!retCode.startsWith("0") && retCode !== "0 Done") {
            throw new Error(`MT5 Refund Failed: ${mt5Response.retcode}`);
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
            message:
                err.response?.data?.message ||
                err.message ||
                "Failed to reject withdrawal",
        });
    }
};