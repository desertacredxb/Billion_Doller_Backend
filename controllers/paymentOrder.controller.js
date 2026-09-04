const axios = require("axios");
const Order = require("../models/Order");
const Account = require("../models/account.model");
const crypto = require("crypto");

const generateCregisSignature = (params) => {
  const sortedString = Object.keys(params)
    .filter(
      (key) =>
        key !== "sign" &&
        params[key] !== undefined &&
        params[key] !== null &&
        params[key] !== ""
    )
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  return crypto
    .createHash("md5")
    .update(`${process.env.CREGIS_DEPOSIT_API_KEY}${sortedString}`)
    .digest("hex")
    .toLowerCase();
};

exports.createCregisCheckout = async (req, res) => {
  try {
    const { accountNo, amount } = req.body;

    console.log("Cregis deposit request:", accountNo, amount);

    const numericAmount = Number(amount);

    // Validate request
    if (
      !accountNo ||
      !Number.isFinite(numericAmount) ||
      numericAmount < 1000
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A valid account number and minimum amount of 1000 are required",
      });
    }

    // Validate Cregis configuration
    if (!process.env.CREGIS_DEPOSIT_API_KEY || !process.env.CREGIS_DEPOSIT_PID) {
      console.error("Cregis deposit: CREGIS credentials are not configured");

      return res.status(503).json({
        success: false,
        message: "Cregis is not configured",
      });
    }

    // Find account
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

    // Generate unique merchant order ID
    const merchantOrderId = `ORD${Date.now()}${Math.floor(
      Math.random() * 1000
    )}`;

    // Cregis requires a 6-character nonce
    const nonce = crypto
      .randomBytes(4)
      .toString("hex")
      .slice(0, 6);

    // 13-digit timestamp
    const timestamp = Date.now();

    /*
     * IMPORTANT:
     *
     * order_currency must be the currency you want the
     * Cregis order to be denominated in.
     *
     * Change USD to your actual configured currency if required.
     */
    const payload = {
      nonce,
      pid: Number(process.env.CREGIS_DEPOSIT_PID),
      timestamp,

      order_amount: numericAmount.toFixed(2),
      order_currency: "USD",

      order_id: merchantOrderId,

      payer_id: String(account.accountNo),

      payer_email:
        account.user?.email ||
        `account-${account.accountNo}@example.com`,

      payer_name:
        account.user?.fullName ||
        String(account.accountNo),

      valid_time: 30,

      callback_url: "https://billion-doller-backend.onrender.com/api/payment/cregis/callback",

      success_url: "https://www.billiondollarfx.com/transactions",

      cancel_url: "https://www.billiondollarfx.com/transactions",

      language: "en",

      remark: `Deposit for account ${account.accountNo}`,

      /*
       * Optional:
       *
       * Restrict payment currencies here.
       *
       * Example:
       * tokens: "USDT-TRC20"
       *
       * Leave empty if all supported tokens should be accepted.
       */
      // tokens: "USDT-TRC20",

      accept_partial_payment: "false",
      accept_over_payment: "false",
    };

    // Generate Cregis signature
    payload.sign = generateCregisSignature(payload);

    console.log("Cregis checkout request:", {
      ...payload,
      sign: "[HIDDEN]",
    });

    // Create Cregis checkout
    const { data } = await axios.post(
      `https://t-jcgfykxv.cregis.io/api/v2/checkout`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log("Cregis response:", data);

    // Validate Cregis response
    if (
      data?.code !== "00000" ||
      !data?.data?.cregis_id ||
      !data?.data?.checkout_url
    ) {
      console.error(
        "Cregis checkout rejected:",
        data?.msg || data
      );

      if (data?.code === "E0001") {
        return res.status(400).json({
          success: false,
          message:
            "Cregis rejected the checkout request",
        });
      }

      return res.status(502).json({
        success: false,
        message:
          data?.msg ||
          "Cregis did not create the checkout",
      });
    } 

    const cregisOrder = data.data;

    // Save order in database
    const order = await Order.create({
      orderid: merchantOrderId,

      account: account._id,
      accountNo: String(account.accountNo),

      amount: numericAmount,

      status: "PENDING",

      // Recommended provider information
      provider: "CREGIS",

      providerOrderId: String(cregisOrder.cregis_id),
    });

    return res.json({
      success: true,
      message: "Cregis checkout created successfully",

      // Internal order
      order_id: order.orderid,

      // Cregis order
      cregis_id: cregisOrder.cregis_id,

      checkout_url: cregisOrder.checkout_url,

      order_amount: cregisOrder.order_amount,

      order_currency: cregisOrder.order_currency,

      created_time: cregisOrder.created_time,

      expire_time: cregisOrder.expire_time,

      payment_info: cregisOrder.payment_info || [],
    });
  } catch (err) {
    console.log("Cregis deposit error:", err.response?.data || err.message);
    console.error(
      "Cregis deposit error:",
      err.response?.data || err.message
    );

    return res.status(502).json({
      success: false,
      message:
        err.response?.data?.msg ||
        "Unable to create Cregis deposit",
    });
  }
}