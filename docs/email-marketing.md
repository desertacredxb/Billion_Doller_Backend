# Seven-day email sequence

The owner-only Email Marketing screen shows enrolments, SMTP acceptance, held deliveries, unsubscribes, message previews and pause/resume controls. Client Settings includes optional marketing preferences; signup records explicit consent with a policy version and timestamp. Legacy accounts are never opted in by migration. Only verified, opted-in, eligible accounts enter the sequence.

The worker runs every minute and stores progress in MongoDB. First mail is scheduled for the next 11:00 Asia/Dubai slot, with later messages on subsequent days. It sends at most one campaign message per minute and enforces a shared Dubai-date daily cap across instances. KYC reminders are skipped for verified KYC. Database leases and unique delivery receipts prevent duplicate reservations; uncertain SMTP sends are held for manual review, never blindly retried. SMTP acceptance does not prove delivery or inbox placement.

Delivery defaults to paused and disabled. Before activation, verify mailbox/domain readiness, campaign consent and the actual mailbox sending allowance, accounting for account/security traffic. Configure EMAIL_MARKETING_ENABLED=true and EMAIL_MARKETING_DAILY_LIMIT (1–1000), then resume through the owner screen. The cap is for this campaign only, not all transactional emails. No provider account, billing plan or customer offer is created by this feature.

Public GET unsubscribe links display confirmation without changing state; POST handles confirmation and one-click opt-outs. Links use namespace-separated HMAC signatures with JWT_SECRET; rotating that secret invalidates older links. Client Settings remains available for unsubscribe. Do not rotate signing keys without planning unsubscribe-link compatibility.

Run npm test. Tests use synthetic accounts and mail transports; they do not send campaigns or import customer addresses.
