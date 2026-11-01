# BDFX twice-daily reporting

Owner request, 1 November 2026: deliver a separate BDFX report to Telegram every day at **12:00 and 18:30 Asia/Dubai**, including new registrations and approved/non-approved KYC counts.

`GET /api/support-chat/n8n/business-report` requires the independent `X-BDFX-Business-Report-Key`, matched against `BDFX_N8N_BUSINESS_REPORT_TOKEN`. The Buddy chat key and older Buddy-only report key cannot authorize it. The credential grants no client lookup, account action, settings mutation, payment callback or transaction access. The route accepts no query parameters and returns aggregate counts only, with no personal contact details or transcripts.

The report is cumulative from Dubai midnight to its actual generation time. Registered/new clients have completed email verification; incomplete OTP attempts are excluded. KYC approval uses BDFX's existing `isKycVerified` flag. Non-approved includes not-started, in-progress, review, resubmission, declined and other unapproved states; these are not all rejections. All-client and new-client breakdowns come from a single aggregation. No verification flags are changed.

Deposit/withdrawal counts describe requests created today and their current statuses. Current pending withdrawals, KYC, IB and ticket queues are separate snapshots. Monetary totals are deliberately excluded: the deposit model does not expose an unambiguous currency on every order, and combining currencies would misstate totals. Buddy metrics count only consented saved support sessions, not all website visitors or all AI requests.

The existing n8n reporting draft `7FfDLibvEx6513QT` is the report workflow to extend; preserve the live Buddy chat workflow. Configure the backend's new read-only secret in Render and an encrypted, domain-restricted n8n credential, never in source or workflow parameters. Publish the report workflow only after the owner-selected **separate BDFX Telegram group** is resolved and a real source/delivery test succeeds. Do not use Rudra555's or Master Trader/T3's report audience by default.

Use two daily schedule rules (12:00, 18:30) and workflow timezone `Asia/Dubai`. Scheduled reports should include source timestamp and coverage. Missing/invalid source data must be reported unavailable, never converted to zero registrations or zero payment counts. Delivery must retain a receipt and avoid blind retries after an uncertain Telegram send.
