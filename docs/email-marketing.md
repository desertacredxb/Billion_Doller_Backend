# Seven-day email sequence

The owner-only Email Marketing screen shows enrolments, SMTP acceptance, held deliveries, unsubscribes, message previews and pause/resume controls. Client Settings includes optional marketing preferences; signup records explicit consent with a policy version and timestamp. Legacy accounts are never opted in by migration. Only verified, opted-in, eligible accounts enter the sequence.

The worker runs every minute and stores progress in MongoDB. First mail is scheduled for the next 10:00 Asia/Dubai slot, with later messages on subsequent days. It sends at most one campaign message per minute and enforces both a shared Dubai-date daily cap and a rolling 24-hour reservation cap across instances. The rolling cap includes accepted, sending, uncertain and cancelled reservations; skipped messages do not consume it. A date change cannot bypass the mailbox allowance. KYC reminders are skipped for verified KYC. Database leases and unique delivery receipts prevent duplicate reservations; uncertain SMTP sends are held for manual review, never blindly retried. SMTP acceptance does not prove delivery or inbox placement.

Delivery defaults to paused and disabled. Before activation, verify mailbox/domain readiness, campaign consent and the actual mailbox sending allowance, accounting for account/security traffic. Configure a private EMAIL_MARKETING_TOKEN_SECRET (at least 16 characters; use 32 random bytes), EMAIL_MARKETING_ENABLED=true and EMAIL_MARKETING_DAILY_LIMIT (1–1000), then resume through the owner screen. The cap is for this campaign only, not all transactional emails. No provider account, billing plan or customer offer is created by this feature.

Public GET unsubscribe links display confirmation without changing state; POST handles confirmation and one-click opt-outs. Links use namespace-separated HMAC signatures with JWT_SECRET; rotating that secret invalidates older links. Client Settings remains available for unsubscribe. Do not rotate signing keys without planning unsubscribe-link compatibility.

Run npm test. Tests use synthetic accounts and mail transports; they do not send campaigns or import customer addresses.

The owner confirmed the upgraded Hostinger mailbox allowance is 1,000 messages per rolling 24 hours on 21 October 2026. Configure this campaign for 500 per day/rolling 24 hours to retain capacity for account and security mail. This campaign budget does not measure or guarantee the remaining allowance for other mailbox traffic. Campaign activation still requires consented eligible recipients and final approved message content.

The seven-day copy follows the requested welcome, MT5/100% bonus enquiry, experience check-in, funding guide, risk checklist, IB program and week-one check-in sequence. Day two directs recipients to support for eligibility and current bonus terms before depositing; it does not invent a bonus cap, cash-withdrawal rule, qualifying deposit or guaranteed outcome. Final written offer terms remain a business input.

Unsubscribe signatures use the dedicated EMAIL_MARKETING_TOKEN_SECRET. Existing installations without that key fall back to JWT_SECRET for compatibility, but a short/missing fallback cannot activate the campaign. Configuring the dedicated key never changes client/admin login credentials. Keep the key only in the existing Render secret manager, never in Git or logs.
