# Run Citevia locally

Run all commands from the `citevia-app` repository root. Requires Node.js 22.12+ and npm; Node.js 24 is also supported. No Docker, AWS account or hosted database is needed for local development with direct provider keys.

## Install and start

```sh
cd /path/to/citevia-app
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens at **http://127.0.0.1:3001**; Vite proxies `/api/v1` to it. Keep this command running and use Ctrl+C to stop the client, API, background worker and database together. Run one instance per data directory. `npm run dev:live` is an alias for the same real-only environment.

The first startup applies the same SQL migrations used on AWS to embedded PostgreSQL (PGlite). Database files persist at `.local-data/real/postgres/`; original answers, generation receipts and analysis persist at `.local-data/real/artifacts/`. Stop the application before backing up the whole `.local-data/real/` directory. Restarting preserves accounts and results. Nothing is seeded, generated or imported at startup. Old demo/JSON directories are preserved separately and are never automatically imported; stores marked with legacy synthetic observations are refused.

After configuring Descope, signing in and establishing your first administrator, the interface opens with no accounts if no customers have been created. With no OpenAI credentials it explains that generation and scans are disabled. It does not create a placeholder account, simulated brandbook, answer or citation. Unit-test fixtures live only under tests and are never loaded by the application.

Local authentication uses Descope, exactly as the deployed API does. Configure `DESCOPE_PROJECT_ID`, `DESCOPE_FLOW_ID`, `DESCOPE_BASE_URL` and the server-only `DESCOPE_MANAGEMENT_KEY` (or `DESCOPE_SECRET_ARN`) in root `.env`. The dev script passes only public Descope values to Vite. Register `http://127.0.0.1:5173` as an allowed origin/redirect in your Descope project, publish the chosen flow, then restart and sign in. Without Descope configuration, the client displays setup instructions and the API denies access; no development token is accepted.

Website Health has independent Google credentials: set `GOOGLE_PAGESPEED_API_KEY` and optionally `GOOGLE_CRUX_API_KEY` in root `.env` after enabling PageSpeed Insights API and Chrome UX Report API in Google Cloud. The same API-restricted key can be used for both variables. `GOOGLE_PAGESPEED_SECRET_ARN` and `GOOGLE_CRUX_SECRET_ARN` are the Secrets Manager alternatives (raw values or JSON with the corresponding `*_API_KEY` field). Restart the local server after configuration changes. No `VITE_*` key is needed. Website audits can run without AI-provider keys; authentication still applies.

On first sign-in the real user is saved with no accounts and no admin role. Copy the database user ID shown in the workspace, stop the local server, then establish your first administrator:

```sh
npm run admin:bootstrap -- --local --user-id YOUR_DATABASE_USER_UUID
npm run dev
```

Open **Users** to assign customers as Viewer or Owner, or grant additional system administrators. The bootstrap command requires an already saved Descope identity and closes once an administrator exists. See [authentication and permissions](AUTHENTICATION.md). Local records remain separate from AWS records.

## Configure providers and onboard a real account

**Mentions** shows the selected period's saved answers, provider counts and trends. **Tracking → Track results** registers a URL for each subsequent scan's native-citation matching. Its detail drawer links to the original matching answers. Owners can pause/resume tracking; viewers can inspect it. Repeated finalization or reanalysis does not increase counts. Lift, crawler events and AI clicks stay unavailable without their respective data sources. See [tracking metrics, schema and historical replay](MENTIONS_AND_URL_TRACKING_PLAN.md#implemented-behavior-and-operational-notes).

Edit the root `.env` and set `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` and `GEMINI_API_KEY` to real provider keys. OpenAI remains required for onboarding and answer analysis. Alternatively use `OPENAI_SECRET_ARN`, `PERPLEXITY_SECRET_ARN` and `GEMINI_SECRET_ARN`; that requires an AWS identity permitted to read the secret and its region. The secret can contain the raw key or JSON with the matching `*_API_KEY` property. Do not use a `VITE_*` variable for any secret. Restart `npm run dev` after changing `.env`.

The model settings are `OPENAI_ONBOARDING_MODEL`, `OPENAI_GENERATION_MODEL`, `OPENAI_EXTRACTION_MODEL`, `PERPLEXITY_PRESET` and `GEMINI_GENERATION_MODEL`. The checked-in defaults are compatibility candidates, not evidence of model access or output quality in your provider accounts. Configure models your project can access and validate them before production. A configured key enables requests; it does not prove the key, billing or model entitlement is valid.

1. As a system administrator, open **Accounts → New account** and enter only the actual brand name, region, language and website URL. Region uses a two-letter country/region code (US, GB, etc.); language uses a code such as en or en-GB.
2. No manual prompts or company notes are required. Citevia generates 13 Understand, 13 Prefer, 12 Trust and 12 Convert prompts. Bulk CSV/JSON imports accept only name, region, language and website, up to 25 accounts per request. The CSV download contains those four headers only.
3. Submit. The worker performs real web research, generates an evidenced brandbook, completes the prompt portfolio to 50, saves everything and starts the first scan on each enabled provider. This makes billable provider and OpenAI analysis calls. Track each stage in Accounts; inspect failure details and retry there after correcting credentials, balance or rate limits.
4. Open **Brandbook** to inspect researched facts, sources and unknowns. Open **Prompts** to search/filter, edit questions, archive/reactivate and export selected rows. Use the status filter to find archived prompts; bulk actions appear after selecting rows. Only 50 prompts may be active. Saving edits creates a new version and preserves historical answers.
5. Use **Dashboard**, **Mentions** and **Sources** for the resulting measurements and native evidence. The Prompts screen shows the selected scan's single observation per unchanged prompt; missing/failed analysis remains blank. Older versions remain available in Mentions. **Run scan** collects new answers after edits.

The local worker automatically runs onboarding, its first scan and recovery of existing jobs. New accounts use Monday 06:00 UTC. Change the timezone later in Settings if needed; AWS EventBridge Scheduler follows that setting. Local development does not register AWS schedules or simulate elapsed weeks; use **Run scan** for additional local snapshots. Keep the process running while work completes; persisted work resumes through recovery after restart with credentials configured.

## Validate real responses later

Prepare a UTF-8 text file with actual questions, one per line. The validation command makes up to ten real collection calls plus analysis calls, never substitutes fixtures and saves a report/native evidence beneath `.local-data/spike/`.

```sh
npm run scan:spike -- --help
npm run scan:spike -- --prompts ./prompts.txt --brand "YOUR_ACTUAL_BRAND" --domain YOUR_ACTUAL_DOMAIN --count 3
```

Inspect the saved answer text, native citations, brand detection, explicit ranks, sentiment evidence, failures and observed API usage before enabling many accounts. The command exits nonzero if any selected prompt fails analysis. It does not automatically retry billable requests. This validation is prepared for later; no key or live provider call is required to install, test or build.

## Verify and troubleshoot

```sh
npm run typecheck
npm test
npm run build
```

These checks use isolated test fixtures and create no application accounts or API calls. Build outputs are `dist/api/`, `dist/scanner/` and `apps/client/dist/`. Production builds do not start servers or provision AWS.

- **OpenAI not configured:** edit root `.env`, then restart. Configure only the key or ARN you intend Citevia to use; no iGEO credentials are copied.
- **Account setup/scan fails:** inspect the actual error in Accounts or the answer drawer and the terminal. Verify billing, model access and rate limits, then retry. Missing answers are never filled with sample results.
- **Port already in use:** stop the existing Citevia process before restarting. The API binds port 3001 before opening its database; Vite uses port 5173.
- **Old project selection in the browser:** open Accounts and select an actual account. Browser storage can retain a former project ID, but cannot import its old data.
- **Need an independent workspace:** set `LOCAL_DATA_DIR=.local-data/another-real-workspace` in `.env` before restarting. This creates a separate empty store; it does not delete or reset existing data.

See [AWS deployment](DEPLOYMENT.md) for the two Lambdas, private Aurora database, queue, weekly schedules, Descope and client hosting, and [onboarding/database mapping](ONBOARDING.md) for storage details.

## Provider validation

See [PROVIDERS.md](PROVIDERS.md) for one-provider-at-a-time live validation commands. Each invocation makes at most ten paid collection and ten OpenAI analysis calls. Tests remain isolated; runtime never substitutes sample responses. New accounts enable all three providers, while existing accounts opt in through Settings. No local weekly timer is registered; onboarding and manual scans execute through the local worker. AWS registers weekly schedules.

Onboarding model failures now stop after one attempt. Accounts offers **Stop setup** for running work and **Retry setup** for an explicit retry from saved progress. A request already in flight may finish, but no later stage starts after Stop. Research evidence is selected by ID and copied by the server to prevent quote-paraphrasing failures. See [onboarding stop/recovery](ONBOARDING.md).
