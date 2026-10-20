# Veriff registration verification

New registrations remain unverified for KYC until a signed Veriff result approves their linked session and BDFX eligibility checks pass. Email OTP remains the existing email-verification step. This change does not provision MT5 accounts, approve IB business applications, approve bank details, or implement WhatsApp OTP.

## Configuration and release

Pair this backend branch with `codex/veriff-registration-auto-approval` in `desertacredxb/billiondollarfx`. The frontend profile form must send its bearer token before the backend's profile ownership check is deployed.

1. Resolve Veriff portal access. On 20 October 2026 the cloud sign-in showed `Authentication Failed` and `You do not have permission to get data or perform this action`. No Veriff settings or keys were changed. Use the account's activation email to identify the correct Station/Hub portal and permitted authentication method.
2. Open the existing BDFX integration. Record whether it is a test or live integration and whether its product uses the decision or Full Auto webhook. Do not replace an existing integration or rotate its keys as part of setup.
3. Store the exact API base URL, API key, and shared secret in the backend's secret environment settings. Use `config/veriff.env.example` for variable names. Never put secrets in the frontend, Git, a URL, or logs.
4. Configure the selected integration's **Webhook decisions URL** to `https://billion-doller-backend.onrender.com/api/veriff/webhooks/decision`. For the Full Auto product, use the same endpoint in **Webhook Full Auto URL** and set `VERIFF_WEBHOOK_TYPE=fullauto` instead. Configure the return/callback URL as `https://billiondollarfx.com/verify-identity`.
5. Deploy the paired code with flags disabled. In an isolated staging environment, set `VERIFF_ENABLED=true`, `VERIFF_MODE=test`, and frontend `NEXT_PUBLIC_VERIFF_ENABLED=true`; rebuild the frontend when changing its public flag. Use the selected test integration's keys and staging callback/webhook URLs. Do not route test decisions to production or change production integration URLs for a staging test.
6. Test an entire registration with a synthetic test client: email OTP, authenticated session creation, hosted verification, signed webhook, and displayed result. Veriff test integrations require manually triggered test decisions. Check approved, declined, resubmission, expired, wrong-signature, duplicate-delivery, UAE, and duplicate-mobile cases. Test-mode approvals must leave `isKycVerified=false`.
7. Activate production only after confirming the live integration, live credentials, correct product/webhook, supported documents, production URLs, and required business verification checks in the portal. Set `VERIFF_MODE=live` and enable both flags. Complete an authorized live smoke test before describing the system as live.

The Render service identified for this backend is `Billion_Doller_Backend` (`srv-d39uut0dl3ps73aiomjg`) in `Dessert's workspace`. It deploys `main` automatically. This branch must remain separate until configuration and release checks are complete.

## Decision handling

- `POST /api/veriff/sessions` and `GET /api/veriff/status` require the client's signed bearer token. Both existing token shapes (`id` and `userId`) are supported. A request cannot select another client by email or user ID in its body.
- Session creation saves an opaque correlation UUID before calling Veriff, resumes an unfinished session, and uses an atomic compare-and-update to avoid conflicting writes. Session URLs and internal correlation fields are excluded from ordinary profile query results.
- The webhook router is mounted before `express.json()`. HMAC-SHA256 is checked against the exact raw bytes with a timing-safe comparison, along with the integration key. The persisted correlation, session ID, mode, and integration-key hash must match. The callback/return page never approves an account.
- Signed `approved` decisions can set `isKycVerified=true` only in live mode, with verified email, a valid phone number, no duplicate mobile, a declared non-UAE residence, non-UAE nationality, and a supported non-UAE identity document. Missing information goes to review. UAE detection checks declared country/nationality and provider-extracted issuing country/nationality; it does not establish physical location or independently verify residence.
- Accepted automatic document classes are `PASSPORT` and `ID_CARD`. The client's requested PAN/Aadhaar/government-ID support must be checked against the selected Veriff integration; this code does not assume every government document is supported or configure a separate Aadhaar database product.
- Declined, review, resubmission, expired, and abandoned outcomes remain unverified. Re-submission resumes the original link. Test approvals show `test_approved` and do not enable live KYC. Duplicate and older decisions are acknowledged without reapplying them. A concurrent change causes a retryable response. Raw document numbers, images, selfies, and full provider payloads are not stored by this integration.
- Legacy upload and manual KYC mutations reject Veriff-managed accounts. Profile updates require ownership and allow only profile fields, preventing client-supplied KYC/session flags from overriding the result. Existing manual accounts retain their manual KYC flow.

The existing legacy admin uses a separate access pattern. This change does not replace that admin system; it prevents those old KYC endpoints from deciding Veriff-managed accounts. Cases requiring review must be handled in Veriff using an authorized operator and a decision webhook; a local manual override is intentionally unavailable for these accounts.

## Validation

Run `npm ci --ignore-scripts` and `npm test`. Tests use local synthetic fixtures and in-memory model doubles, including an HTTP router/HMAC test. They do not contact Veriff, MongoDB, clients, email, WhatsApp, or MT5. A real MongoDB/staging round trip and live Veriff smoke test are still required before activation.

Official references:

- https://devdocs.veriff.com/docs/how-to-generate-sessions-manually
- https://devdocs.veriff.com/docs/webhooks-guide
- https://devdocs.veriff.com/docs/decision-webhook
- https://devdocs.veriff.com/docs/full-auto-webhook
- https://devdocs.veriff.com/docs/logging-in
