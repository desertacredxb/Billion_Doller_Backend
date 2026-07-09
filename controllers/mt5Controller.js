const axios = require("axios");
const https = require("https");

const Account = require("../models/account.model");
const User = require("../models/User");


exports.registerUserWithMT5 = async (req, res) => {
  const { email, curr, actype, Utype, Ref, Password } = req.body;

  console.log("Received MT5 registration request:", req.body);

  try {
    // Find user
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // MT5 Query Parameters
    const mt5Query = new URLSearchParams({
      login: "0", // Auto allocate login
      group: "demoforex",
      name: user.fullName.substring(0, 127),
      country: user.nationality || "",
      city: user.city || "",
      state: user.state || "",
      phone: user.phone || "",
      email: user.email,
      leverage: "100",
    });

    // MT5 Body Payload
    const mt5Payload = {
      PassMain: Password,
      PassInvestor: Password
        ? `${Password.substring(0, Math.min(10, Password.length))}#Inv1`
        : "Abcd@1234",
    };

    // Create MT5 User
    const mt5Res = await axios.post(
  `${process.env.MT5_WEB_API_URL}/api/user/add?${mt5Query.toString()}`,
  mt5Payload,
  {
    headers: {
      "Content-Type": "application/json",
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
  }
);

    const mt5Data = mt5Res.data;

    console.log("MT5 Response:", mt5Data);

    // Success
    if (
      mt5Data.retcode === "0 Done" ||
      mt5Data.retcode === 0
    ) {
      const accountNo =
        mt5Data.answer?.Login ||
        mt5Data.Login;

      const newAccount = new Account({
        user: user._id,
        accountNo,
        currency: curr,
        accountType: actype,
        userType: Utype,
        referralCode: Ref || "",
        mt5Password: Password, // keep existing field if schema unchanged
      });

      await newAccount.save();

      return res.status(200).json({
        message: "Account successfully created",
        accountNo,
      });
    }

    // MT5 Error Handling
    let reason = mt5Data.retcode;

    if (Number(mt5Data.retcode) === 3002) {
      reason = "No available MT5 account numbers";
    } else if (Number(mt5Data.retcode) === 3003) {
      reason = "Invalid trade server";
    } else if (Number(mt5Data.retcode) === 3004) {
      reason = "Account already exists";
    } else if (Number(mt5Data.retcode) === 3006) {
      reason = "Password complexity requirement failed";
    } else if (Number(mt5Data.retcode) === 8) {
      reason = "Permission denied or group does not exist";
    }

    return res.status(400).json({
      message: reason,
      mt5Response: mt5Data,
    });
  } catch (error) {
    console.error("Error during MT5 registration:", error);
    console.error(
      "MT5 API error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      message: "Internal Server Error",
      error: error.response?.data || error.message,
    });
  }
};