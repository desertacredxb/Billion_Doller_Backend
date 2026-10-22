# Website Analytics in BDFX Admin

The owner requested the GA4 dashboard inside the existing admin panel on 21 October 2026. The new `/website-analytics` section uses `GET /api/analytics/report?days=7|28|90`. Both the server and admin navigation require the owner role. A manager's reports permission does not include this new section. The owner explicitly requires no separate login: the panel uses the existing BDFX owner session, without a Google sign-in button, iframe or forced external redirect. The Google credential is a one-time server configuration, not an additional human login.

The report shows period users, sessions, page views, lead/signup event counts, current 30-minute active users, daily page views, top allowlisted public paths and traffic channel groups. Users are taken from Google's period total, never summed from daily users. Lead/signup events are not presented as unique customers, sales or verified payments. Report dates use the existing Dubai reporting timezone. Google processing delay and privacy thresholds can affect results.

## Secure reporting connection still required

The existing browser's Google login and public measurement ID do not authorize a backend to read Google Analytics reports. No service account, private key or new Google permission has been created in this change. Missing configuration returns `connected:false` without numeric cards. Provider/authentication failures return a redacted 503, never a fabricated zero report.

After the owner specifically approves the new reporting identity/access:

1. In an existing verified Google Cloud project (or a separately approved BDFX reporting project), enable the Google Analytics Data API. No billing plan, paid hosting or replacement infrastructure is required by this implementation.
2. Create a dedicated BDFX reporting service account without Google Cloud project roles or domain-wide delegation. Give it **Viewer** access to BDFX property **559982387** only, not the whole Analytics account or unrelated CFT properties. Do not send an invitation/notification email during setup.
3. Use the existing Render secret manager to set **GA4_REPORTING_CREDENTIALS_JSON** to that service account's JSON credentials. Keep `replace:false` when using the environment tool. Never put this secret under NEXT_PUBLIC_, in Git, a URL, a screenshot or chat. Existing Render env changes can trigger a config deployment; avoid an extra manual deployment.
4. Verify the owner's live admin report, Google API responses, non-owner denial and cache behavior. Confirm the first normal consented lead/signup event without creating fake customer records. Remove downloaded secret copies securely after storage.

The reporting identity is a new persistent credential with read access to website telemetry, so browser action-time confirmation is required before creating/granting it. Broad earlier “finish everything” instructions are not substituted for that specific confirmation. The user should review the implemented endpoint/page before this final connection step.

## Implementation and limits

The official `@google-analytics/data` SDK requests only `https://www.googleapis.com/auth/analytics.readonly`. The property is fixed to 559982387 in server code. Caller-supplied property IDs, report definitions and date values are rejected. Credential fields other than type/client_email/private_key are ignored; there is no caller-supplied endpoint, impersonated user, Measurement Protocol secret or browser token extraction.

Independent fixed reports run in parallel with 8-second call timeouts. The current snapshot is cached for 60 seconds, concurrent refreshes are coalesced, and failed requests are not cached as successes. The cache is bounded and memory-only, clears on connection changes and does not expose raw provider objects. HTTP responses are no-store. Only public path allowlist values and aggregate numeric metrics are returned; there are no raw referrers, URL queries, identities, country/city details, customer records or monetary totals. The admin browser refreshes every minute while visible and cancels its request on navigation/period changes.

Reporting failures now return an allowlisted `GA4_*` diagnostic code and fixed explanation to the authenticated owner. The server logs the fixed diagnostic code and allowlisted report-structure labels on validation failures, never provider messages, stack traces, credentials, HTTP headers, raw bodies, report values or account details. Disabled API, property access, credential/authentication, timeout, quota, request and response errors can be distinguished without exposing Google's raw error. Malformed credential JSON uses the same redacted path. This instrumentation is not evidence that a live Google report succeeded.

When credentials are configured, server startup also runs the same fixed seven-day report once in the background. It logs `[website-analytics] READY` only after all six read-only Google report calls and response validation succeed, or a fixed failure code. It skips unconfigured servers, never prints aggregate report values, exposes no public diagnostic endpoint, and does not block startup or other APIs. A READY entry verifies Google's connection, not the owner's full browser flow.

Live connection debugging on 22 October found a valid realtime response with `rowCount: 0` and empty rows/dimension/metric headers. The parser previously rejected its missing metric name, which blocked historical reports whenever the realtime report had this zero-activity shape. Realtime parsing now accepts that explicit complete zero-row shape and displays zero current users while keeping historical totals. Missing fields, inconsistent row counts, nonempty rows without headers, provider failures and standard-report validation failures still produce errors. Regression tests reproduce the observed empty shape and reject incomplete lookalikes.

Validation uses synthetic SDK responses and actual HTTP middleware with locally signed test sessions. It covers anonymous/client/manager/stale-session denial, owner-only access, invalid/foreign-property query rejection, no-store, distinct-period totals, Dubai dates, public-path filtering, missing configuration, deduplication, expiry and provider-error redaction. No live Google reporting call, customer record, OTP, email, chat, trade or payment is generated by these checks.

References: https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart and https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-basics .

Validation checkpoint: 143 backend tests, 28 frontend tests and the frontend production build/TypeScript (75 routes) pass. Provider tests are synthetic. The owner reiterated that no separate human login should be required; the existing BDFX administrator session is retained. Google reporting activation and a signed-in production data view remain unverified until that read-only server connection exists.
