# BDFX Help saved sessions and admin reports

The owner asked where chatbot counts, conversations and visitor contact details can be reviewed because the original local FAQ guide had no reporting backend. This adds a separate, permission-based saved-session service to the existing backend and MongoDB connection. It does not enable the legacy OpenAI chat/history endpoints, WhatsApp messaging or a live-agent service.

## Customer behavior

Opening or using the guide does not create a record. The visitor can choose **Save session for support**; only subsequent fixed activity IDs are saved. An optional **Ask the team to contact me** form requires its own acknowledgement and starts a saved session if necessary. The form accepts a name, email, optional international phone and residence country using existing enquiry validation, including the UAE restriction. These details are self-reported, unverified and confer no account identity or marketing permission. No customer accounts, tickets, enquiries or email/WhatsApp messages are created by this reporting service.

Each saved session has a random UUID and independent 256-bit capability. Only the SHA-256 hash is stored. The capability stays in browser component memory, is sent only in `X-BDFX-Chat-Token` for its session writes, and never enters URLs, cookies, localStorage, administrator responses or logs. Its write authority expires after 24 hours. Public endpoints cannot read any saved session. The guide remains usable if reporting fails or the visitor declines saving.

The bounded embedded trail stores only open/close, language, topic, question ID, guide-link and contact-page actions. Search strings, arbitrary messages, page URLs, IP addresses and existing account tokens are not part of this record. A session holds at most 100 events; the admission filter and event-ID deduplication are atomic. Retries of creation, activity and contact writes do not create another session, another event or replace previously submitted contact details. Admin status/notes cannot alter contact identity or the activity trail.

## Administrator access

Frontend: **Admin panel -> Chat Reports**, `/chat-reports`.

Owners and managers with the existing **support** permission can review saved sessions, contact requests, Dubai date/language/status filters, activity in the last five minutes, selected questions/published guide answers and follow-up status/notes. Other managers, client sessions and anonymous readers are denied by the real administrator namespace and current stored permissions. The route is excluded from indexing. All report responses use `Cache-Control: no-store`.

Counts describe saved **sessions**, not unique people, verified accounts or the site's total traffic. “Active” means an activity was received during the last five minutes, not a persistent live connection. The list auto-refreshes every 30 seconds while visible. This is a guided menu activity trail, not an arbitrary free-text conversation or live-agent inbox. Anonymous visitors are labelled **Guest** unless they supply contact information. Earlier unsaved FAQ use cannot be recovered or backfilled.

## Storage and endpoints

`SupportChatSession`: unique `publicId`, hidden `secretHash`/`tokenExpiresAt`, bounded activity, optional embedded contact, status/notes, consent timestamps and a 90-day `expiresAt` TTL. Expired records are excluded from API reads even while MongoDB TTL deletion is pending. The expiry is based on initial saving, not refreshed by later activity/admin notes. First valid creation verifies the unique and TTL indexes, including when autoIndex is disabled. Storage failure does not create an unprotected record or interrupt payments/registration.

- POST `/api/support-chat/sessions`: explicit permission and idempotent client-generated credentials; 10 per IP/15 minutes.
- POST `/api/support-chat/sessions/:uuid/events`: session capability, fixed event schema; 180 per IP/15 minutes and 100 persisted events/session.
- POST `/api/support-chat/sessions/:uuid/contact`: capability, separate permission and validated optional follow-up details; 5 per IP/15 minutes.
- GET `/api/support-chat/admin/sessions`: authenticated support administrators, 25 rows/page and at most 90 report days.
- GET/PATCH `/api/support-chat/admin/sessions/:id`: protected detail or bounded status/note update. Updates use the existing administrator audit middleware.

No new provider, subscription, credential or login is required. The frontend privacy notice and all six in-widget consent/contact forms explain the storage boundary. Existing Veriff/country rules, WhatsApp OTP deployment flag, payment gateways and trading behavior remain untouched.

## Verification

Nine isolated tests exercise explicit permission, retry races, capability ownership/expiry, event limits, payload minimization, contact validation, date filters, redaction, team mutations and actual signed HTTP owner/support-manager access while rejecting other managers and clients. They use synthetic stores and do not write production data or send notifications. The complete backend suite has 134 passing tests. Production release evidence is recorded in the frontend continuation checkpoint after deployment.
