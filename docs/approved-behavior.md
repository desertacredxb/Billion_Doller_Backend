# BDFX approved behavior baseline — 22 October 2026

The owner requested that accepted work from 20–22 October be preserved during future fixes. This is a behavior contract, not permission to change unrelated flows. A new owner instruction is required to alter these agreed behaviors. Routine bug fixes should retain them and verify affected dependencies.

## Accepted behavior to preserve

| Area | Contract |
| --- | --- |
| Client identity correction | Ordinary unapproved review, provider resubmission and retryable failures retain **Edit name & resubmit → Save details → Resubmit verification**. Only full name is editable; address editing stays removed. Other identity/contact changes use support. |
| Corrected identity | Saving a name retires the old session correlation. Require a fresh Veriff decision; delayed or concurrently fetched old approvals cannot approve changed details. Approved clients must not silently lose verification. |
| Veriff approval | Accept every document class approved by the current live Veriff integration. Retain signature/code/session/reference/integration checks, verified email, UAE restrictions, unique mobile checks and explicit owner reviews. Review must not falsely be called a provider rejection. |
| Verification support | Preserve the original-physical-government-photo-ID notice and WhatsApp support at +447999283366. Client status refresh reconciles the current signed approval; the owner sync action is separate from client resubmission. |
| Client registration | Canonical duplicate email OR mobile protection, atomic unique indexes, bounded email-code attempts and working email signup. Never mark a phone verified without actual matching WhatsApp proof. |
| IB | Existing client ownership, eligible signed/manual-reviewed KYC, transactional role/referral updates, rejection reasons and explicit reapplication. Do not enroll ordinary clients as IBs. |
| Admin access | Existing owner/manager OTP sessions, scoped permissions, immediate revocation, staff management and audit history. New sections do not silently widen manager access. |
| Enquiries and tickets | Validated persistent records, confirmations, ownership, duplicate-submit protection and team notification retries. A saved request remains saved if mail delivery fails. |
| Payments | Retain RameePay INR, RameePay Crypto and Cregis Crypto only. DigiPay/TrustPay24 stay closed. Preserve persistent duplicate-credit guards and existing active-provider calculations/configuration. Do not simulate live financial callbacks. |
| Bonus terms | The confirmed campaign offer is a minimum qualifying deposit of US$100, no maximum deposit amount and 100% deposit bonus. Bonus funds are non-withdrawable; retain withdrawal notices. Copy does not implement or certify bonus-ledger enforcement. |
| MT5 | Preserve the existing Ascends WebTrader and official MT5 alternatives. The owner confirmed the platform works; do not reopen an earlier environment-only loading problem as a production defect. |
| Chatbot | Keep the single BDFX Help control, six-language guided public answers, optional saved sessions/follow-up consent and protected Chat Reports. Do not restore the removed floating WhatsApp icon or claim a live-agent inbox. |
| Analytics | Dedicated BDFX GA4 configuration, explicit production visitor consent, public-path filtering, success-only fixed conversion metadata and owner-only reports in the existing BDFX session. No separate Google login in the panel. Zero realtime activity must not break historical reporting. |
| Business report | Dubai date boundaries, registration/account/work-queue and payment-status counts. Do not combine mixed-currency monetary totals or present signup events as verified sales. |
| SEO and blogs | Preserve existing manual metadata, public SSR/canonicals/structured data/sitemap, private noindex rules, both Search Console tags and durable weekly educational publishing. The starter library is finite; do not promise unlimited content or Google indexing. |
| Calculators and media | Retain tested Forex/IB calculations, dated reference-currency responses, calendar links and optimized media behavior. Do not substitute invented live prices. |
| Email campaign | Only verified, explicitly opted-in, non-UAE eligible clients enter the seven-day sequence. First mail uses the next 10:00 Dubai slot; subsequent days retain the cadence, one-per-minute/per-client limits and 500 daily/rolling-24-hour campaign cap. Do not bulk opt in legacy accounts or move scheduled sends silently. |
| Email evidence | SMTP acceptance, campaign receipt and inbox delivery are different signals. Keep due/future queue diagnostics. Hold ambiguous campaign deliveries for review instead of blindly retrying. |
| Health and recovery | Preserve HTTP /health and existing failure notifications. Distinguish website/database checks from workflow failures or monitor staleness. Never claim configured backups without the actual production project and a recoverable snapshot/isolated restore test. |

## Verification checkpoint

- Application releases: backend `606c4b2f6ba786925ecd3471437e608865c21265`, frontend `1455c5c648bd5d8cb1ea728c291488b26d96262d`. Render and Vercel deployments succeeded.
- All 208 backend tests and 36 frontend tests passed. TypeScript and the production frontend build passed. CI includes lockfile installation, tests and dependency audits; frontend CI also builds the app.
- Backend CI: https://github.com/desertacredxb/Billion_Doller_Backend/actions/runs/39765376280
- Frontend CI: https://github.com/desertacredxb/billiondollarfx/actions/runs/39765447283
- Fresh read-only checks passed for 23 public/access-control paths, including database health, registration options, verification entry, published article metadata, sitemap, currency data and anonymous denial on private APIs.
- Signed-in owner reads loaded IB, Analytics, Chat Reports, Business Report, staff, audit history, the campaign report and automatic blog controls. The earlier signed current-session Veriff approval was persisted and its audit event is visible.
- The deployed verification assets contain the corrected actions. Synthetic tests cover actual rendered name-only controls, review/resubmission availability, refreshed resubmit state, a complete fresh-decision flow and concurrent stale-approval rejection.
- No customer record, contact/ticket, OTP, campaign send, trade, deposit or withdrawal was created for this audit. No live customer's name was edited to test the new correction flow. That final real-client round trip remains a qualified check.

## Still open; do not label complete

1. Campaign SMTP acceptance/inbox receipt remains unconfirmed. A configured active queue and a future due time do not prove a send. System-mail acceptance logs are not campaign proof. Preserve explicit opt-in and the agreed 10:00 Dubai schedule.
2. WhatsApp OTP configuration is present, but enforcement is disabled in the current production startup/options response. Current template approval and actual WhatsApp receipt/verification were not certified. Working email signup must remain available.
3. The connected Atlas account exposes only the empty Project 0, not the existing production database. Backup policy, snapshots and isolated restore verification require access to that actual project. Never create a replacement database or restore over production.
4. The latest observed scheduled GitHub production-health run succeeded at 06:00 UTC on 22 October, but was stale at this review. Fresh direct website/database checks passed. The scheduled trigger's timeliness and actual alert delivery are not certified by that older success. Run: https://github.com/desertacredxb/Billion_Doller_Backend/actions/runs/39731255372
5. Real financial settlement, bonus-ledger enforcement, customer inbox placement and a new signed-in client edit/resubmit/provider round trip were not generated for audit. Synthetic checks cannot certify those external outcomes.

The repository guidance and existing CI are safeguards against regression. A permanent write freeze, mandatory branch reviews and deploy gates have not been configured by this checkpoint; do not describe them as enforced locks.
