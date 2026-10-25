# BDFX Buddy and n8n

The existing guided Buddy remains available. Optional free-text assistance is disabled unless its server configuration is complete and explicitly enabled. Website visitors separately opt in before a typed question is sent to n8n and its selected AI provider. Form values, browser tokens, contact records and existing saved-session capabilities are never forwarded. Obvious email/phone/code/wallet identifiers are rejected before egress; this is not a guarantee that all personal text can be detected. The input notice instructs visitors to keep account details out of questions.

## Chat connection

The website transport uses the backend's existing OpenAI provider configuration. No provider key is copied to n8n. Set the non-secret Render values `BDFX_BUDDY_N8N_TRANSPORT=ticket`, `BDFX_BUDDY_N8N_WEBHOOK_URL=https://n8n.srv2093676.hstgr.cloud/webhook/bdfx-buddy-v1` and, after publishing and controlled checks, `BDFX_BUDDY_N8N_ENABLED=true`. The existing `OPENAI_API_KEY` and `OPENAI_MODEL` remain server-side; the existing model default is gpt-5. No credentials, rates or gateway settings need to be changed.

For each explicitly consented question, the backend first atomically reserves capacity, then issues a signed, single-use, 30-second ticket bound to that question/language/FAQ index. A domain-separated HMAC derivative of the existing provider secret signs it; neither the provider secret nor signing key leaves the backend. The fixed n8n webhook forwards the ticket only to the fixed `/api/support-chat/n8n/complete` endpoint. That endpoint validates signature and expiry and atomically consumes its nonce before invoking the model. Fake, expired and replayed tickets cannot use the model. Neither endpoint reads customer account records. The workflow is publicly reachable, but reachability alone grants no model access; invalid calls still consume n8n workflow execution resources.

Provider calls have no tools or retained conversation history, request `store:false`, disable SDK retries and have an eight-second timeout and 1,000 generated-token ceiling. The public entry is limited to 12 requests per IP per 15 minutes and a durable shared cap of 200 reservations per UTC date. Failed or abandoned calls consume a reservation. The `buddy_ai_usage` collection stores only daily counters and spent random nonces with TTL expiry, never typed questions, replies, contacts or IPs. Storage failures fail closed. These are request/token bounds, not a guaranteed currency budget or a certification of provider retention. Provider processing uses the existing account's billing.

The alternative first-class n8n BDFX Buddy agent remains an unpublished draft until a saved model credential is configured. The old header-token transport is retained for that alternative; it requires a separately configured matching `X-BDFX-Buddy-Key`/`BDFX_BUDDY_N8N_TOKEN`. Never expose any provider or static key in public frontend variables or workflow parameters.

GET `/api/support-chat/n8n/options` reports readiness without exposing configuration. POST `/reply` requires explicit consent, a supported language and a bounded general question. Model output is plain text, cannot execute actions and must contain only approved website links. The public route is rate limited. The original guide is the fallback for missing configuration, timeouts or malformed replies.

## Interaction reporting

The separate n8n report workflow reads GET `/api/support-chat/n8n/report?days=7`. Allowed periods are 1, 7 or 30 Dubai dates through the check time. It requires a separate `X-BDFX-Report-Key` matching Render's `BDFX_N8N_REPORT_TOKEN`; the chat key cannot read reports. Configure n8n's BDFX Reports read-only templated credential with the matching secret.

Reports contain sessions started, sessions with activity, contact-request counts, support handoffs, topic selections, viewed-answer counts and event counts by language. Only unexpired, explicitly saved support sessions are included. Names, emails, phones, notes, capability tokens, free text and account/payment information are excluded. Sessions are not unique people; unsaved visitors and unsaved AI questions are not counted. A storage failure is unavailable, never a fabricated zero report.

The initial workflow is on demand. It creates no reporting schedule and sends no email/WhatsApp message. The owner can inspect reports inside n8n. Source of truth remains the existing BDFX support-session store and its consent/retention policy.

Keep n8n success/error execution payload saving and manual execution saving off for the chat flow. The separate report workflow stays unpublished until its scoped report credential is configured. Synthetic schema examples are not real customer reports. Publishing the website chat workflow does not activate that report or the alternative first-class agent.
