# BDFX Groq operations chat

Owner correction, 4 November2026: use **Groq**, including its hosted OpenAI GPT-OSS model, for internal BDFX Reports questions. The earlier direct OpenAI provider was the wrong provider. Its credit_balance_exhausted result does not establish anything about Groq credits or identify the account email.

The existing internal question workflow retains its BDFX-only group and bot, private/other-group/bot/anonymous/stale-update rejection, current-member verification, delivery gate and receipt. Daily12:00/18:30 Asia/Dubai reports remain separate. Execution payload logs stay disabled. Customer Telegram OTP/Buddy/follow-ups remain deferred.

The protected business-assistant route reads fixed reports and cannot mutate customers, payments or SEO. It accepts a question up to1000 characters and optional earlier bot-reply context up to1500 characters. Its options response exposes provider/model/configuration metadata only.

The runtime accepts BDFX_TELEGRAM_GROQ_API_KEY or the BDFX service's GROQ_API_KEY; it never reads or falls back to OPENAI_API_KEY. BDFX_TELEGRAM_GROQ_MODEL defaults to openai/gpt-oss-20b. All inference calls use the fixed https://api.groq.com/openai/v1 endpoint. The OpenAI-compatible SDK is a client library, not an OpenAI billing connection. Do not reuse another company's saved Groq credential without the owner's direction identifying it. BDFX_TELEGRAM_AI_ENABLED=false disables AI; fixed commands continue.

Groq Chat Completions uses fixed allowlisted functions, a required initial tool call and application-side exact argument validation, bounded rounds, a1600-token completion budget, no automatic retries and a12-second provider timeout. Only the requested report output reaches the model, never database access or complete customer records. Source identity, topic, page, version and freshness are verified. Unsupported details are explained rather than invented. The independent durable60-request UTC-day cap uses the existing telegram-ops namespace; website Buddy is unaffected.

The /seo topic reads current worker/queue/recent-publication evidence without running the publisher or changing cadence. It is the finite six-guide weekly starter series. Publication does not certify Google indexing, ranking or traffic.

Before publishing normal-language AI routing: confirm a BDFX Groq key is configured, run a non-customer SEO question against Groq, verify the actual read-only tool call and timestamp, then check the same-group reply. Never call provider authentication/quota/rate errors a website outage. Keep /report, /pending and /seo working while setup is incomplete.
