# Automatic SEO and blog publishing

The owner requested point 23, Auto SEO with blogs, and authorized completing work with existing access without new sign-in or approval prompts on 21 October 2026 (Dubai time).

## Behaviour

- The existing web service runs a small queue worker on startup and every five minutes. Its current Render plan is Standard with one instance; no new service, subscription, external AI call or credential is required.
- Six original evergreen educational guides are bundled in data/educationalBlogSeries.js. The first eligible article publishes on the initial successful run; subsequent publications are at least seven days apart. Remaining guides are drafts and cannot appear through the public blog endpoints or sitemap before publication.
- This is a finite starter series, not an unlimited AI/news generator. Administrators can add further original drafts using the existing editor and select **Add to weekly publishing queue**. The optional date is an earliest publication time, shown and parsed explicitly in Dubai time. Existing manually scheduled Published posts retain their separate scheduling behaviour.
- Blog administration shows the queue, next slot, last check, recent outcomes and pause/resume. Pausing stops the automatic queue, including future queued drafts. It does not hide articles already published or change manually scheduled Published posts. An in-progress publication can finish while a pause request is arriving.
- Saving fills empty SEO titles, descriptions, cover alt text and keyword fields. Filled editorial fields are retained. Administrators can preview missing-field suggestions and practical checks; these checks are not a Google ranking score. Structured data, contextual links and sitemap discovery are handled by the frontend.

## Storage and recovery

The worker uses the existing Blog collection and a singleton BlogAutomation state document. A full unique slug index is required; a missing index is created against connected storage. An incompatible index or duplicate legacy data stops this worker's work and records a generic failure without preventing the website from starting. Do not call Model.init() as a connection preflight.

Starter upserts use only $setOnInsert with stable slugs and disabled automatic update timestamps. Existing edited, manually authored and archived articles are never rewritten or re-enrolled by seeding. Automation keys and publication checkpoints cannot be set through blog request bodies.

Majority/journaled writes, a persistent lease and a reserved slug protect publication across concurrent workers and restarts. If publication succeeds but the cadence checkpoint fails, the next run reconciles the same reserved article before choosing another. Long downtime does not publish a backlog at once. The five-minute polling interval means the next slot is an approximate earliest time, not a guaranteed exact-minute publish time.

The bounded outcome history stores only dates, public slugs, outcomes and generic error codes. No customer data, credentials or external provider responses are retained. Setting AUTO_BLOGS_ENABLED=false in existing hosting settings is an additional stop switch; no new environment value is necessary for the authorized default workflow.

## Verification

Mocked tests cover repeated/concurrent workers, interrupted checkpoint recovery, pause/resume, cadence after long downtime, retained editorial content, slug collisions, hidden future drafts and index requirements. The signed-in journey integration test uses real JWT verification and middleware/controllers with synthetic local stores; it exercises onboarding, ticket/reply retries, ownership, manager permissions and revocation without real clients, OTPs, emails, accounts or payments. It does not certify a signed-in production browser session.

The frontend verifies Dubai date round-trips, public-only contextual links, publisher Organization markup and all pre-existing tests/build checks. Backend verification now passes 113/113 tests; frontend checks pass 21/21 and the production build including TypeScript passed. The first live article and publication results are recorded below. Search indexing and rankings are not guaranteed by publication or structured data.

The first rollout (main 0368c36, Render dep-dbc1nge7bikc73fi7t20) failed because the locally tested worker file was omitted from the staged Git release. The prior instance remained healthy. The packaging fix includes that file and adds a release test that traverses server requires against staged Git files, so an unstaged dependency cannot be mistaken for a deployable release. The replacement deployment `dep-dbc1qduq1p3s73bgsk5g` is live on main `800b6cb7af36c0d5ee442591e0756dd7aed5cc84` (tree `d8844fb74af9c6b91d6026663f697f2621645b72`). Do not redeploy the incomplete intermediate commit.

## Live verification — 21 October 2026

The worker logged publication of `forex-pips-points-and-pip-value` at `2026-10-21T02:03:08Z`; the article's stored publishedAt is `2026-10-21T02:03:07.587Z` (06:03 Dubai). The public list returns exactly one article. The other five starter guides stay queued as drafts; the public `margin-and-leverage-explained` route returns 404. Anonymous `/api/blogs/automation` returns 401 and `/health` returns 200 with the database connected. Public list and article rendering were checked in the production browser, including canonical, description, BlogPosting Organization author and contextual links. This does not certify the signed-in production admin panel.

The next automatic slot is no earlier than 28 October 2026 at 06:03 Dubai, subject to the worker check. Frontend cache responses can remain stale while revalidation finishes. Frontend PR 8 is live on main `2af2d0b` with successful Vercel deployment `5NVvLTaREycx5GvxCwFZXBbFZ7M8`. The exact BDFX social-card path is allowed through image optimization; its live endpoint returned 200 and the browser loaded the cover. The sitemap refresh is now 60 seconds; live XML includes 29 page URLs and one image URL, with the first guide present and future drafts absent. Google indexing remains unverified. See the frontend continuation checkpoint for current provider dependencies.

Sources checked for the educational series and structured data:

- https://www.metatrader5.com/en/terminal/help/trading/market_watch
- https://www.metatrader5.com/en/terminal/help/trading/performing_deals
- https://www.metatrader5.com/en/terminal/help/trading/orders
- https://www.metatrader5.com/en/terminal/help/startworking/interface
- https://developers.google.com/search/docs/appearance/structured-data/article
