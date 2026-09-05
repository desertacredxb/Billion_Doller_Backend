const axios = require("axios");
const https = require("https");

const Account = require("../models/account.model");
const User = require("../models/User");

// const { withSession } = require("../utils/mt5Session");
const MT5Request = require("../utils/mt5Request");
const { sendMT5AccountCreatedEmail } = require("../utils/Email");

// const mt5 = new MT5Request(process.env.MT5_SERVER, 443); // e.g. 86.104.251.229

// function authenticateMT5() {
//   return new Promise((resolve, reject) => {
//     mt5.Auth(
//       process.env.MT5_MANAGER_LOGIN,
//       process.env.MT5_MANAGER_PASSWORD,
//       process.env.MT5_BUILD,     // e.g. 4530
//       "BigWigMT5Backend",
//       (error) => error ? reject(error) : resolve()
//     );
//   });
// }


/**
 * Reusable MT5 Error Formatting Helper
 */
function handleMT5Error(error, res, defaultCode) {
  if (error?.code === "ETIMEDOUT") {
    return res.status(504).json({
      success: false,
      code: "MT5_CONNECTION_TIMEOUT",
      message: "Unable to connect to the MT5 server. Please try again later.",
    });
  }

  if (error?.code === "ECONNREFUSED") {
    return res.status(503).json({
      success: false,
      code: "MT5_CONNECTION_REFUSED",
      message: "MT5 server is currently unavailable. Please try again later.",
    });
  }

  if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") {
    return res.status(503).json({
      success: false,
      code: "MT5_SERVER_NOT_FOUND",
      message: "MT5 server could not be reached. Please try again later.",
    });
  }

  const errorMessage = typeof error === "string" ? error : error?.message || "";

  if (/^\d+/.test(errorMessage)) {
    const code = parseInt(errorMessage, 10);
    const knownMessages = {
      1: "Authorization failed or invalid manager session",
      8: "Permission denied or MT5 group does not exist",
      3001: "User account not found",
      3002: "No available MT5 account numbers",
      3003: "Invalid trade server",
      3004: "Account already exists",
      3006: "Password complexity requirement failed",
    };

    return res.status(400).json({
      success: false,
      code: `MT5_${code}`,
      message: knownMessages[code] || errorMessage,
    });
  }

  return res.status(500).json({
    success: false,
    code: defaultCode,
    message: "Unable to complete MT5 operation. Please try again.",
  });
}


let mt5Lock = Promise.resolve();
function runExclusive(fn) {
  const result = mt5Lock.then(fn, fn);
  mt5Lock = result.catch(() => { });
  return result;
}

exports.registerUserWithMT5 = async (req, res) => {
  const { email, curr, actype, Utype, Ref, Password } = req.body;
  console.log(req.body)
  console.log("REGISTER HIT", new Date().toISOString(), email);

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const investorPassword = `${Password}#Inv`;
    const mt5Params = {
      // login: "333385081",
      // group: "demo\\demoforex", //demo.FOREX/15
      group: process.env.MT5_GROUP, //demo.FOREX/15 //Forex\\BDFX
      name: user.fullName.substring(0, 127),
      country: user.nationality || "",
      phone: req.mobile || user.phone,
      email: user.email,
      leverage: 100,
      pass_main: Password,
      pass_investor: investorPassword,
    };

    const mt5Data = await runExclusive(async () => {
      const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);

      console.log(process.env.MT5_MANAGER_LOGIN,
        process.env.MT5_MANAGER_PASSWORD,
        process.env.MT5_BUILD,);

      await new Promise((resolve, reject) => {
        mt5.Auth(
          process.env.MT5_MANAGER_LOGIN,
          process.env.MT5_MANAGER_PASSWORD,
          process.env.MT5_BUILD,
          "WebManager",
          (error) => (error ? reject(error) : resolve())
        );
      });

      return new Promise((resolve, reject) => {
        mt5.UserAdd(mt5Params, (error, answer) => {
          if (error) return reject(error);
          resolve(answer);
        });
      });
    });

    const accountNo = mt5Data.Login || mt5Data.answer?.Login;
    const newAccount = new Account({
      user: user._id,
      accountNo,
      currency: curr,
      accountType: actype,
      userType: Utype,
      referralCode: Ref || "",
      mt5Password: Password,
      mt5InvestorPassword: investorPassword,
    });
    // console.log("newAccount", newAccount);
    await newAccount.save();

    try {
      await sendMT5AccountCreatedEmail({
        email: user.email,
        name: user.fullName,
        accountNo,
        currency: curr,
        accountType: actype,
        userType: Utype,
        mt5Password: Password,
        mt5InvestorPassword: investorPassword,
      });
    } catch (emailError) {
      // Don't fail account creation because email failed
      console.error(
        "⚠️ MT5 account created, but account email failed:",
        emailError
      );
    }

    return res.status(200).json({ message: "Account successfully created", accountNo });
  } catch (error) {
    console.error("Error during MT5 registration:", error);

    // -----------------------------------------
    // MT5 CONNECTION TIMEOUT
    // -----------------------------------------
    if (error?.code === "ETIMEDOUT") {
      return res.status(504).json({
        success: false,
        code: "MT5_CONNECTION_TIMEOUT",
        message:
          "Unable to connect to the MT5 server. Please try again later.",
      });
    }

    // -----------------------------------------
    // MT5 CONNECTION REFUSED
    // -----------------------------------------
    if (error?.code === "ECONNREFUSED") {
      return res.status(503).json({
        success: false,
        code: "MT5_CONNECTION_REFUSED",
        message:
          "MT5 server is currently unavailable. Please try again later.",
      });
    }

    // -----------------------------------------
    // MT5 HOST NOT FOUND
    // -----------------------------------------
    if (
      error?.code === "ENOTFOUND" ||
      error?.code === "EAI_AGAIN"
    ) {
      return res.status(503).json({
        success: false,
        code: "MT5_SERVER_NOT_FOUND",
        message:
          "MT5 server could not be reached. Please try again later.",
      });
    }

    // -----------------------------------------
    // MT5 RETCODE ERRORS
    // -----------------------------------------
    const errorMessage =
      typeof error === "string"
        ? error
        : error?.message || "";

    if (/^\d+/.test(errorMessage)) {
      const code = parseInt(errorMessage, 10);

      const knownMessages = {
        3002: "No available MT5 account numbers",
        3003: "Invalid trade server",
        3004: "Account already exists",
        3006: "Password complexity requirement failed",
        8: "Permission denied or MT5 group does not exist",
      };

      return res.status(400).json({
        success: false,
        code: `MT5_${code}`,
        message: knownMessages[code] || errorMessage,
      });
    }
  }

  // -----------------------------------------
  // GENERIC ERROR
  // -----------------------------------------
  return res.status(500).json({
    success: false,
    code: "MT5_REGISTRATION_FAILED",
    message: "Unable to create MT5 account. Please try again.",
  });
};

exports.getMT5User = async (req, res) => {
  const { login } = req.query;

  if (!login) {
    return res.status(400).json({
      success: false,
      message: "MT5 login query parameter is required",
    });
  }

  try {
    const userData = await runExclusive(async () => {
      const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);

      // 1. Authenticate connection
      await new Promise((resolve, reject) => {
        mt5.Auth(
          process.env.MT5_MANAGER_LOGIN,
          process.env.MT5_MANAGER_PASSWORD,
          process.env.MT5_BUILD,
          "WebManager",
          (error) => (error ? reject(error) : resolve())
        );
      });

      // 2. Fetch User Info
      return new Promise((resolve, reject) => {
        mt5.UserGet(login, (error, answer) => {
          if (error) return reject(error);
          resolve(answer);
        });
      });
    });

    // Handle return format (answer container vs direct object)
    const userDetails = userData.answer || userData;

    console.log("userDetails", userDetails)

    return res.status(200).json({
      success: true,
      data: userDetails,
    });
  } catch (error) {
    console.error("Error fetching MT5 user:", error);
    return handleMT5Error(error, res, "MT5_GET_USER_FAILED");
  }
};

/**
 * Change MT5 Account Password (Main, Investor, or API)
 */
exports.changeMT5Password = async (req, res) => {
  const { login, type, password, mainPassword, investorPassword } = req.body;

  if (!login || !type) {
    return res.status(400).json({
      success: false,
      message: "login and type are required fields.",
    });
  }

  try {
    let targetMainPassword = null;
    let targetInvestorPassword = null;

    if (type === "both") {
      targetMainPassword = mainPassword;
      targetInvestorPassword = investorPassword;
    } else if (type === "main") {
      targetMainPassword = password;
    } else if (type === "investor") {
      targetInvestorPassword = password;
    }

    await runExclusive(async () => {
      const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);

      // Authenticate MT5 Session
      await new Promise((resolve, reject) => {
        mt5.Auth(
          process.env.MT5_MANAGER_LOGIN,
          process.env.MT5_MANAGER_PASSWORD,
          process.env.MT5_BUILD,
          "WebManager",
          (error) => (error ? reject(error) : resolve())
        );
      });

      // 1. Update Main Password if provided
      if (targetMainPassword) {
        await new Promise((resolve, reject) => {
          mt5.UserPasswordChange(
            { login, type: "main", password: targetMainPassword },
            (error, answer) => (error ? reject(error) : resolve(answer))
          );
        });
      }

      // 2. Update Investor Password if provided
      if (targetInvestorPassword) {
        await new Promise((resolve, reject) => {
          mt5.UserPasswordChange(
            { login, type: "investor", password: targetInvestorPassword },
            (error, answer) => (error ? reject(error) : resolve(answer))
          );
        });
      }
    });

    // Update MongoDB record
    const updatePayload = {};
    if (targetMainPassword) updatePayload.mt5Password = targetMainPassword;
    if (targetInvestorPassword) updatePayload.mt5InvestorPassword = targetInvestorPassword;

    await Account.findOneAndUpdate({ accountNo: login }, updatePayload);

    return res.status(200).json({
      success: true,
      message: `Password (${type}) updated successfully`,
    });
  } catch (error) {
    console.error("Error updating MT5 password:", error);
    return handleMT5Error(error, res, "MT5_PASSWORD_UPDATE_FAILED");
  }
};
