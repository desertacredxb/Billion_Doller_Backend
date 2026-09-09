const axios = require("axios");
const Order = require("../../models/Order");
const Account = require("../../models/account.model");
const { updateMT5Balance } = require("../../utils/MT5/mt5Balance");
const fetchRate = require("./fetchRate");
const { MIN_DEPOSIT_INR } = require("../../config/depositLimits");

const TRUSTPAY_API = "https://trustpay24.online";

exports.handleTrustpay24Deposit = async (req, res) => {
  try {
    const { accountNo, amount } = req.body;
    console.log("Deposit request:", accountNo, amount);

    const numericAmount = Number(amount);

    // Validate request
    if (
      !accountNo ||
      !Number.isFinite(numericAmount) ||
      numericAmount < MIN_DEPOSIT_INR
    ) {
      return res.status(400).json({
        success: false,
        message: `A valid account number and minimum amount of ${MIN_DEPOSIT_INR} are required`,
      });
    }

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
      orderid: String(merchantOrderId),
      account: account._id,
      accountNo: String(account.accountNo),
      amount: numericAmount,
      provider: "TRUSTPAY24",
      providerOrderId: merchantOrderId,
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
};

exports.handleTrustpay24Callback = async (req, res) => {
  try {
    const {
      event,
      transaction_id,
      transaction_ref,
      merchant_order_id,
      amount,
      utr_number,
      status,
      approved_at,
      expired_at,
    } = req.body;

    console.log("🔔 TrustPay24 Webhook:", req.body);

    // Validate common webhook fields
    if (!event || !transaction_ref || !merchant_order_id || !status) {
      console.error("❌ TrustPay24 Callback: Invalid payload");

      // Always return 200 so the provider doesn't repeatedly retry
      return res.status(200).json({
        success: false,
        message: "Invalid payload",
      });
    }

    // Find our order using TrustPay24 transaction_ref
    let order = await Order.findOne({
      orderid: String(transaction_ref),
    });

    if (!order) {
      order = await Order.findOne({
        orderid: String(merchant_order_id),
      });
    }

    if (!order) {
      console.error(
        "❌ TrustPay24 Callback: Order not found:",
        transaction_ref
      );

      return res.status(200).json({
        success: false,
        message: "Order not found",
      });
    }

    // Handle approved payment
    if (event === "payin.approved") {
      if (String(status).toLowerCase() !== "approved") {
        return res.status(200).json({
          success: false,
          message: "Invalid approved status",
        });
      }

      // Prevent duplicate webhook processing
      if (String(order.status).toUpperCase() === "SUCCESS") {
        console.log(
          "ℹ️ TrustPay24 Callback: Order already processed:",
          transaction_ref
        );

        return res.status(200).json({
          success: true,
          message: "Already processed",
        });
      }

      // If your Order schema has these fields, save them
      order.utrNumber = utr_number || null;
      order.transactionId = transaction_id || null;
      order.transactionRef = transaction_ref || null;
      order.approvedAt = approved_at
        ? new Date(approved_at)
        : new Date();

      await order.save();

      console.log(
        "✅ TrustPay24 Deposit Approved:",
        transaction_ref,
        "Amount:",
        amount,
        "UTR:",
        utr_number
      );
      const accountno = order.accountNo;
      const usdRate = await fetchRate();
      const amountUSD = (parseFloat(amount) * usdRate).toFixed(2);

      try {
        const mt5Response = await updateMT5Balance({
          login: accountno,
          type: 2,
          balance: amountUSD,
          comment: `DEP-${order.orderid}`.substring(0, 31), // MT5 comments max 31 chars
        });

        console.log("MT5 Response:", mt5Response);

        // --------------------------------------------
        // Validate MT5 response
        // --------------------------------------------
        const retCode = String(mt5Response.retcode);

        if (!retCode.startsWith("0") && retCode !== "0 Done") {
          throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
        }

        order.status = "SUCCESS";
        await order.save();
        console.log(`Deposit successful! Ticket ID: ${mt5Response.ticket}`);

      } catch (error) {
        console.error("MT5 Operation Failed:", error);
        throw new Error(
          `MT5 Deposit Failed: ${mt5Response.data.retcode}`
        );
      }

      return res.status(200).json({
        success: true,
        message: "Webhook processed successfully",
      });
    }

    // Handle expired payment
    if (event === "payin.expired") {
      if (String(status).toLowerCase() !== "expired") {
        return res.status(200).json({
          success: false,
          message: "Invalid expired status",
        });
      }

      // Don't overwrite a successfully completed order
      if (String(order.status).toUpperCase() === "SUCCESS") {
        console.log(
          "⚠️ TrustPay24 Callback: Order already successful:",
          transaction_ref
        );

        return res.status(200).json({
          success: true,
          message: "Order already successful",
        });
      }

      order.status = "EXPIRED";

      if (transaction_id) {
        order.transactionId = transaction_id;
      }

      if (transaction_ref) {
        order.transactionRef = transaction_ref;
      }

      if (expired_at) {
        order.expiredAt = new Date(expired_at);
      }

      await order.save();

      console.log(
        "⏱️ TrustPay24 Deposit Expired:",
        transaction_ref
      );

      return res.status(200).json({
        success: true,
        message: "Expired webhook processed successfully",
      });
    }

    // Unknown event
    console.error(
      "❌ TrustPay24 Callback: Unknown event:",
      event
    );

    return res.status(200).json({
      success: false,
      message: "Unknown event",
    });
  } catch (error) {
    console.error(
      "❌ TrustPay24 Callback Error:",
      error.response?.data || error.message
    );

    // Provider expects HTTP 200 acknowledgement
    return res.status(200).json({
      success: false,
      message: "Server error",
    });
  }
};
