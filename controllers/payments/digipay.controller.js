const axios = require("axios");
const Transaction = require("../../models/Transaction");
const Order = require("../../models/Order");
const Account = require("../../models/account.model");
const sendEmail = require("../../utils/sendEmail");
const fetchRate = require("./fetchRate");

let DIGIPAY_TOKEN = null;
let TOKEN_EXPIRY = null;

async function digiPayLogin() {
  const res = await axios.post("https://digipay247.pgbackend.xyz/login", {
    username: process.env.DIGIPAY_USERNAME,
    password: process.env.DIGIPAY_PASSWORD,
  });

  DIGIPAY_TOKEN = res.data.data.token;
  TOKEN_EXPIRY = Date.now() + res.data.data.expires_in * 1000;
  return DIGIPAY_TOKEN;
}

exports.handleDigipayDeposit = async (req, res) => {
  try {
    const { amount, merchant_user_id } = req.body;

    if (!amount || !merchant_user_id) {
      return res.status(400).json({
        status: "FAILED",
        message: "amount and merchant_user_id required",
      });
    }

    // 1. Find account and populate user
    const account = await Account.findOne({
      accountNo: merchant_user_id,
    }).populate("user", "fullName email");
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    // 2. Ensure valid token
    if (!DIGIPAY_TOKEN || Date.now() > TOKEN_EXPIRY) {
      await digiPayLogin();
    }

    // 3. Generate unique transaction/order id
    const merchant_txn_id = "ODP" + Date.now();

    // 4. Create a new Order (before hitting DigiPay)
    const newOrder = new Order({
      orderid: merchant_txn_id,
      account: account._id, // link to Account
      accountNo: account.accountNo,
      amount,
      provider: "DIGIPAY",
      status: "PENDING",
    });
    await newOrder.save();

    // 5. Call DigiPay API
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

    // 6. Return payment info
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
        name: account.user?.fullName || "Unknown",
      },
    });
  } catch (err) {
    console.error("Deposit error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "FAILED",
      error: err.response?.data?.message || err.message,
    });
  }
};

exports.handlePaymentCallback = async (req, res) => {
  try {
    const txn = req.body.transaction;
    console.log(txn);

    if (!txn || !txn.id) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid callback data" });
    }

    // 1️⃣ Check if transaction already processed
    const existing = await Transaction.findOne({ transactionId: txn.id });
    if (existing) {
      return res
        .status(200)
        .json({ success: true, message: "Duplicate callback ignored" });
    }

    // 2️⃣ Save transaction
    const transaction = new Transaction({
      transactionId: txn.id,
      status: txn.status,
      merchantTxnId: txn.merchant_txn_id,
      merchantUserId: txn.merchant_user_id,
      amount: Number(txn.amount),
      type: txn.type,
      addedOn: new Date(txn.added_on),
      refId: txn.ref_id,
      gateway: txn.gateway ? Number(txn.gateway) : null,
      merchant: txn.merchant ? Number(txn.merchant) : null,
      wallet: txn.wallet ? Number(txn.wallet) : null,
      currency: txn.currency || "INR",
      transactionPayinRequests: Array.isArray(txn.transaction_payin_requests)
        ? txn.transaction_payin_requests
        : [],
    });

    await transaction.save();

    // 3️⃣ If payment is completed, proceed
    if (txn.status === "completed") {
      const accountno = txn.merchant_user_id;
      const amountINR = Number(txn.amount);
      const orderid = txn.merchant_txn_id;

      // 💱 Convert INR → USD
      const usdRate = await fetchRate();
      const amountUSD = (amountINR * usdRate).toFixed(2);

      console.log(
        `💱 Converted ₹${amountINR} → $${amountUSD} (rate ${usdRate})`
      );

      try {
        const order = await Order.findOne({ orderid });

        if (!order) {
          console.error("⚠ No matching order found for callback:", orderid);
        } else {
          order.status = "SUCCESS";
          await order.save();
        }

        // 4️⃣ Update balance in MT5
        const mt5Response = await axios.post(
          `${process.env.MT5_WEB_API_URL}/api/trade/balance`,
          null,
          {
            params: {
              login: accountno, // keep existing accountno variable
              type: 2, // balance operation (deposit)
              balance: amountUSD, // keeping your existing USD conversion
              comment: `DEP-${orderid}`.substring(0, 32), // MT5 max comment length = 32 chars
            },
          }
        );

        console.log("💰 MT5 Response:", mt5Response.data);

        if (
          mt5Response.data.retcode !== "0 Done" &&
          mt5Response.data.retcode !== 0
        ) {
          throw new Error(
            `MT5 Deposit Failed: ${mt5Response.data.retcode}`
          );
        }

        // 5️⃣ Send confirmation email
        const account = await Account.findOne({
          accountNo: accountno,
        }).populate("user");

        if (account) {
          await sendEmail({
            to: account.user.email,
            subject: "Deposit Successful - Balance Updated",
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
                <p>Dear ${account.user.fullName || "Customer"},</p>
                <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_deposit_has_been_credited_rczjut.jpg"
                     alt="Deposit Confirmed"
                     style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
                <p>Your deposit has been successfully processed and your trading balance has been updated.</p>

                <p><strong>Transaction Details:</strong></p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Amount Deposited:</strong> ₹${amountINR} (≈ $${amountUSD})</li>
                  <li><strong>Status:</strong> Successful</li>
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

        return res.status(200).json({
          success: true,
          message: "Transaction saved, balance updated, and email sent",
          mt5: mt5Response.data,
        });
      } catch (err) {
        console.error("MT5 or Email Error:", err.message);
        return res.status(500).json({
          success: false,
          message: "Transaction saved but post-processing failed",
          error: err.message,
        });
      }
    }

    // 6️⃣ If not completed
    return res.status(200).json({
      success: true,
      message: "Transaction saved but payment not completed",
    });
  } catch (error) {
    console.error("❌ Callback Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};
