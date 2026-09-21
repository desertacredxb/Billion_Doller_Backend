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
  leverage,
  server = "AscendsGlobalMarkets",
}) => {
  const row = (label, value, mono = false) => `
    <tr>
      <td style="padding: 6px 0; font-size: 13px; color: #8a8a8a; width: 40%;">${label}</td>
      <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; font-weight: 600; ${mono ? "font-family: 'Courier New', Consolas, monospace; letter-spacing: 0.3px;" : ""
    }">${value}</td>
    </tr>`;

  await sendEmail({
    to: email,
    subject: "Welcome to Billion Dollar FX - Your MT5 Account Details",
    html: `
<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background-color: #f2f2f5; font-family: Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f2f2f5; padding: 32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 10px; overflow: hidden; border: 1px solid #eceef1;">

            <!-- Header -->
            <tr>
              <td style="background-color: #0A1A25; padding: 28px 32px;">
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
                  BILLION <span style="color: #927948;">DOLLAR</span> FX
                </span>
              </td>
            </tr>

            <!-- Banner -->
            <tr>
              <td style="background-color: #927948; padding: 14px 32px;">
                <span style="font-size: 14px; font-weight: 700; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">
                  MT5 Account Created Successfully
                </span>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding: 32px; color: #333333; font-size: 14px; line-height: 1.6;">
                <p style="margin: 0 0 16px;">Dear <strong>${name}</strong>,</p>
                <p style="margin: 0 0 24px;">
                  Welcome to Billion Dollar FX. Your MT5 trading account has been
                  successfully created. Please find your account details below.
                </p>

                <!-- Credentials card -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f3ea; border: 1px solid #d9c8a5; border-radius: 8px; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 18px 20px 6px;">
                      <span style="font-size: 12px; font-weight: 700; color: #6b5330; text-transform: uppercase; letter-spacing: 0.5px;">
                        MT5 Login Credentials
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 4px 20px 18px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${row("Login ID", accountNo, true)}
                        ${row("Password", mt5Password, true)}
                        ${row("Investor Password", mt5InvestorPassword, true)}
                        ${row("Server", server, true)}
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Account details card -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f8fa; border-radius: 8px; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 18px 20px 6px;">
                      <span style="font-size: 12px; font-weight: 700; color: #6b6b6b; text-transform: uppercase; letter-spacing: 0.5px;">
                        Account Details
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 4px 20px 18px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${row("Leverage", leverage ? `1:${leverage}` : "-")}
                        ${row("Currency", currency)}
                      </table>
                    </td>
                  </tr>
                </table>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; width: 100%;">
                  <tr>
                    <td style="background-color: #fdecea; border-left: 3px solid #e74c3c; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #a83228;">
                      Keep your login credentials confidential. Never share your password
                      or investor password with anyone, including anyone claiming to be
                      from our support team.
                    </td>
                  </tr>
                </table>

                <p style="margin: 0 0 12px; font-size: 15px; font-weight: 700; color: #0A1A25;">
                  How to Log In
                </p>
                <ol style="margin: 0 0 24px; padding-left: 20px; color: #333333;">
                  <li style="margin-bottom: 6px;">Download and install MetaTrader 5.</li>
                  <li style="margin-bottom: 6px;">Open the application and select <strong>Login to an Existing Account</strong>.</li>
                  <li style="margin-bottom: 6px;">Search for <strong>${server}</strong>.</li>
                  <li style="margin-bottom: 6px;">Enter your MT5 Login ID and Password.</li>
                  <li style="margin-bottom: 6px;">Select the appropriate server and log in to your account.</li>
                </ol>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                  <tr>
                    <td style="border-radius: 6px; background-color: #927948;">
                      <a href="https://www.metatrader5.com/en/download" target="_blank" style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none;">
                        Download MetaTrader 5
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin: 0 0 8px;">
                  Once logged in, you can access the available trading instruments
                  and monitor your account directly through the MT5 platform.
                </p>
                <p style="margin: 0 0 8px;">
                  If you require any assistance with your account or platform setup,
                  please contact our support team at
                  <a href="mailto:info@billiondollarfx.com" style="color: #927948; text-decoration: none;">info@billiondollarfx.com</a>
                  or WhatsApp us at +971 509818742 / +447593611999.
                </p>
                <p style="margin: 20px 0 0;">
                  We wish you a successful trading journey with Billion Dollar FX.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #0A1A25; padding: 24px 32px; text-align: center;">
                <p style="margin: 0 0 6px; font-size: 13px; color: #ffffff; font-weight: 700;">Billion Dollar FX</p>
                <p style="margin: 0 0 10px; font-size: 12px; color: #9a9aa5;">Client Support Team</p>
                <p style="margin: 0; font-size: 12px; color: #9a9aa5;">
                  <a href="https://billiondollarfx.com" style="color: #927948; text-decoration: none;">billiondollarfx.com</a>
                  &nbsp;|&nbsp;
                  <a href="mailto:info@billiondollarfx.com" style="color: #927948; text-decoration: none;">info@billiondollarfx.com</a>
                  &nbsp;|&nbsp;
                  +447593611999
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `,
  });
};

/**
 * Send OTP for password reset requests
 */
const sendPasswordResetOtpEmail = async ({ email, name, otp }) => {
  await sendEmail({
    to: email,
    subject: "Password Reset Request - OTP Code",
    html: `
<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background-color: #f2f2f5; font-family: Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f2f2f5; padding: 32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 10px; overflow: hidden; border: 1px solid #eceef1;">

            <!-- Header -->
            <tr>
              <td style="background-color: #0A1A25; padding: 28px 32px;">
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px;">
                  BILLION <span style="color: #927948;">DOLLAR</span> FX
                </span>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding: 32px; color: #333333; font-size: 14px; line-height: 1.6;">
                <p style="margin: 0 0 16px;">Dear <strong>${name || "User"}</strong>,</p>
                <p style="margin: 0 0 20px;">
                  We received a request to reset your account password. Use the
                  One-Time Password (OTP) below to proceed:
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f3ea; border: 1px solid #d9c8a5; border-radius: 8px; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 20px; text-align: center;">
                      <span style="font-size: 28px; font-weight: 700; color: #0A1A25; letter-spacing: 6px; font-family: 'Courier New', Consolas, monospace;">
                        ${otp}
                      </span>
                    </td>
                  </tr>
                </table>

                <p style="margin: 0 0 16px;">
                  This OTP is valid for <strong>5 minutes</strong>. Do not share
                  this code with anyone.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%;">
                  <tr>
                    <td style="background-color: #fdecea; border-left: 3px solid #e74c3c; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #a83228;">
                      If you did not request a password reset, please ignore this
                      email — your account remains secure.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #0A1A25; padding: 24px 32px; text-align: center;">
                <p style="margin: 0 0 6px; font-size: 13px; color: #ffffff; font-weight: 700;">Billion Dollar FX</p>
                <p style="margin: 0 0 10px; font-size: 12px; color: #9a9aa5;">Client Support Team</p>
                <p style="margin: 0; font-size: 12px; color: #9a9aa5;">
                  <a href="https://billiondollarfx.com" style="color: #927948; text-decoration: none;">billiondollarfx.com</a>
                  &nbsp;|&nbsp;
                  <a href="mailto:info@billiondollarfx.com" style="color: #927948; text-decoration: none;">info@billiondollarfx.com</a>
                  &nbsp;|&nbsp;
                  +971 509818742 / +447593611999
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `,
  });
};

module.exports = {
  sendMT5AccountCreatedEmail,
  sendPasswordResetOtpEmail,
};
