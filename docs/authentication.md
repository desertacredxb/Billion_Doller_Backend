# Application access

Client requests send the existing login/registration JWT as a Bearer token. Both legacy `id` and registration `userId` claims remain supported. Private routers resolve the current verified user, then check profile, trading-account, or ticket ownership. Administrative lists and mutations require an administrator session. Provider callbacks retain their independent provider-facing URLs.

Administrator access uses `/admin-login` on the frontend. `ADMIN_EMAILS` is a comma-separated server-side allowlist. For the existing installation, `ADMIN_OTP_TO_SMTP_USER=true` delivers sign-in codes to the service's existing `EMAIL_USER` mailbox. Otherwise, codes are sent to the allowlisted sign-in address. No administrator credential is embedded in the browser bundle.

First sign-in verifies the emailed code and creates a password of at least 12 characters. Later sign-ins require the password and a fresh code. Recovery also requires the emailed code. Codes expire after five minutes, permit five verification attempts, and are consumed once. Administrator tokens expire after two hours and are checked against the current session version in the database. Signing in again or recovering the password invalidates previous administrator sessions.

The IB referral report returns only clients attributed to the signed-in approved IB, including limited registration and account metadata. The browser cannot request the global users list or individual referred clients' private profiles. Client-side commission recalculation no longer writes ledger balances. Client commission transfers use the existing atomic MT5 reservation endpoint; the legacy MoneyPlant transfer and ledger mutation endpoints require administrator access.

Verification: `npm test`. Tests run without production credentials or payment/identity-provider calls and cover access boundaries, administrator enrollment, OTP expiry/attempts/replay, recovery, response field filtering, and the existing Veriff and automatic IB approval rules.
