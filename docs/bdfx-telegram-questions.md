# BDFX Telegram report questions

The owner requested interactive replies in the existing **BDFX Reports** group on 1 November 2026. The separate twice-daily report schedule remains unchanged.

The dedicated `@BDFXAccountsReportBot` accepts text questions and `/help`, `/pending`, `/pending 2`, `/report`, `/deposits`, `/withdrawals`, `/clients`, `/kyc` and `/buddy`. For example, **payout pending kiska hai?** selects the current pending/processing withdrawal queue. It returns up to ten requests per page, oldest first, with client name, MT5 account reference, amount in its original currency/asset, status, request date in Dubai and request reference. It does not sum mixed currencies or treat a request as settlement.

`GET /api/support-chat/n8n/business-query?topic=pending_withdrawals&page=1` uses the existing encrypted `X-BDFX-Business-Report-Key` credential. This key now covers both the unchanged aggregate business report and the fixed read-only Telegram reporting topics. It cannot authorize chat reports, payment approval or any customer mutation. Unknown parameters, free-form database queries, invalid pages and wrong keys fail before reads. Source errors are redacted and never represented as zero.

The n8n question workflow must restrict the native Telegram trigger to group `-1003981563127`, reject bot/anonymous/stale messages, verify the exact group identity and the requester's current membership before fetching data, and send only back to that same group as a reply to the original message. It uses BDFX's dedicated Telegram credential. Other-company groups, private chats and other bots are excluded. The user chose this existing group as the reporting audience; group membership controls who receives these replies.

Only the projected report fields are returned. Bank account details, wallet addresses, contact details, OTPs, credentials, KYC documents and transcripts are excluded. Replies are deterministic reads of the live backend, without sending records to a language model. Source freshness, response topic/page and HTML escaping are checked before delivery. Keep query execution input/output logging disabled because the replies contain client financial details. A delivery gate and verified receipt track processed message IDs without retaining the reply text in workflow static data.

The native Telegram trigger receives message updates. This bot already has group admin status, so natural text is available without changing privacy settings. Telegram allows one webhook per bot: never activate a second inbound workflow for this dedicated bot or run a test listener while its production trigger is active. The daily outgoing report workflow does not own a Telegram webhook.

Manual preview must use `help` and stop before sending. Final verification should use a real group message and check a reply from `@BDFXAccountsReportBot` to that exact message. This feature reads reports; it does not approve, reject or execute payouts.
