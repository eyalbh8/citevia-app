# Citevia app

A small AI visibility reporting application: **50 prompts per customer/project, scanned weekly through the ChatGPT, Perplexity and Gemini APIs**, with separate scanner and API Lambda deployments. Accounts onboarding creates a researched brandbook and prompts under Understand, Prefer, Trust and Convert, then starts tracking automatically. The client includes Dashboard, Prompts, Mentions, Sources, Brandbook and Settings. PostgreSQL uses iGEO's checked-in data model.

## Run locally

Requires Node.js 22.12+ (Node 24 also works).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. Configure Descope in `.env` to sign in; without it the client shows its login configuration screen. Both local and AWS runs require real Descope sessions. See [user access and first-admin setup](docs/AUTHENTICATION.md). The API listens on `127.0.0.1:3001`. Startup creates an empty persistent PostgreSQL database under `.local-data/real/`; no sample accounts, answers, brandbooks or scans are inserted. Previous sample stores are preserved separately and refused by the application. With no provider credentials, the app opens but account generation and scans stay disabled.

Brand, competitor and citation logos use iGEO's Logo.dev domain lookup. Set the optional public `VITE_LOGO_DEV_API_KEY` (`pk_…`) in your local `.env` or client build environment. Missing logos fall back to Google favicons and initials. See [production logo configuration](docs/DEPLOYMENT.md#domain-logos).

Set `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` and `GEMINI_API_KEY` (or their `*_SECRET_ARN` alternatives) in root `.env` and restart to enable real calls. OpenAI also creates brandbooks/prompts and analyzes every provider’s answers. After establishing the first system administrator, open **Accounts → New account** and enter only the brand name, region, language and website URL. The system researches the website, creates its brandbook and generates all 50 prompts: 13 Understand, 13 Prefer, 12 Trust and 12 Convert. Research → brandbook → prompts → first scan runs automatically. CSV/JSON import supports up to 25 accounts per request.

Account setup also researches up to five direct competitors and their official websites, then assigns verified identities before the first scans. Owners can manage names, websites and aliases under **Settings → Tracked competitors**. Existing accounts can use **Find suggestions** to select alternatives already mentioned in saved answers; this lookup makes no AI calls. Scans assess sentiment with exact evidence for tracked competitors and other identified companies, so assigning a competitor later can include its saved sentiment as well as its historical mentions. Older answers without a sentiment assessment stay unknown until saved-answer reanalysis; reanalysis uses the current competitor list without collecting replacement answers. Manual choices, including an explicitly empty list, are preserved during setup.

**Prompts** follows iGEO's table layout: search, usage, Manage Prompts, regions, intent/branded badges, visibility gauges, sentiment scores, ranks, percentage changes, created dates and SEO keywords. Filter by region, branding, journey stage (Understand, Prefer, Trust, Convert), provider and date presets or a custom range. Measurements are server-calculated period averages from saved answers, compared with the preceding equal-length period. Manage Prompts supports addition, editing, selection, archive/reactivation and CSV export. Archiving requires confirmation and keeps every saved answer. Edits create versions; historical answers remain preserved and never become measurements of changed questions.

Click a prompt to open its paginated answer history across scans and providers, including previous prompt versions and collection failures. Filter by provider/date and sort by model, rank, citations, sentiment or date. Reanalysis of an existing capture is shown once at its original date. Each row opens the complete original answer, with Markdown rendered as headings, bold text, lists, links and tables; raw HTML is disabled. The original text remains unchanged in the database and evidence store. `GET /v1/projects/:id/prompts/:promptId/responses` serves this account-scoped history with `days=all|7|30|90`, `provider`, `sort`, `direction`, `limit` and `cursor` parameters.

Read the [complete local setup and validation guide](docs/LOCAL_DEVELOPMENT.md), [onboarding/database mapping](docs/ONBOARDING.md) and [AWS deployment guide](docs/DEPLOYMENT.md). Local development needs no Docker or AWS account when using direct provider keys. `npm run dev:live` is an alias for the same real-only environment. Tests use isolated fixtures that cannot run inside the application.

A small real-response validation command is ready for later:

```sh
npm run scan:spike -- --help
npm run scan:spike -- --provider gemini --prompts ./prompts.txt --brand "YOUR_ACTUAL_BRAND" --domain YOUR_ACTUAL_DOMAIN --count 3
```

This command makes real billable calls and saves native evidence; it does not supply example answers. Configure models/presets your provider accounts support and inspect the results before production. No live provider validation or AWS deployment has been performed.

## Users and account access

Descope verifies login. Real verified names, emails and stable provider identities are saved in the iGEO-compatible `users` table and `citevia_identities`; `user_accounts` stores explicit Viewer/Owner assignments. `users.is_system_admin` grants access to every account. Every new user starts with no accounts and no admin role. Only system admins create accounts and manage access in **Users**. Account owners manage their assigned accounts; viewers read results. No shared development token or client-supplied role grants access.

The first administrator is established explicitly after their first Descope sign-in with `npm run admin:bootstrap`. Subsequent administrators and assignments are managed in the UI. See [configuration, bootstrap and permissions](docs/AUTHENTICATION.md).

## MCP connections

Open **MCP connections** to connect an assistant through OAuth or a named API key. Creating a key also shows a copyable URL-only connection and Claude/ChatGPT setup buttons. System administrators use one connection for all accounts; other users connect one assigned account at a time. Viewer connections are read-only and owner connections retain the account's existing permissions. Credentials support expiry and immediate revocation. See [connection setup, tools and deployment](docs/MCP.md). Apply migration `006_mcp.sql` before publishing this update.

## AI Traffic

Open **AI Traffic** to measure page visits referred by ChatGPT, Claude, Perplexity, Gemini, Copilot and DeepSeek. The screen includes provider totals and change versus the preceding period, a zero-filled UTC trend chart, provider/region/date filters, CSV export, and independently paginated sources, pages, countries, devices and browsers. These are received page visits, not unique visitors or citation counts. A zero baseline with new traffic is labeled **New**.

In **AI Traffic → Settings**, copy the account-specific script into the website’s `<head>` or a custom HTML tag in your tag manager, and publish it on all relevant pages. **Test connection** opens the configured website with an AI UTM tag and a fresh test ID, then checks for that exact event for up to 20 seconds. The test website URL is editable and defaults to the most recently detected site. Test events appear in connection status but are excluded from every report and comparison. No account data is seeded. Historical events in a different database are not imported automatically.

Installation detection uses `citevia_traffic_installations`, with first/last receipt times per account and origin. A separate `INSTALLATION` test receipt verifies the exact test ID without counting it as an AI visit. Existing script snippets receive updated tracker code from the same URL; site code does not need to be republished.

The public API serves `GET /v1/traffic/tracker.js` and accepts `POST /v1/traffic/collect`; the script derives its collector URL from its deployed script URL. Collection uses a simple cross-origin request with no cookies or preflight, so customer sites do not need to be added to the authenticated API’s CORS allowlist. The collector checks that the browser Origin matches the page URL, validates payload size, classifies supported referral hosts/UTM sources on the server, ignores crawler UAs and deduplicates event UUIDs. Per-account collection is limited to 3,000 accepted requests per minute, in addition to the API Gateway limits. As with other public browser analytics, Origin checks prevent accidental cross-account collection; they are not proof of a human visit.

Authenticated members can read `GET /v1/projects/:id/traffic` and `/traffic/status`; other accounts remain inaccessible. PostgreSQL aggregates directly from the existing `analytics_events` table using the project’s native iGEO account ID. Existing `USER` events with recognized AI referrer hosts are included; legacy crawler events are excluded. Countries come from a bundled offline lookup using API Gateway’s peer IP, never a client-supplied country or forwarding header. The collector stores the country but not the IP, strips URL query strings/fragments and referrer paths, and uses no cookies. Unknown locations are retained as **Unknown location**. Country lookup includes [GeoLite2 data from MaxMind](https://www.maxmind.com); the dependency’s license and EULA are included in the API artifact. Refresh the bundled country data by upgrading `geoip-country` and rebuilding. The patched `ip-address` override affects its optional updater dependency; the deployed lookup runtime bundles only the modules it uses.

**Deployment:** apply `007_ai_traffic.sql` and `008_traffic_installations.sql` after the existing migrations before publishing the API/client. The local development server applies it automatically. Then install the generated snippet on the actual customer website to start receiving visits. The frontend’s `VITE_API_URL` must identify the public deployed API. Sites with a Content Security Policy must allow that API in `script-src` and `connect-src`; use the site’s consent setup where required. The tracker sends a lightweight installation signal on all visits, independently of AI attribution and the account’s brandbook domains. Settings lists the actual detected sites and lets you test any installation URL. These signals do not enter the AI totals. The tracker measures supported AI referrer/UTM visits and SPA history navigation; it does not measure AI crawlers, untagged direct visits, conversions or historical clicks from scan citations.

## Structure

- `apps/client`: React/Vite client, Descope login, screens and answer drawer.
- `apps/api`: authenticated HTTP API, project settings and weekly schedule synchronization.
- `apps/scanner`: native OpenAI Responses, Perplexity Agent and Gemini API collection, native citations, structured extraction, job leases/retries and reconciliation.
- `packages/core`: shared contracts, validation, URL normalization and metric definitions.
- `packages/storage`: PostgreSQL/S3/SQS production adapters and local PostgreSQL.
- `database`: the unchanged iGEO Prisma reference, SQL baseline, workflow extensions and RDS certificate bundle.
- `infra`: AWS SAM/CloudFormation and deployment configuration.
- `scripts`: local environment, production bundle, account bootstrap and live feasibility check.

The client uses TanStack React Query for an in-memory cache, following iGEO's navigation caching pattern. `useApi` keys include the signed-in user and the full API path (account, filters and pagination). Revisiting a page reuses cached data; unused entries expire after 30 minutes and signing out clears that user's cache. Writes invalidate related entries, including inactive filter variants. Manual refresh, window focus, the existing one-minute refresh and five-second active-scan polling update data in the background while keeping loaded content visible. New reads should use `useApi`, and writes should use `request` or `idempotentPost` so invalidation is applied consistently.

## Measurement

Collection requests web search and saves the original response before extraction. The answering request does not receive the tracked brand unless it is already in the saved question. A separate structured extraction request receives brand context and the saved answer, without tools. Extracted quotes and spans are checked against the answer. Native citations, repeated citation occurrences and retrieved-but-not-cited sources are retained separately.

Visibility is brand mentions divided by successfully analyzed answers. A valid answer without a mention is zero visibility; failed collection/extraction is missing measurement. Rank follows iGEO: the company’s position by first appearance among all identified companies, including untracked alternatives. Explicit numbered recommendation rank remains a separate field. Sentiment is scored from 0 to 100 using iGEO’s formula: positive 100, neutral/mixed 50, negative 0. Unknown or absent brands have a null score. The original sentiment label and exact evidence remain saved. Domain coverage counts distinct complete answers citing a domain, so it cannot exceed 100%. Every dashboard metric carries its denominator. Week-to-week changes use matching prompts and methodology.

Dashboard ranking sentiment averages classified mentions across the selected period for both your brand and competitors. Provider, region, branding and journey-stage filters apply to the same saved answers used by counts, rankings, trends, sentiment and sources. Change percentages include observed days with zero mentions; days without observations are not invented. Active-prompt stage visibility only counts answers for the current question text and version. Dashboard, Prompts and Mentions share UTC date-preset boundaries, with the last 24 hours treated as a rolling window.

These are **native API observations with search enabled**, not identical reproductions of personalized consumer chat sessions. Each provider has separate runs, citations, dashboard trends and comparison baselines. One observation per prompt per provider per week is a sample, not a guaranteed ranking.

## Checks and deployment

```sh
npm run typecheck
npm test
npm run build
npm run bootstrap -- --help
```

`build` emits `dist/api/index.mjs`, `dist/scanner/index.mjs`, and `apps/client/dist/`. Deployment uses two Lambda functions, API Gateway, Descope authentication, private Aurora PostgreSQL, S3, SQS and EventBridge Scheduler. Amplify hosts the static client. See [deployment instructions](docs/DEPLOYMENT.md) for database migrations, AWS configuration and recovery.

No live AWS resources or provider calls are created by installation, tests or builds. Production credentials and account-specific deployment values must be supplied before deployment. New accounts default to Monday 06:00 UTC; changing settings updates it through the API. The recovery schedule only resumes existing jobs and does not create extra weekly scans.

## API

The base path is `/v1`. `POST /onboarding/accounts` creates accounts; `GET /projects` lists the user's account summaries. Project endpoints include `/onboarding`, `/onboarding/retry`, `/brandbook`, `/dashboard`, `/runs`, `/responses`, `/responses/:responseId`, `/sources`, `/sources/:sourceId/responses`, `/settings` and `/prompts`. `GET /me` returns the saved user. `/admin/users` and user account-assignment endpoints require a system administrator. `GET /runtime` reports whether provider configuration is present; it does not test credentials or model access. Creation, manual scans and retries require an `Idempotency-Key`. Mutations require ownership. Raw evidence is never publicly hosted.

## Reliability and limits

The scanner snapshots active prompts and configuration, then dispatches one SQS job per prompt. Conditional leases and SQL transactions prevent duplicate accepted results/counters. A durable checkpoint lets parsing retries reuse the answer. There are four bounded processing attempts, a 24-hour AWS run deadline (three hours locally) and recovery every 15 minutes. Partial runs remain visible; old answers never fill failed weeks. At-least-once delivery cannot guarantee exactly-once provider billing after an ambiguous network failure.

PostgreSQL records and current evidence objects have no automatic deletion policy. Aurora retains 14 days of backups; S3 retains noncurrent versions for 30 days and logs for 14 days. The infrastructure encrypts storage and requires TLS. Billing, other AI providers, publishing and complex organization administration remain outside this MVP.

# citevia-app

## Three-provider scans

New accounts enable ChatGPT, Perplexity and Gemini: the same 50 prompts yield up to 150 answers per week, plus analysis calls. Existing accounts keep their current OpenAI workload until an owner enables additional providers in **Settings → Scan providers**. Change the **AI provider** selector to view Dashboard, Mentions and Sources for that provider. Prompts has its own **Providers** and date filters and defaults to all providers. **Run scan** scans all enabled providers. See [provider configuration, API behavior and native evidence](docs/PROVIDERS.md).
