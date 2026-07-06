const axios = require("axios");
const Transaction = require("../models/Transaction");
const { decryptData, decryptDataCrypto } = require("../utils/rameeCrypto");
const Order = require("../models/Order");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const Account = require("../models/account.model"); // Ensure you import Account model
const { default: mongoose } = require("mongoose");
const Withdrawal = require("../models/withdrawal");

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

        // 4️⃣ Update balance in MoneyPlant API
        // const mpResponse = await axios.post(
        //   "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
        //   { accountno, amount: amountUSD, orderid },
        //   { headers: { "Content-Type": "application/json" } }
        // );

        // console.log("💰 MoneyPlant Response:", mpResponse.data);



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
        // console.error("❌ MoneyPlant or Email Error:", err.message);
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

exports.handleManualPaymentRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { ifsc, name, mobile, amount, note, accountNo, bankName } = req.body;

    if (!ifsc || !name || !mobile || !amount || !accountNo) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid withdrawal amount" });
    }

    // 🔒 1️⃣ BLOCK MULTIPLE PENDING
    const existingPending = await Withdrawal.findOne(
      { accountNo, status: "Pending" },
      null,
      { session },
    );

    if (existingPending) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "You already have a pending withdrawal request.",
      });
    }

    // 5 MINUTE COOLDOWN
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

    // DAILY LIMIT (3 per day)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await Withdrawal.countDocuments(
      {
        accountNo,
        createdAt: { $gte: startOfDay },
      },
      { session },
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

    // 🔹 First, deduct from MoneyPlant to lock balance
    const usdRate = await fetchRate();
    const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

    // 🔹 Save withdrawal record in Pending state
    const withdrawalRecord = new Withdrawal({
      orderid,
      bankName,
      ifsc,
      name,
      mobile,
      amount,
      note,
      accountNo,
      status: "Pending",
    });
    console.log("Saving withdrawal record:", withdrawalRecord);
    await withdrawalRecord.save();

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "📤 New Manual Withdrawal Request Submitted",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #f39c12;">New Manual Withdrawal Request Submitted</h2>

      <p>
        A new withdrawal request has been submitted by a user using manually entered bank details and is awaiting review.
      </p>

      <ul>
        <li><strong>Withdrawal Type:</strong> Manual Bank Details Submission</li>
        <li><strong>Name:</strong> ${name}</li>
        <li><strong>Order ID:</strong> ${orderid}</li>
        <li><strong>Amount:</strong> ₹${amount} (≈ $${amountUSD})</li>
        <li><strong>Bank Name:</strong> ${bankName}</li>
        <li><strong>Account Number:</strong> ${accountNo}</li>
        <li><strong>IFSC:</strong> ${ifsc}</li>
        <li><strong>Mobile:</strong> ${mobile}</li>
        <li><strong>Note:</strong> ${note || "N/A"}</li>
      </ul>

      <p>
        Please log in to the admin dashboard to review and process this withdrawal request.
      </p>

      <br />
      <p>
        Regards,<br />
        <strong>Billion Dollar FX System</strong>
      </p>
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
}

// your schema with { orderid, accountNo, amount, status }

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

exports.handleRameeCallback = async (req, res) => {
  try {
    const { data, agentCode } = req.body;

    if (!data || !agentCode) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payload" });
    }
    console.log(data);
    // 1. Decrypt RameePay response
    const txn = decryptData(data);
    console.log("🔓 Decrypted Webhook:", txn);

    if (txn.status === "SUCCESS") {
      const orderid = txn.merchantid;
      const amount = txn.realAmount;

      // 2. Find order mapping from DB
      const order = await Order.findOne({ orderid });
      if (!order) {
        console.error("❌ Order not found in DB:", orderid);
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      const accountno = order.accountNo;

      // 3. Update status in DB
      if (txn.status === "SUCCESS") {
        order.status = "SUCCESS";
      } else if (txn.status === "FAILED") {
        order.status = "FAILED";
      }
      await order.save();

      // ✅ 4. Convert INR → USD
      const usdRate = await fetchRate();
      const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

      console.log(`💱 Converted: ₹${amount} → $${amountUSD} (rate ${usdRate})`);

      // 5. Call MoneyPlant API
      try {
        // const mpResponse = await axios.post(
        //   "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
        //   { accountno, amount: amountUSD, orderid },
        //   { headers: { "Content-Type": "application/json" } }
        // );

        // console.log("💰 MoneyPlant Response:", mpResponse.data);
        // const AccountNo=accountno

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

        // ✅ 6. Send confirmation email to user
        const account = await Account.findOne({
          accountNo: accountno,
        }).populate("user");
        console.log(account);
        if (account) {
          await sendEmail({
            to: account.user.email,
            subject: "Deposit Successful - Balance Updated",
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
                <p>Dear ${account.user.fullName || "Customer"},</p>
                <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_deposit_has_been_credited_rczjut.jpg" 
         alt="Withdrawal Processed" 
         style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
                <p>Your deposit has been successfully processed and your trading balance has been updated.</p>
                
                <p><strong>Transaction Details:</strong></p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Amount Deposited:</strong> ₹${amount} (≈ $${amountUSD})</li>
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
      } catch (err) {
        console.error("❌ MoneyPlant Error:", err.message);
      }
    }

    // 7. Acknowledge webhook
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Callback Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.handleCryptoCallback = async (req, res) => {
  try {
    const { data, agentCode } = req.body;

    if (!data || !agentCode) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payload" });
    }
    console.log(data);
    // 1. Decrypt RameePay response
    const txn = decryptDataCrypto(data);
    console.log("🔓 Decrypted Webhook:", txn);

    if (txn.status === "SUCCESS") {
      const orderid = txn.merchantid;
      const amount = txn.payAmount;

      // 2. Find order mapping from DB
      const order = await Order.findOne({ orderid });
      if (!order) {
        console.error("❌ Order not found in DB:", orderid);
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      const accountno = order.accountNo;

      // 3. Update status in DB
      if (txn.status === "SUCCESS") {
        order.status = "SUCCESS";
      } else if (txn.status === "FAILED") {
        order.status = "FAILED";
      }
      await order.save();

      // ✅ 4. Convert INR → USD
      const usdRate = await fetchRate();
      const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

      console.log(`💱 Converted: ₹${amount} → $${amountUSD} (rate ${usdRate})`);

      // 5. Call MoneyPlant API
      try {
        // const mpResponse = await axios.post(
        //   "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
        //   { accountno, amount: amountUSD, orderid },
        //   { headers: { "Content-Type": "application/json" } }
        // );

        // console.log("💰 MoneyPlant Response:", mpResponse.data);
        // const AccountNo=accountno

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

        // ✅ 6. Send confirmation email to user
        const account = await Account.findOne({
          accountNo: accountno,
        }).populate("user");
        console.log(account);
        if (account) {
          await sendEmail({
            to: account.user.email,
            subject: "Deposit Successful - Balance Updated",
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
                <p>Dear ${account.user.fullName || "Customer"},</p>
                <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_deposit_has_been_credited_rczjut.jpg"
         alt="Withdrawal Processed"
         style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
                <p>Your deposit has been successfully processed and your trading balance has been updated.</p>

                <p><strong>Transaction Details:</strong></p>
                <ul>
                  <li><strong>Order ID:</strong> ${orderid}</li>
                  <li><strong>Amount Deposited:</strong> ₹${amount} (≈ $${amountUSD})</li>
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
      } catch (err) {
        console.error("❌ MoneyPlant Error:", err.message);
      }
    }

    // 7. Acknowledge webhook
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Callback Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
