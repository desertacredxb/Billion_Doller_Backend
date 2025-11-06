// middlewares/checkMargin.js
const axios = require("axios");

/**
 * Middleware to check user's MoneyPlant margin before allowing withdrawal
 */
const checkMargin = async (req, res, next) => {
  try {
    const { accountNo } = req.body;

    if (!accountNo) {
      return res
        .status(400)
        .json({ success: false, message: "accountNo is required" });
    }

    // 🔹 Step 1: Call MoneyPlant API to fetch balance
    const { data } = await axios({
      method: "post",
      url: "https://api.moneyplantfx.com/WSMoneyplant.aspx",
      params: {
        type: "SNDPCheckBalance",
      },
      headers: {
        "Content-Type": "application/json",
      },
      data: { accountno: accountNo },
    });

    if (data.response === "failed") {
      return res.status(400).json({
        success: false,
        message: data.message || "Failed to fetch account data",
      });
    }

    // 🔹 Step 2: Check margin
    const margin = parseFloat(data.Margin || "0");

    if (margin > 0) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal not allowed while you have open trades.",
      });
    }

    // ✅ Step 3: Attach balance info to req for later use (optional)
    req.accountSummary = data;

    // Continue to next middleware or controller
    next();
  } catch (error) {
    console.error("checkMargin Middleware Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error verifying margin balance with MoneyPlant API.",
    });
  }
};

module.exports = checkMargin;
