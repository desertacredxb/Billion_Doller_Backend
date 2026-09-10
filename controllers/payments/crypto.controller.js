const axios = require("axios");
const { decryptDataCrypto, encryptDataCrypto } = require("../../utils/rameeCrypto");
const Order = require("../../models/Order");
const Withdrawal = require("../../models/withdrawal");
const Account = require("../../models/account.model");
const sendEmail = require("../../utils/sendEmail");
const { updateMT5Balance } = require("../../utils/MT5/mt5Balance");
const { sendSuccessEmail } = require("../payout.controller");
const fetchRate = require("./fetchRate");

const CRYPTO_AGENT_CODE = process.env.CRYPTO_AGENT_CODE;
const RAMEEPAY_Crypto_API = "https://crypto-apis.rameepay.io/v2/order";

exports.handleCryptoDeposit = async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    if (!accountNo || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    // 1. Generate unique orderid
    const orderid = "OCP" + Date.now();

    // 2. Find account (to save reference)
    const account = await Account.findOne({ accountNo });
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // 3. Save new order
    const newOrder = new Order({
      orderid,
      account: account._id, // link to Account
      accountNo: account.accountNo, // backup string
      amount,
      provider: "CRYPTO",
      status: "PENDING",
    });
    await newOrder.save();

    // 4. Prepare payload for RameePay (only orderid & amount required)
    const orderData = { orderid, amount };

    // Encrypt payload
    const encryptedData = encryptDataCrypto(orderData);
    console.log("Encrypted Data:", encryptedData);

    // RameePay's v2 crypto API takes only the encrypted payload in the body -
    // the agent code goes in the "agentcode" header, not the body (sending it
    // in the body is no longer accepted and the request would get rejected
    // as Unauthorized).
    const body = { data: encryptedData };
    console.log(body);

    // 5. Send to RameePay
    const { data } = await axios.post(RAMEEPAY_Crypto_API, body, {
      headers: { "Content-Type": "application/json", agentcode: CRYPTO_AGENT_CODE },
    });
    console.log(data);

    // 6. Decrypt response if exists
    let decryptedResponse = {};
    if (data.data) {
      decryptedResponse = decryptDataCrypto(data.data);
      console.log("✅ Decrypted Response:", decryptedResponse);
    }

    // 7. Return response to frontend
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
};

exports.handleCryptoCallback = async (req, res) => {
  try {
    const { data, agentCode, reqData } = req.body;
    const rawPayload = data || reqData;

    if (!rawPayload || !agentCode) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payload" });
    }

    // 1. Decrypt RameePay Crypto response
    const txn = decryptDataCrypto(rawPayload);
    console.log("🔓 Decrypted Crypto Webhook:", txn);

    // Crypto Spec: orderid, payAmount, status, hash
    const orderid = txn.merchantid || txn.orderid;
    const amount = txn.payAmount || txn.amount;
    const status = String(txn.status || "").toUpperCase();
    const isSuccess = status === "SUCCESS" || status === "COMPLETED";
    const isFailed = status === "FAILED" || status === "REJECTED" || status === "EXPIRED";

    if (!orderid) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID missing in payload" });
    }

    // =========================================================================
    // CHECK 1: WITHDRAWAL / PAYOUT PROCESSING
    // =========================================================================
    const withdrawal = await Withdrawal.findOne({ orderid });

    if (withdrawal) {
      if (["Completed", "Failed"].includes(withdrawal.status)) {
        return res.json({ success: true, message: "Withdrawal already processed" });
      }

      if (isSuccess) {
        withdrawal.status = "Completed";
        withdrawal.transactionReference = txn.hash || withdrawal.transactionReference;
        withdrawal.response = { ...withdrawal.response, callbackData: txn };
        await withdrawal.save();

        await sendSuccessEmail(withdrawal);
        console.log(`✅ Crypto Withdrawal Completed: ${orderid}`);
      } else if (isFailed) {
        // Mark Failed only - do NOT auto-refund. The funds stay held (already
        // deducted from MT5 at request time) so an admin can still manually
        // transfer them instead. Only the explicit admin "Reject & Refund"
        // action (rejectPayoutRequest) is allowed to move money back to MT5.
        withdrawal.status = "Failed";
        withdrawal.response = { ...withdrawal.response, callbackData: txn };
        await withdrawal.save();

        console.log(`❌ Crypto Withdrawal Failed (awaiting admin action): ${orderid}`);
      }

      return res.status(200).json({ success: true, message: "Crypto withdrawal callback handled" });
    }

    // =========================================================================
    // CHECK 2: DEPOSIT / PAYIN PROCESSING
    // =========================================================================
    const order = await Order.findOne({ orderid });
    if (!order) {
      console.error("❌ Order/Withdrawal not found in DB:", orderid);
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (order.status === "SUCCESS") {
      return res.json({ success: true, message: "Deposit already processed" });
    }

    const accountno = order.accountNo;

    if (isFailed) {
      order.status = "FAILED";
      await order.save();
    }

    if (isSuccess) {
      // Direct USD credit or rate conversion depending on your setup
      const usdRate = await fetchRate();
      const amountUSD = amount;

      console.log(`💱 Crypto Credit: ${amount} USDT → $${amountUSD}`);

      try {
        // Execute MT5 balance deposit request
        const mt5Response = await updateMT5Balance({
          login: accountno,
          type: 2, // Balance operation (deposit)
          balance: amountUSD,
          comment: `DEP-${orderid}`.substring(0, 31),
        });

        console.log("💰 MT5 Response:", mt5Response);

        // Validate MT5 Response Code directly from object
        const retCode = String(mt5Response.retcode || "");

        if (!retCode.startsWith("0") && retCode !== "0 Done") {
          throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
        }

        order.status = "SUCCESS";
        await order.save();

        console.log(`✅ MT5 Balance Updated Successfully. Ticket: ${mt5Response.ticket}`);

        // Send confirmation email
        const account = await Account.findOne({ accountNo: accountno }).populate("user");
        if (account?.user?.email) {
          await sendEmail({
            to: account.user.email,
            subject: "Crypto Deposit Successful - Balance Updated",
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #2c3e50;">Crypto Deposit Confirmation</h2>
                <p>Dear ${account.user.fullName || "Customer"},</p>
                <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_deposit_has_been_credited_rczjut.jpg"
                     alt="Deposit Processed"
                     style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
                <p>Your Crypto deposit has been successfully processed and your trading balance has been updated.</p>

                <p><strong>Transaction Details:</strong></p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Amount Deposited:</strong> ${amount} USDT (≈ $${amountUSD})</li>
                  <li><strong>Status:</strong> Successful</li>
                  <li><strong>Ticket ID:</strong> ${mt5Response.ticket || "N/A"}</li>
                  <li><strong>TX Hash:</strong> ${txn.hash || "N/A"}</li>
                  <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
                </ul>

                <p>The amount has been credited to your trading account <strong>${accountno}</strong>.</p>
                <p>If you did not initiate this transaction, please contact our support team immediately.</p>
                <br/>
                <p>Best Regards,<br/>The Support Team</p>
              </div>
            `,
          });
        }
      } catch (err) {
        console.error("❌ MT5 Error:", err.message);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Callback Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
