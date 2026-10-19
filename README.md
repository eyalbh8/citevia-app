# Citevia app

A small AI visibility reporting application: **50 prompts per customer/project, scanned weekly through OpenAI**, with separate scanner and API Lambda deployments. Accounts onboarding creates a researched brandbook and prompts under Understand, Prefer, Trust and Convert, then starts tracking automatically. The client includes Dashboard, Prompts, Mentions, Sources, Brandbook and Settings. PostgreSQL uses iGEO's checked-in data model.

## Run locally

Requires Node.js 22.12+ (Node 24 also works).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on `127.0.0.1:3001`. Startup creates an empty persistent PostgreSQL database under `.local-data/real/`; no sample accounts, answers, brandbooks or scans are inserted. Previous sample stores are preserved separately and refused by the application. With no OpenAI credentials, the app opens but account generation and scans stay disabled.

Set `OPENAI_API_KEY` or `OPENAI_SECRET_ARN` in root `.env` and restart to enable real calls. Open **Accounts → New account** with an actual company website and context. Supply existing questions under Understand, Prefer, Trust and Convert, or generate all 50. Research → brandbook → prompts → first scan runs automatically. CSV/JSON import supports up to 25 accounts per request.

**Prompts** provides journey sections, search, topic/status/branded filters, editing, bulk addition, archive/reactivation, CSV export and visibility/rank/sentiment/citations from the selected real scan. Edits create versions; historical answers remain preserved and never become measurements of changed questions.

Read the [complete local setup and validation guide](docs/LOCAL_DEVELOPMENT.md), [onboarding/database mapping](docs/ONBOARDING.md) and [AWS deployment guide](docs/DEPLOYMENT.md). Local development needs no Docker or AWS account when using a direct OpenAI key. `npm run dev:live` is an alias for the same real-only environment. Tests use isolated fixtures that cannot run inside the application.

A small real-response validation command is ready for later:

```sh
npm run scan:spike -- --help
npm run scan:spike -- --prompts ./prompts.txt --brand "YOUR_ACTUAL_BRAND" --domain YOUR_ACTUAL_DOMAIN --count 3
```

This command makes real billable calls and saves native evidence; it does not supply example answers. Configure models your OpenAI project supports and inspect the results before production. No live provider validation or AWS deployment has been performed.

## Structure

- `apps/client`: React/Vite client, Cognito PKCE login, screens and answer drawer.
- `apps/api`: authenticated HTTP API, project settings and weekly schedule synchronization.
- `apps/scanner`: Responses API collection, native citations, structured extraction, job leases/retries and reconciliation.
- `packages/core`: shared contracts, validation, URL normalization and metric definitions.
- `packages/storage`: PostgreSQL/S3/SQS production adapters and local PostgreSQL.
- `database`: the unchanged iGEO Prisma reference, SQL baseline, workflow extensions and RDS certificate bundle.
- `infra`: AWS SAM/CloudFormation and deployment configuration.
- `scripts`: local environment, production bundle, account bootstrap and live feasibility check.

## Measurement

Collection requests web search and saves the original response before extraction. The answering request does not receive the tracked brand unless it is already in the saved question. A separate structured extraction request receives brand context and the saved answer, without tools. Extracted quotes and spans are checked against the answer. Native citations, repeated citation occurrences and retrieved-but-not-cited sources are retained separately.

Visibility is brand mentions divided by successfully analyzed answers. A valid answer without a mention is zero visibility; failed collection/extraction is missing measurement. Explicit recommendation rank and first-mention order are different fields. Sentiment is positive/neutral/negative/mixed/unknown, or N/A without a mention. Domain coverage counts distinct complete answers citing a domain, so it cannot exceed 100%. Every dashboard metric carries its denominator. Week-to-week changes use matching prompts and methodology.

These are **OpenAI API observations with web search**, not identical reproductions of personalized ChatGPT browser sessions. One observation per prompt per week is a sample, not a guaranteed ranking.

## Checks and deployment

```sh
npm run typecheck
npm test
npm run build
npm run bootstrap -- --help
```

`build` emits `dist/api/index.mjs`, `dist/scanner/index.mjs`, and `apps/client/dist/`. Deployment uses two Lambda functions, API Gateway, Cognito, private Aurora PostgreSQL, S3, SQS and EventBridge Scheduler. Amplify hosts the static client. See [deployment instructions](docs/DEPLOYMENT.md) for database migrations, AWS configuration and recovery.

No live AWS resources or provider calls are created by installation, tests or builds. Production credentials and account-specific deployment values must be supplied before deployment. The default schedule is Monday 06:00 in the project timezone; changing settings updates it through the API. The recovery schedule only resumes existing jobs and does not create extra weekly scans.

## API

The base path is `/v1`. `POST /onboarding/accounts` creates accounts; `GET /projects` lists the user's account summaries. Project endpoints include `/onboarding`, `/onboarding/retry`, `/brandbook`, `/dashboard`, `/runs`, `/responses`, `/responses/:responseId`, `/sources`, `/sources/:sourceId/responses`, `/settings` and `/prompts`. `GET /runtime` reports whether provider configuration is present; it does not test credentials or model access. Creation, manual scans and retries require an `Idempotency-Key`. Mutations require ownership. Raw evidence is never publicly hosted.

## Reliability and limits

The scanner snapshots active prompts and configuration, then dispatches one SQS job per prompt. Conditional leases and SQL transactions prevent duplicate accepted results/counters. A durable checkpoint lets parsing retries reuse the answer. There are four bounded processing attempts, a 24-hour AWS run deadline (three hours locally) and recovery every 15 minutes. Partial runs remain visible; old answers never fill failed weeks. At-least-once delivery cannot guarantee exactly-once provider billing after an ambiguous network failure.

PostgreSQL records and current evidence objects have no automatic deletion policy. Aurora retains 14 days of backups; S3 retains noncurrent versions for 30 days and logs for 14 days. The infrastructure encrypts storage and requires TLS. Billing, other AI providers, publishing and complex organization administration remain outside this MVP.
# citevia-app
