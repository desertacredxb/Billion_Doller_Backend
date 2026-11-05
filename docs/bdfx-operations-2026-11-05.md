# BDFX operational checkpoint — 5 November 2026

This checkpoint updates operational evidence. The approved application behavior remains in `approved-behavior.md`; its historical open-item list is dated 22 October and is not a current live status.

## Completed and verified

- Frontend PR22 merged as `d15c88ba7f08b260a19f3ab27e148c2f4598ec96`; Vercel production succeeded. The public sitemap returned HTTP200 and all three actual published article URLs after deployment, including `mt5-market-limit-and-stop-orders`. The sitemap now requests fresh publications; normal blog-page caching remains. All55 frontend tests, TypeScript and the production build passed. This does not certify Google indexing.
- n8n workflow `BDFX | Availability alerts to Reports` is published in the owner's Personal project. It checks the fixed production backend/database health URL and the public homepage every five minutes. New failures and recovery are reported to the existing BDFX Reports group. Healthy checks are silent; unchanged failure reminders require a verified prior receipt and are limited to every six hours.
- The explicitly labelled alert delivery test succeeded, Telegram message54, execution28806. The first actual scheduled check, execution28824 at01:10UTC, verified both services and sent no message. By11:05UTC the workflow had121 executions; the latest checks succeeded. No outage was deliberately generated to test notifications. The existing GitHub monitor remains enabled.
- Production registration options confirm WhatsApp OTP is enabled and registration available. This is separate from ongoing account-update messaging.
- The real campaign worker logged SMTP acceptance at06:00:53UTC on4November and06:00:14UTC on5November, the agreed10AM Dubai slot. The signed-in owner panel now shows19 opt-ins,14 clients in sequence,55 campaign SMTP acceptances and no held deliveries. The next queued send is6November10AM Dubai.
- Owner delivery testing is now live: backend PR37 (`822a5ca7e571eab23fe3d1d919cffb65c3b212d6`) and frontend PR23 (`f691f8cd4671be03b588eb4b6975c7da5dfaca95`) passed checks and production deployment. All304 backend tests,55 frontend tests, TypeScript and the frontend production build passed. A single owner-requested welcome preview was accepted at19:09:16 Dubai on5November; the matching unique-reference message was found in the owner's Gmail with the INBOX label. This verifies that individual test message, not every customer's inbox placement. Campaign counts and preferences remained unchanged.

## Agent group preparation

`BDFX | Agent group work reports DRAFT` is a separate20-node workflow in the owner's Personal project. Its validated preview succeeded without sending any message. A separate read-only access probe could not verify the Agent group or current bot membership. Both collection and delivery switches remain off; it is not published, and the existing live Telegram collector has not been changed.

- Explicit `/update`, `Update:`, `Done:`, `Pending:`, `Plan:`, `Blocker:` and `Meeting:` messages are supported. Normal discussion and attendance IN/OUT are ignored. Edited reports retain source versions; an edit withdrawing an update suppresses its previous text.
- Reports use the original message timestamp in Dubai, preserve all contributors across pages and link to each source message. Collection gaps are labelled. A missing work update is never called an absence or a working-hours shortfall.
- Separate Agent Work Updates and Agent Work Team tables are empty. No Attendance roster or HR records were copied. The verified Agent roster and actual capture-start timestamp still need to be established.
- The planned daily report is23:00 Dubai, subject to activation. Before activation, verify group/bot access, add routing from the existing single Telegram trigger, set the capture-start timestamp and test real capture/delivery. Do not register a second webhook for the same bot. Tagged AI for this group still needs a work-only context and current-member checks; do not route it to the Reports financial/client source.

## Remaining external or implementation dependencies

1. **Database backups:** the connected Atlas account exposes only the empty Project0, not the current production cluster. Obtain the actual production-project access, inspect its existing backup policy and recoverable snapshots, then perform an isolated restore and verify it without altering production. No replacement database was created.
2. **Customer WhatsApp updates:** the saved WATI login now works; tenant358063 and connected sender+441157911131 are verified. Existing Utility templates `bdfx_registration_complete` and `bdfx_verification_status_update` are approved. The new English Utility template `bdfx_verification_reminder_v1`, with a static account-login button, was submitted and is Pending Meta review. No customer campaign was started. Exact observed content/status is recorded in `integrations/wati/bdfx-account-templates.json`. Separate ongoing consent, a durable outbox, withdrawal/STOP handling and an actual test to an explicitly supplied consenting recipient number are still required before customer automation can go live. The working registration OTP flow was not changed.
3. **Agent coordination:** the draft is prepared but group access, verified roster, connection to the existing collector and tagged assistant testing remain open. Attendance continues independently in its own group.

Client Telegram OTP/chat/follow-ups remain deferred. No new customer, campaign opt-in, trade, deposit, withdrawal or verification decision was created for this work.
