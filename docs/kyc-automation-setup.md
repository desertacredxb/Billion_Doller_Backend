# BDFX verification deployment

## Current release state — 2026-09-24

The KYC implementation is prepared as a GitHub draft. It has **not been deployed or validated for production activation**.

Render is connected to the existing Standard-plan backend service `srv-d39uut0dl3ps73aiomjg` at
[https://billion-doller-backend.onrender.com](https://billion-doller-backend.onrender.com).
These environment values were set through the Render connector:

```dotenv
BDFX_KYC_AUTOMATION_ENABLED=false
BDFX_KYC_RELEASE_APPROVED=false
BDFX_WATI_CHANNEL_NUMBER=441157911131
```

Both KYC flags must remain false while the release blockers below are unresolved. The environment update automatically redeployed the existing commit `e543b22` as Render deploy `dep-daqlderktnus73ba63e0`; none of the new KYC code was deployed.

The latest Sumsub dashboard check was logged out. Production credentials, account access and the exact production level remain unverified; the previously observed level was `bdfx-kyc-sandbox`. That level cannot enable production processing.

The independent WATI welcome rule was enabled earlier for `+441157911131`. This does not connect the backend's KYC notifications: their approved template names and API secret still need to be configured and verified. WhatsApp/phone OTP is deferred; the existing email OTP registration flow remains in place.

Validation snapshot: the backend suite passed **77/77 tests**. Frontend type checking passed; the frontend production build was blocked by the existing Montserrat Google Fonts TLS fetch failure. No font/source workaround was introduced, and that build remains unverified.

## Implemented workflow

An authenticated user uploads one government ID in the CRM, with a required front image and an optional back image of the same ID. A second ID is rejected. Accepted formats are JPG, JPEG, PNG and PDF, up to 10 MiB per file. The normal path automatically submits the stored document to Sumsub when production processing is enabled.

Three durable Mongo queues run after the database connection opens:

| Queue | Responsibility and recovery |
| --- | --- |
| `KycIntake` | Deduplicates a user's stored front/back upload, creates or recovers the bound Sumsub applicant at the configured level, uploads document sides and requests review. Checkpoints and leases survive restarts. An interrupted upload with an unknown provider result becomes `action_required`; it is not blindly uploaded again. A bounded recovery pass finds eligible saved uploads whose enqueue was interrupted. Provider-confirmed UAE refusal commits User, any pending IB refusal, notices and the intake acknowledgement transactionally. |
| `KycReview` | Persists authenticated review callbacks, then fetches the current applicant, review, identity and relevant residence evidence. Rechecks review identity and the current user before committing the outcome, IB state, notices and job acknowledgement together. Failed work remains retryable. |
| `KycNotice` | Stores independent email and WhatsApp delivery records. Deterministic keys deduplicate repeated events; failures persist attempt counts and next retry times. Newer outcomes cancel older unsent notices, and workers recheck leases before dispatch. |

The default worker polling interval is 15 seconds. Intake/review leases are three minutes; notice leases are two minutes. Failed intake and notification attempts back off from one minute to a maximum of one hour; review jobs also use capped retry backoff. These intervals are code defaults, not additional environment variables.

Document downloads are restricted to original versioned uploads in the configured Cloudinary cloud's `Billio-dollar-FX` folder. Redirects and arbitrary external URLs are refused, and file signatures and download sizes are checked. Intake records contain stored-document references, metadata and hashes; the downloaded bytes are used for the provider request. Review and notice queues do not store ID images or raw provider comments. Notices contain recipient details, safe fixed reasons and hashed correlation identifiers.

Provider approval is committed with any existing IB approval and referral-code issuance. A failed IB write or notice enqueue rolls the review transaction back. Local UAE refusals also commit the User decision, pending IB refusal and notices in one transaction. IB registration after a recorded production approval checks the server's verification evidence. A client-provided approval flag does not grant approval.

The hosted provider flow is available only as a fallback when the account is `action_required` and another provider step is needed:

| Endpoint | Use |
| --- | --- |
| `PUT /api/auth/documents/:email` | Authenticated owner uploads the ID or a permitted correction. |
| `GET /api/auth/kyc/status` | Authenticated owner reads their safe status and correction reason. |
| `POST /api/auth/kyc/start` | Authenticated owner opens the configured provider's additional verification steps. |

Pending and completed reviews cannot have their documents replaced. A provider-requested correction can replace the ID and start another intake while retaining the applicant binding.

## Country, residence and document decisions

Approval requires a completed provider GREEN review, successful supported identity evidence with a recognized issuing country, and a GREEN proof-of-address result containing a recognized country of residence. Unknown three-letter country strings are not accepted as valid country codes. The workflow rejects a known UAE signal from the account's declared country/nationality, declared issuing country, provider nationality, provider identity issuing country or verified residence.

Declared country or nationality alone never proves residence. Missing or unsuccessful residence evidence produces `action_required`; it cannot produce approval. A RED review with `RETRY` also requests correction, while a final RED review rejects. Correction notices use a separate resubmission template and are not presented as final rejection.

One ID can complete the process only if the configured Sumsub level can establish the required identity and residence evidence from that ID. A level that requires proof of address, a selfie, liveness or another step must expose and complete that step through the fallback flow. Do not promise that one uploaded image always completes all provider requirements.

The upload choices map Passport to `PASSPORT`, and National ID Card, PAN Card and Aadhaar Card to `ID_CARD`. PAN/Aadhaar submissions require India as the issuing country. This mapping does not establish provider acceptance: support for each document and each required side must be verified against the approved production level.

## Backend configuration

Keep these values server-side; never expose them as `NEXT_PUBLIC_*`. No secret values belong in this document or logs.

| Variable | Required value or purpose |
| --- | --- |
| `BDFX_KYC_AUTOMATION_ENABLED` | Exact string `true` enables the automation path; currently `false`. |
| `BDFX_KYC_RELEASE_APPROVED` | Exact string `true` additionally permits production processing; currently `false`. This is a release guard, not a substitute for route authorization. |
| `SUMSUB_MODE` | Must be `production` for provider processing. |
| `SUMSUB_LEVEL_NAME` | Exact production level name; must be present and cannot be `bdfx-kyc-sandbox`. |
| `SUMSUB_APP_TOKEN` | Server-side app token with the required applicant, document, review and evidence access. |
| `SUMSUB_SECRET_KEY` | Signing secret belonging to the app token. |
| `SUMSUB_WEBHOOK_SECRET` | Webhook HMAC secret, configured separately from the API signing secret. |
| `SUMSUB_CLIENT_ID` | Exact expected client ID for applicant and webhook binding. |
| `CLOUDINARY_CLOUD_NAME` | Existing upload cloud; also required by the intake download allowlist. |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Existing server-side Cloudinary upload credentials. |
| `MONGO_URI` / `DB` | Existing database connection settings; the database must support transactions. |
| `JWT_SECRET` | Existing signing secret for authenticated owner routes. |

Missing production configuration prevents worker processing. Notice records can still be persisted during a configuration outage so that the outcome is not lost.

### WhatsApp

| Variable | Required value or purpose |
| --- | --- |
| `BDFX_WATI_BASE_URL` | Tenant HTTPS base URL without `/api/v1`, URL credentials, query or fragment. |
| `BDFX_WATI_API_TOKEN` | Server-side WATI bearer token. |
| `BDFX_WATI_CHANNEL_NUMBER` | Optional override; accepted only for `441157911131` / `+441157911131`. The same hard-locked sender is used when omitted. |
| `BDFX_WATI_KYC_PENDING_TEMPLATE` | Approved pending/welcome template, with no parameters. |
| `BDFX_WATI_KYC_APPROVED_TEMPLATE` | Approved verification-success template, with no parameters. |
| `BDFX_WATI_KYC_REJECTED_TEMPLATE` | Approved final-rejection template with one reason parameter. |
| `BDFX_WATI_KYC_RESUBMISSION_TEMPLATE` | Separate approved correction/additional-step template with one reason parameter. |
| `BDFX_WATI_KYC_REASON_PARAMETER` | Reason parameter name for rejected/resubmission templates; defaults to `1`. |

The sender does not fall back to another WATI channel. Missing settings, an incorrect sender or a non-accepted provider response are not recorded as successful sends. Verify that pending messaging and the separately enabled welcome rule do not unintentionally duplicate the same customer message.

### Email

The KYC sender uses environment credentials directly and propagates failure to its queue; it does not use the older email helper that swallows failures.

| Setting | Environment lookup order |
| --- | --- |
| SMTP username | `BDFX_KYC_SMTP_USER`, then `SMTP_USER`, then `EMAIL_USER` |
| SMTP password | `BDFX_KYC_SMTP_PASS`, then `SMTP_PASS`, then `EMAIL_PASS` |
| From address | `BDFX_KYC_EMAIL_FROM`, then `EMAIL_FROM`, then the resolved username |
| SMTP host | `BDFX_KYC_SMTP_HOST`, then `SMTP_HOST`; when absent, use Nodemailer's Gmail service with the resolved credentials |
| SMTP port | `BDFX_KYC_SMTP_PORT`, then `SMTP_PORT`, then `465` when a host is configured |

Port 465 uses implicit TLS; a configured different port requires STARTTLS. Certificate validation remains enabled. SMTP has a 30-second total attempt deadline. A record reaches `sent` only on explicit SMTP acceptance for its recipient or explicit WATI acceptance; this does not prove inbox or handset delivery.

## Webhook and database requirements

Configure the production Sumsub `applicantReviewed` webhook as an HTTP POST to:

[https://billion-doller-backend.onrender.com/api/sumsub/webhook](https://billion-doller-backend.onrender.com/api/sumsub/webhook)

Use `Content-Type: application/json`, `x-payload-digest-alg: HMAC_SHA256_HEX` and `x-payload-digest` signed with `SUMSUB_WEBHOOK_SECRET`. The server mounts its raw-body parser before JSON parsing and verifies the exact incoming bytes, with a 256 KiB limit. Proxies must not rewrite the JSON body before verification.

Production callbacks require the configured client and level, an individual applicant, valid bound identifiers and a completed GREEN/RED review. `sandboxMode` must explicitly be `false`; test/sandbox events cannot grant approval. The callback is acknowledged only after its review job is durable. The callback's claimed decision is not itself enough to approve: the worker fetches the current authenticated provider evidence.

MongoDB must be a replica set or sharded deployment supporting multi-document transactions, and the queue indexes must be created. A standalone server is insufficient. Do not bypass the transaction to accommodate an unsupported database: User, IB, notices and final review acknowledgement must commit or roll back together.

Monitor queue state, oldest due jobs, attempts and safe error codes. Investigate `blocked` review jobs, ambiguous intake uploads and persistent channel configuration failures. Logs and operational reports must not include API tokens, document bytes, document numbers, provider raw comments or recipient details.

Delivery is at least once: a process can fail after provider acceptance but before recording success, causing a retry to duplicate a message. Newer outcomes cancel older unsent notices, but a request already in flight cannot be recalled. Provider review time, queue delays and downstream delivery mean **there is no one-minute completion or delivery SLA**.

## Remaining release blockers and controlled validation

1. **Secure the remaining pre-existing routes.** This draft adds owner authentication/field allowlists for profile editing, ID uploads and IB registration, plus protected KYC status/start endpoints. Public admin/user-list and lookup routes, banking updates/approvals, delete routes and other existing account/commission operations still require an authentication and authorization review. Manual KYC/IB decisions are blocked while automation is enabled, but that guard is not general admin security. Do not set the release flag true while these routes can undermine trusted account state or expose customer documents.
2. **Verify the actual Sumsub production account and level.** Restore authorized dashboard access and verify production credentials, client/level binding, UAE exclusions, supported ID types/sides, identity and residence evidence, and the required hosted fallback steps. The last logged-out check and former sandbox level do not establish readiness.
3. **Verify transaction support and recovery on an isolated database.** Run `npm test`; current focused tests cover authorization, multipart uploads, country/document decisions, provider request signing, deduplication, leases, channel retries, stale-notice suppression and injected transaction rollback. These mocks do not establish the deployed Mongo topology or live provider behavior. On an isolated transaction-capable database, verify rollback after IB/notice/acknowledgement failure, restart recovery, duplicate callbacks and expired leases before production activation.
4. **Complete controlled end-to-end cases.** Use an isolated backend/database and approved provider test facilities or specifically authorized controlled accounts. Cover non-UAE GREEN with valid residence, UAE identity/residence, final RED, RETRY correction, missing residence, unsupported IDs, changed review results, replaced documents, stale callbacks and incomplete additional steps. Confirm every expected IB/referral outcome and that forged, unsigned and sandbox events never approve real accounts. Do not switch the production flags merely to run a test.
5. **Connect and test both notification channels.** Verify all four approved WATI template names, parameter shapes and the exact sender using controlled recipients. Verify SMTP authentication/TLS, provider acceptance and observed delivery. Test one failed channel while the other succeeds, recovery after restart and suppression of older pending/rejection messages after a newer approval. The independent welcome rule is not evidence that these KYC paths work.
6. **Complete the production build and deployment validation.** Resolve the existing Google Fonts TLS build dependency and obtain a successful frontend production build. Review the finished backend/frontend changes, deploy with both flags still false, verify the deployed revision and all controlled checks, then record successful production validation before enabling processing. The user has authorized setup and deployment; the remaining gates concern technical readiness and provider production access. Keep WhatsApp OTP deferred unless separately requested.
