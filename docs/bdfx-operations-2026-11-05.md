# BDFX operational checkpoint — 5 November 2026

This checkpoint updates operational evidence. The approved application behavior remains in `approved-behavior.md`; its historical open-item list is dated 22 October and is not a current live status.

## Completed and verified

- Frontend PR22 merged as `d15c88ba7f08b260a19f3ab27e148c2f4598ec96`; Vercel production succeeded. The public sitemap returned HTTP200 and all three actual published article URLs after deployment, including `mt5-market-limit-and-stop-orders`. The sitemap now requests fresh publications; normal blog-page caching remains. All55 frontend tests, TypeScript and the production build passed. This does not certify Google indexing.
- n8n workflow `BDFX | Availability alerts to Reports` is published in the owner's Personal project. It checks the fixed production backend/database health URL and the public homepage every five minutes. New failures and recovery are reported to the existing BDFX Reports group. Healthy checks are silent; unchanged failure reminders require a verified prior receipt and are limited to every six hours.
- The explicitly labelled alert delivery test succeeded, Telegram message54, execution28806. The first actual scheduled check, execution28824 at01:10UTC, verified both services and sent no message. By11:05UTC the workflow had121 executions; the latest checks succeeded. No outage was deliberately generated to test notifications. The existing GitHub monitor remains enabled.
- Production registration options confirm WhatsApp OTP is enabled and registration available. This is separate from ongoing account-update messaging.
- The real campaign worker logged SMTP acceptance at06:00:53UTC on4November and06:00:14UTC on5November, the agreed10AM Dubai slot. This is campaign SMTP acceptance, not inbox-delivery proof. The connected owner's Gmail search returned no matching non-authentication BDFX campaign message, so Inbox/Spam placement remains unverified.

## Agent group preparation

`BDFX | Agent group work reports DRAFT` is a separate17-node workflow in the owner's Personal project. Its validated preview succeeded without sending any message. Both collection and delivery switches remain off; it is not published, and the existing live Telegram collector has not been changed.

- Explicit `/update`, `Update:`, `Done:`, `Pending:`, `Plan:`, `Blocker:` and `Meeting:` messages are supported. Normal discussion and attendance IN/OUT are ignored. Edited reports retain source versions; an edit withdrawing an update suppresses its previous text.
- Reports use the original message timestamp in Dubai, preserve all contributors across pages and link to each source message. Collection gaps are labelled. A missing work update is never called an absence or a working-hours shortfall.
- Separate Agent Work Updates and Agent Work Team tables are empty. No Attendance roster or HR records were copied. The verified Agent roster and actual capture-start timestamp still need to be established.
- The planned daily report is23:00 Dubai, subject to activation. Before activation, verify group/bot access, add routing from the existing single Telegram trigger, set the capture-start timestamp and test real capture/delivery. Do not register a second webhook for the same bot. Tagged AI for this group still needs a work-only context and current-member checks; do not route it to the Reports financial/client source.

## Remaining external or implementation dependencies

1. **Database backups:** the connected Atlas account exposes only the empty Project0, not the current production cluster. Obtain the actual production-project access, inspect its existing backup policy and recoverable snapshots, then perform an isolated restore and verify it without altering production. No replacement database was created.
2. **Campaign inbox proof:** use an actual consented test recipient and the existing production mail path, correlate the campaign receipt, then inspect Inbox/Spam. The BDFX admin session presently requires sign-in. Preserve the10AM slot, existing opt-in rules and send limits.
3. **Customer WhatsApp updates:** the owner reported signing in to WATI. The cloud browser connection stopped responding, including a fresh-page verification attempt; signed-in state is unknown. No templates were submitted and no customer update was sent. Draft copy is in `integrations/wati/bdfx-account-templates.json`. Provider approval, separate ongoing consent, durable delivery/STOP handling and an actual delivery test are still required. The working registration OTP flow was not changed.
4. **Agent coordination:** the draft is prepared but group membership, roster, connection to the existing collector and tagged assistant testing remain open. Attendance continues independently in its own group.

Client Telegram OTP/chat/follow-ups remain deferred. No new customer, campaign opt-in, trade, deposit, withdrawal or verification decision was created for this work.
