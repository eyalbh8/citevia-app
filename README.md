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

Set `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` and `GEMINI_API_KEY` (or their `*_SECRET_ARN` alternatives) in root `.env` and restart to enable real calls. OpenAI also creates brandbooks/prompts and analyzes every provider’s answers. After establishing the first system administrator, open **Accounts → New account** and enter only the brand name, region, language and website URL. The system researches the website, creates its brandbook and generates all 50 prompts: 13 Understand, 13 Prefer, 12 Trust and 12 Convert. Research → brandbook → prompts → first scan runs automatically. CSV/JSON import supports up to 25 accounts per request.

**Prompts** follows iGEO's table layout: search, usage, Manage Prompts, regions, intent/branded badges, visibility gauges, sentiment scores, ranks, percentage changes, created dates, SEO keywords and tags. Filter by region, tag, branding, intent, provider and the last 7/30/90 days; no topic column or topic filter is shown. Measurements are server-calculated period averages from saved answers, compared with the preceding equal-length period. Manage Prompts supports addition, editing, selection, archive/reactivation and CSV export. Edits create versions; historical answers remain preserved and never become measurements of changed questions.

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

## Structure

- `apps/client`: React/Vite client, Descope login, screens and answer drawer.
- `apps/api`: authenticated HTTP API, project settings and weekly schedule synchronization.
- `apps/scanner`: native OpenAI Responses, Perplexity Agent and Gemini API collection, native citations, structured extraction, job leases/retries and reconciliation.
- `packages/core`: shared contracts, validation, URL normalization and metric definitions.
- `packages/storage`: PostgreSQL/S3/SQS production adapters and local PostgreSQL.
- `database`: the unchanged iGEO Prisma reference, SQL baseline, workflow extensions and RDS certificate bundle.
- `infra`: AWS SAM/CloudFormation and deployment configuration.
- `scripts`: local environment, production bundle, account bootstrap and live feasibility check.

## Measurement

Collection requests web search and saves the original response before extraction. The answering request does not receive the tracked brand unless it is already in the saved question. A separate structured extraction request receives brand context and the saved answer, without tools. Extracted quotes and spans are checked against the answer. Native citations, repeated citation occurrences and retrieved-but-not-cited sources are retained separately.

Visibility is brand mentions divided by successfully analyzed answers. A valid answer without a mention is zero visibility; failed collection/extraction is missing measurement. Rank follows iGEO: the company’s position by first appearance among all identified companies, including untracked alternatives. Explicit numbered recommendation rank remains a separate field. Sentiment is scored from 0 to 100 using iGEO’s formula: positive 100, neutral/mixed 50, negative 0. Unknown or absent brands have a null score. The original sentiment label and exact evidence remain saved. Domain coverage counts distinct complete answers citing a domain, so it cannot exceed 100%. Every dashboard metric carries its denominator. Week-to-week changes use matching prompts and methodology.

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
