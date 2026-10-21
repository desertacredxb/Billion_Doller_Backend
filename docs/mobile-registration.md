# Email and WhatsApp registration verification

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
