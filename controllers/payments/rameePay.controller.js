const axios = require("axios");
const { decryptData, encryptData } = require("../../utils/rameeCrypto");
const Order = require("../../models/Order");
const Withdrawal = require("../../models/withdrawal");
const Account = require("../../models/account.model");
const sendEmail = require("../../utils/sendEmail");
const { updateMT5Balance } = require("../../utils/MT5/mt5Balance");
const { sendSuccessEmail } = require("../payout.controller");
const fetchRate = require("./fetchRate");

const AGENT_CODE = process.env.RAMEEPAY_AGENT_CODE;
const RAMEEPAY_API = "https://apis.rameepay.io/order/generate";

exports.handleRameeDeposit = async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    if (!accountNo || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    // 1. Generate unique orderid
    const orderid = "ORP" + Date.now();

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
      provider: "RAMEE",
      merchantOrderId: orderid,
      status: "PENDING",
    });
    await newOrder.save();

    // 4. Prepare payload for RameePay (only orderid & amount required)
    const orderData = { orderid, amount };

    // Encrypt payload
    const encryptedData = encryptData(orderData);
    console.log("encryypted data", encryptedData);

    const body = {
      reqData: encryptedData,
      agentCode: AGENT_CODE,
    };

    // 5. Send to RameePay
    const apiRes = await axios.post(RAMEEPAY_API, body, {
      headers: { "Content-Type": "application/json" },
    });
    console.log("res", apiRes.data);

    // 6. Decrypt response if exists
    let decryptedResponse = {};
    if (apiRes.data?.data) {
      decryptedResponse = decryptData(apiRes.data.data);
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
};

exports.handleRameeCallback = async (req, res) => {
  try {
    const { data, agentCode } = req.body;

    if (!data || !agentCode) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payload" });
    }

    // 1. Decrypt RameePay response
    const txn = decryptData(data);
    console.log("🔓 Decrypted Fiat Webhook:", txn);

    // RameePay's own docs are inconsistent about which field carries *our*
    // order id (page 4 shows "merchantid"+"orderid" together, the webhook
    // section and withdrawal-status responses spell it "ordered" instead of
    // "orderid"). Rather than guess wrong and silently drop real callbacks,
    // treat every field they've ever used as a candidate and match any of them.
    const candidateOrderIds = [txn.orderid, txn.merchantid, txn.ordered]
      .filter((v) => v !== undefined && v !== null && v !== "")
      .map(String);
    const amount = txn.realAmount || txn.amount;
    const status = String(txn.status || "").toUpperCase();
    const isSuccess = status === "SUCCESS" || status === "COMPLETED";
    const isFailed = status === "FAILED" || status === "REJECTED";

    if (candidateOrderIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID missing in payload" });
    }

    const orderid = candidateOrderIds[0];

    // =========================================================================
    // CHECK 1: WITHDRAWAL / PAYOUT PROCESSING
    // =========================================================================
    const withdrawal = await Withdrawal.findOne({ orderid: { $in: candidateOrderIds } });

    if (withdrawal) {
      if (["Completed", "Failed"].includes(withdrawal.status)) {
        return res.json({ success: true, message: "Withdrawal already processed" });
      }

      if (isSuccess) {
        withdrawal.status = "Completed";
        withdrawal.response = { ...withdrawal.response, callbackData: txn };
        await withdrawal.save();

        await sendSuccessEmail(withdrawal);
        console.log(`✅ Fiat Withdrawal Completed: ${orderid}`);
      } else if (isFailed) {
        // Mark Failed only - do NOT auto-refund. The funds stay held (already
        // deducted from MT5 at request time) so an admin can still manually
        // transfer them instead. Only the explicit admin "Reject & Refund"
        // action (rejectPayoutRequest) is allowed to move money back to MT5.
        withdrawal.status = "Failed";
        withdrawal.response = { ...withdrawal.response, callbackData: txn };
        await withdrawal.save();

        console.log(`❌ Fiat Withdrawal Failed (awaiting admin action): ${orderid}`);
      }

      return res.status(200).json({ success: true, message: "Withdrawal callback handled" });
    }

    // =========================================================================
    // CHECK 2: DEPOSIT / PAYIN PROCESSING
    // =========================================================================
    const order = await Order.findOne({ orderid: { $in: candidateOrderIds } });
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
    let creditFailed = false;

    if (isFailed) {
      order.status = "FAILED";
      await order.save();
    }

    if (isSuccess) {
      // Convert INR -> USD
      const usdRate = await fetchRate();
      const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

      console.log(`💱 Converted: ₹${amount} → $${amountUSD} (rate ${usdRate})`);

      try {
        const mt5Response = await updateMT5Balance({
          login: accountno,
          type: 2, // Balance operation (deposit)
          balance: amountUSD,
          comment: `DEP-${orderid}`.substring(0, 31),
        });

        console.log("💰 MT5 Response:", mt5Response);

        // Validate MT5 response directly from returned object
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
            subject: "Deposit Successful - Balance Updated",
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
                <p>Dear ${account.user.fullName || "Customer"},</p>
                <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_deposit_has_been_credited_rczjut.jpg"
                     alt="Deposit Processed"
                     style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
                <p>Your deposit has been successfully processed and your trading balance has been updated.</p>

                <p><strong>Transaction Details:</strong></p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Amount Deposited:</strong> ₹${amount} (≈ $${amountUSD})</li>
                  <li><strong>Status:</strong> Successful</li>
                  <li><strong>Ticket ID:</strong> ${mt5Response.ticket || "N/A"}</li>
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
        // Do NOT silently swallow this: RameePay already collected the money,
        // so if MT5 crediting fails the order must NOT be acknowledged as
        // handled - otherwise RameePay never retries the webhook and the
        // deposit just vanishes (order stuck PENDING forever, no visibility).
        creditFailed = true;
        console.error(`❌ MT5 Error crediting order ${orderid}:`, err.message);

        try {
          await sendEmail({
            to: "support@billiondollarfx.com",
            subject: `⚠️ RameePay deposit received but MT5 credit FAILED - ${orderid}`,
            html: `
              <div style="font-family: Arial, sans-serif; color: #333;">
                <h2 style="color: #c0392b;">RameePay Deposit Credit Failed</h2>
                <p>RameePay confirmed payment for order <strong>${orderid}</strong>, but crediting the
                trading account failed. The order remains <strong>PENDING</strong> and needs manual review.</p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Trading Account:</strong> ${accountno}</li>
                  <li><strong>Amount:</strong> ₹${amount}</li>
                  <li><strong>Error:</strong> ${err.message}</li>
                </ul>
              </div>
            `,
          });
        } catch (mailErr) {
          console.error("❌ Failed to send MT5-credit-failure alert email:", mailErr.message);
        }
      }
    }

    if (creditFailed) {
      // Ack as "FAILED" per RameePay's documented webhook contract so their
      // system treats this delivery as not-yet-processed and retries later.
      return res.status(200).json({ success: false, status: "FAILED", message: "Credit failed, will retry" });
    }

    return res.status(200).json({ success: true, status: "SUCCESS" });
  } catch (error) {
    console.error("❌ Callback Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
