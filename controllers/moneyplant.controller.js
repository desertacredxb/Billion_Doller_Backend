const axios = require("axios");
const Account = require("../models/account.model");
const User = require("../models/User");

exports.registerUserWithMoneyPlant = async (req, res) => {
  const { email, curr, actype, Utype, Ref, Password } = req.body;

  try {
    // 1. Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Call external API
    const { data } = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPReguser",
      req.body,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // 3. If success, save account to MongoDB with user reference
    if (data.response === "success") {
      const newAccount = new Account({
        user: user._id, // ✅ associate with user
        accountNo: data.accountno,
        currency: curr,
        accountType: actype,
        userType: Utype,
        referralCode: Ref || "",
        moneyPlantPassword: Password,
      });

      await newAccount.save();

      res.status(200).json({
        message: "Account successfully created",
        accountNo: data.accountno,
      });
    } else {
      res.status(400).json({ message: data.message || "Registration failed" });
    }
  } catch (error) {
    console.error("MoneyPlant API error:", error.message);
    res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

exports.getAccountSummary = async (req, res) => {
  const { accountno } = req.body; // Must come from body

  if (!accountno) {
    return res
      .status(400)
      .json({ success: false, message: "accountno is required" });
  }

  try {
    const { data } = await axios({
      method: "post",
      url: "https://api.moneyplantfx.com/WSMoneyplant.aspx",
      params: {
        type: "SNDPCheckBalance",
      },
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        accountno,
      },
    });

    if (data.response === "failed") {
      return res.status(400).json({
        success: false,
        message: data.message || "Failed to fetch account data",
      });
    }

    return res.status(200).json({
      data,
    });
  } catch (error) {
    console.error("MoneyPlant API error:", error.message);
    res.status(500).json({
      success: false,
      message: "Something went wrong while fetching account summary.",
    });
  }
};

exports.updatePassword = async (req, res) => {
  const { accountno, newpassword } = req.body;

  try {
    const response = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPChangePassword", // replace with actual URL
      {
        accountno,
        newpassword,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const { response: status, message } = response.data;

    if (status === "success") {
      return res.status(200).json({ success: true, message });
    } else {
      return res.status(400).json({ success: false, message });
    }
  } catch (error) {
    console.error("Error updating password:", error.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }
};

exports.addBalance = async (req, res) => {
  const { accountno, amount, orderid } = req.body;

  if (!accountno || !amount || !orderid) {
    return res.status(400).json({
      success: false,
      message: "accountno, amount, and orderid are required",
    });
  }

  if (orderid.length > 16) {
    return res.status(400).json({
      success: false,
      message: "orderid must be 16 characters or fewer",
    });
  }

  try {
    const response = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
      {
        accountno,
        amount,
        orderid,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const { response: status, message } = response.data;

    if (status === "success") {
      return res.status(200).json({ success: true, message });
    } else {
      return res.status(400).json({ success: false, message });
    }
  } catch (error) {
    console.error("Add balance error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }
};
