const sendEmail = require("./sendEmail");

/**
 * Send notification when a new MT5 account is successfully created
 */
const sendMT5AccountCreatedEmail = async ({
  email,
  name,
  accountNo,
  currency,
  accountType,
  userType,
  mt5Password,
  mt5InvestorPassword,
}) => {
  await sendEmail({
    to: email,
    subject: "✅ Your Billion Dollar FX Trading Account Has Been Created",
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: auto;">

        <h2 style="color: #f39c12;">
          MT5 Trading Account Created Successfully
        </h2>

        <p>
          Dear <strong>${name}</strong>,
        </p>

        <p>
          Your Billion Dollar FX trading account has been successfully created.
          You can now use the following credentials to access your MT5 trading account.
        </p>

        <div style="
          background: #f8f8f8;
          padding: 20px;
          border-radius: 8px;
          margin: 20px 0;
        ">
          <h3 style="margin-top: 0; color: #f39c12;">
            Account Details
          </h3>

          <p>
            <strong>Account Number:</strong> ${accountNo}
          </p>

          <p>
            <strong>Currency:</strong> ${currency}
          </p>

          <p>
            <strong>Account Type:</strong> ${accountType}
          </p>

          <p>
            <strong>User Type:</strong> ${userType}
          </p>
        </div>

        <div style="
          background: #fff8e7;
          border-left: 4px solid #f39c12;
          padding: 15px;
          margin: 20px 0;
        ">
          <h3 style="margin-top: 0; color: #f39c12;">
            MT5 Login Credentials
          </h3>

          <p>
            <strong>Login:</strong> ${accountNo}
          </p>

          <p>
            <strong>Password:</strong> ${mt5Password}
          </p>

          <p>
            <strong>Investor Password:</strong> ${mt5InvestorPassword}
          </p>
        </div>

        <p>
          Please keep your trading credentials secure and do not share your
          password with anyone.
        </p>

        <p>
          You can now log in to the MT5 platform using your account number
          and password.
        </p>

        <br />

        <p>
          Regards,<br />
          <strong>Billion Dollar FX System</strong>
        </p>

      </div>
    `,
  });
};

module.exports = {
  sendMT5AccountCreatedEmail,
};
