# Application access

Client requests send the existing login/registration JWT as a Bearer token. Both legacy `id` and registration `userId` claims remain supported. Private routers resolve the current verified user, then check profile, trading-account, or ticket ownership. Administrative lists and mutations require an administrator session. Provider callbacks retain their independent provider-facing URLs.

Administrator access uses `/admin-login` (the legacy `/admin` address redirects there). `ADMIN_OWNER_EMAILS`, falling back to `ADMIN_EMAILS`, is a comma-separated owner allowlist managed in server configuration. Codes are always sent to the account's own email address; the previous SMTP-mailbox override is no longer used. No administrator credential is embedded in the browser bundle.

An authenticated owner can add managers through **Staff Users**. Each manager uses their own email, verifies it and sets their own password at first sign-in. Adding a manager does not send an unsolicited invitation. Select explicit permissions for clients/KYC, IB partners, finance, tickets, enquiries, blog publishing and reports. Managers cannot create other administrators, assign themselves an owner role or read the owner-only activity log. Owner accounts cannot be disabled or changed through manager administration.

For an explicitly authorized initial administrator, `ADMIN_BOOTSTRAP_MANAGERS` accepts a comma-separated email list. Startup creates missing manager records with operational permissions and links them to the configured owner. It creates no passwords and sends no messages. Existing accounts are left unchanged, so disabling a bootstrapped manager persists across restarts. New bootstrap records are recorded in activity history.

Permissions, enabled status and session versions are checked against the database on every protected request. Editing manager permissions or disabling an account increments the session version and consumes outstanding sign-in challenges, revoking access immediately. UI navigation is filtered for convenience; it does not authorize backend access.

Activity history records administrator sign-ins and the outcome of administrator mutation requests from deployment onwards. It stores the actor, route template, changed field names, applicable record ID and status. It excludes request bodies, passwords, OTPs, tokens, query strings and financial account values. This is a request audit, not a before/after financial ledger or a record of earlier historical changes. Records have no public deletion endpoint.

First sign-in verifies the emailed code and creates a password of at least 12 characters. Later sign-ins require the password and a fresh code. Recovery also requires the emailed code. Codes expire after five minutes, permit five verification attempts, and are consumed once. Administrator tokens expire after two hours and are checked against the current session version in the database. Signing in again or recovering the password invalidates previous administrator sessions.

The IB referral report returns only clients attributed to the signed-in approved IB, including limited registration and account metadata. The browser cannot request the global users list or individual referred clients' private profiles. Client-side commission recalculation no longer writes ledger balances. Client commission transfers use the existing atomic MT5 reservation endpoint; the legacy MoneyPlant transfer and ledger mutation endpoints require administrator access.

Verification: `npm test`. Tests run without production credentials or payment/identity-provider calls and cover access boundaries, administrator enrollment, OTP expiry/attempts/replay, recovery, response field filtering, and the existing Veriff and automatic IB approval rules.
