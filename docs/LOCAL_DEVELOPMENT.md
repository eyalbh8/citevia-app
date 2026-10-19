# Run Citevia locally

Run all commands from the `citevia-app` repository root. Requires Node.js 22.12+ and npm; Node.js 24 is also supported. No Docker, AWS account or hosted database is needed for local development with a direct OpenAI key.

## Install and start

```sh
cd /path/to/citevia-app
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens at **http://127.0.0.1:3001**; Vite proxies `/api/v1` to it. Keep this command running and use Ctrl+C to stop the client, API, background worker and database together. Run one instance per data directory. `npm run dev:live` is an alias for the same real-only environment.

The first startup applies the same SQL migrations used on AWS to embedded PostgreSQL (PGlite). Database files persist at `.local-data/real/postgres/`; original answers, generation receipts and analysis persist at `.local-data/real/artifacts/`. Stop the application before backing up the whole `.local-data/real/` directory. Restarting preserves accounts and results. Nothing is seeded, generated or imported at startup. Old demo/JSON directories are preserved separately and are never automatically imported; stores marked with legacy synthetic observations are refused.

With no OpenAI credentials, the interface opens with no accounts and explains that generation and scans are disabled. It does not create a placeholder account, simulated brandbook, answer or citation. Unit-test fixtures live only under tests and are never loaded by the application.

Local authentication uses a development-only owner identity and is restricted to the loopback server. Use AWS/Cognito for shared or hosted access. Local records are separate from AWS records, and the development token cannot access the deployed API.

## Configure OpenAI and onboard a real account

Edit the root `.env` in your editor and set `OPENAI_API_KEY` to your OpenAI project key. Alternatively set `OPENAI_SECRET_ARN`; that requires an AWS identity permitted to read the secret and its region. The secret can contain the raw key or JSON with an `OPENAI_API_KEY` property. Do not use a `VITE_*` variable for any secret. Restart `npm run dev` after changing `.env`.

The model settings are `OPENAI_ONBOARDING_MODEL`, `OPENAI_GENERATION_MODEL` and `OPENAI_EXTRACTION_MODEL`. The checked-in defaults are compatibility candidates, not evidence of model access or output quality in your OpenAI project. Configure models your project can access and validate them before production. A configured key enables requests; it does not prove the key, billing or model entitlement is valid.

1. Open **Accounts → New account** and enter the actual company name, official website, market, language, timezone and useful company context.
2. Supply existing prompts in Understand, Prefer, Trust and Convert, or leave the sections empty to generate all 50. For multiple accounts, use CSV/JSON import, up to 25 accounts per request. The CSV download contains column headers only; fill it with real accounts.
3. Submit. The worker performs real web research, generates an evidenced brandbook, completes the prompt portfolio to 50, saves everything and starts the first scan. This makes billable OpenAI calls. Track each stage in Accounts; inspect failure details and retry there after correcting credentials, balance or rate limits.
4. Open **Brandbook** to inspect researched facts, sources and unknowns. Open **Prompts** to inspect the four sections, search/filter by topic/status/branded, edit questions, add several at once, archive/reactivate and export. Only 50 prompts may be active. Saving edits creates a new version and preserves historical answers.
5. Use **Dashboard**, **Mentions** and **Sources** for the resulting measurements and native evidence. The Prompts screen shows the selected scan's single observation per unchanged prompt; missing/failed analysis remains blank. Older versions remain available in Mentions. **Run scan** collects new answers after edits.

The local worker automatically runs onboarding, its first scan and recovery of existing jobs. AWS EventBridge Scheduler supplies the weekly Monday 06:00 kickoffs in each account's timezone. Local development does not register AWS schedules or simulate elapsed weeks; use **Run scan** for additional local snapshots. Keep the process running while work completes; persisted work resumes through recovery after restart with credentials configured.

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

See [AWS deployment](DEPLOYMENT.md) for the two Lambdas, private Aurora database, queue, weekly schedules, Cognito and client hosting, and [onboarding/database mapping](ONBOARDING.md) for storage details.
