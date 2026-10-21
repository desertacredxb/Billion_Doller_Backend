# Email and WhatsApp registration verification

## WATI migration checkpoint — 21 October 2026

The owner selected WATI tenant 358063 and confirmed +441157911131 for BDFX OTP; Master Trader is separate. `bdfx_registration_otp` (English, Authentication, five-minute expiry, Copy code) was submitted through WATI and showed Pending. Submission is not approval or delivery.

The adapter now supports explicit `WHATSAPP_OTP_PROVIDER=wati` with `WATI_TENANT_ID=358063`, `WATI_CHANNEL_NUMBER=441157911131`, `WATI_OTP_TEMPLATE_NAME=bdfx_registration_otp` and secret `WATI_API_TOKEN`. Tenant, channel and template are pinned; redirects are disabled and provider errors are redacted. WATI acceptance is not phone verification; the existing matching-code proof still applies. Legacy Teleobi mode remains compatible. No production environment was changed and OTP enforcement remains off.

A new credential form was prepared, not generated: name BDFX registration OTP, expiry 90 days, only messagetemplate:write (WATI describes this as sending/scheduling/updating templates). Browser action-time confirmation is required before creating this persistent API access. Store any approved credential only in existing Render secrets; never Git, logs or chat. Approval, credential storage, live delivery and full registration verification remain pending. 145 backend tests pass with mocked WATI outcomes.

Official API: https://docs.wati.io/reference/sendtemplatemessage ; setup guide: https://support.wati.io/en/articles/11463224-how-to-send-otp-on-whatsapp-using-wati-api .

Owner request, 21 October 2026 (Dubai): verify the registered mobile by OTP and prevent another client login with the same email OR mobile. The owner explicitly selected WhatsApp, not SMS. This concerns BDFX client identity, not the number of permitted MT5 trading accounts or an IB role linked to the same verified client.

## Identity uniqueness

New emails are trimmed and lowercased; international phone punctuation, a `00` prefix and country-appropriate trunk prefixes normalize to a `+` international number using libphonenumber-js metadata. Structural possibility is checked; only the actual WhatsApp code proves access to the number. Provider-specific email aliases are not silently merged. Before creating a user, legacy records are matched using escaped case-insensitive email and formatted-phone patterns. Two partial unique indexes on registrationEmailKey and registrationPhoneKey protect concurrent new registrations. Existing raw email/phone indexes remain. Duplicate errors return a controlled 409, with no second OTP send. Ambiguous old national numbers without a calling code also block new registration for support review rather than risk a duplicate. That conservative rule can require support for an unrelated international number sharing the same local digits. No existing users are merged or deleted, and identity fields are not backfilled across customer records.

The readiness service uses connected collection metadata, never Model.init. It creates only the two required identity indexes and ensures pending registrations have at least 15 minutes for the two OTP stages. An existing shorter createdAt TTL is extended with collMod; its isVerified:false filter remains unchanged. Verified customers are excluded from that cleanup. No customer creation timestamps are rewritten. Storage failure blocks registration rather than pretending uniqueness is safe, without stopping the rest of the website.

Unverified drafts reserve their identity until automatic expiry; MongoDB TTL cleanup is asynchronous. Existing verified users are not forced through retroactive mobile verification. Profile updates cannot silently change a mobile number; support-assisted reverification is required. Existing eligibility, UAE/document restrictions, Veriff, IB, payments and trading behavior remain.

## Two-channel flow

Register -> verify email -> send/verify WhatsApp -> activate client -> existing Veriff journey. Before both required proofs, no client JWT, welcome email or sign_up conversion is issued. Each channel has a separate random six-digit code, HMAC, expiry and nonce. WhatsApp codes cannot equal the current email code. A random 256-bit registration continuation token is stored only as a SHA-256 digest; it is not a login JWT and expires with registration. New code hashes and registration state are hidden from model queries/JSON unless explicitly selected by the verification controller.

Each code expires after five minutes; the registration session expires after 15 minutes. Each channel permits five verification attempts total and at most three sends, with a 60-second resend cooldown. Attempt counters persist across resends, requests and restarts. Atomic reservations prevent parallel requests from multiplying sends. A resend invalidates the previous code. Atomic activation consumes registration once, so concurrent successful requests cannot issue a second welcome notification/session. An ambiguous delivery response never proves verification; a matching received code can still be checked.

A configured WhatsApp requirement comes from the server and cannot be disabled by a request body or an old frontend. A consent checkbox covers only the verification message, not marketing. Existing email-only and pre-release email challenges remain compatible during rollout. Email matching in login/password recovery accepts canonical case/whitespace variants.

Public routes (rate-limited where they create/check codes):

- GET /api/auth/registration-options
- POST /api/auth/register
- POST /api/auth/verify-otp
- POST /api/auth/registration/resend-email
- POST /api/auth/registration/send-mobile
- POST /api/auth/registration/verify-mobile

## Delivery configuration and activation

The repository's existing Teleobi adapter contract is retained, with bounded timeout, no redirects and generic responses that hide provider payloads and secrets. Its old hard-coded template ID is removed: it is not evidence of an approved BDFX authentication template. This release does not create a new subscription, register templates, send live test messages or change existing provider credentials.

Required existing-host secret settings:

- TELEOBI_API_TOKEN
- TELEOBI_PHONE_NUMBER_ID (the existing TELEOBO_NUMBER_ID spelling is also supported)
- TELEOBI_OTP_TEMPLATE_ID: the actual approved BDFX authentication template using the existing templateVariable-OTP-1 mapping
- REGISTRATION_WHATSAPP_OTP_ENABLED=true only after the real sender/template configuration is verified

The flag defaults off to preserve working email signup while missing delivery configuration is resolved. If enforcement is enabled but configuration is incomplete, registration fails closed; it never falls back to declaring an unverified phone valid. Startup logs expose only configured/unconfigured and enabled/disabled, never credentials or template bodies. Check those logs and the public options after deployment and record the observed state. Configuration presence is not proof of live WhatsApp delivery; that requires an authorized recipient and actual successful verification.

## Verification

Mocked integration checks cover email/phone normalization, legacy collisions, simultaneous same-email/same-phone attempts, both channel proofs, request-body bypasses, failed/ambiguous delivery, code/session expiry, token substitution, five-attempt limits, resend races and quotas, one-time activation, hidden hashes, connected index checks and existing email-mode compatibility. No real client, OTP, WhatsApp message, email, account or financial transaction is created by tests. Final deployment/delivery state belongs in the frontend continuation checkpoint.


## Production result — 21 October 2026

PR 9 is merged to main `e0546db9343a7bfbb2520215511d7e0833c7efcd`, tested tree `08dd0c2aad75be314c400c7762edd830298ff121`. Render `dep-dbc33fbm8hqs73bd74ag` is live. At 07:31 Dubai, startup reported that registration identity storage preflight passed, and **WhatsApp OTP unconfigured; enforcement disabled**. GET /api/auth/registration-options returns 200 with mobileOtpRequired:false, mobileOtpChannel:whatsapp and registrationAvailable:true. /health is 200/database connected; empty registration/mobile-verification bodies return 400 and anonymous users lists return 401. No real signup/message was generated by those probes. 125 backend tests pass, and the matching frontend release/build is live.

Duplicate-identity protection is deployed. Live WhatsApp delivery/phone possession remains an external configuration dependency; do not imply it is activated or that existing clients have verified mobiles. Preserve working email signup and never enable a broken mandatory challenge without the actual approved sender/template settings.
