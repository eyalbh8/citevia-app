# Account onboarding and iGEO database compatibility

## Implemented flow

An authenticated operator opens **Accounts → New account**, supplies a name, official website, market, language, timezone and optional company context. Existing prompts can be pasted into Understand, Prefer, Trust and Convert sections. Bulk import accepts CSV or JSON, up to 25 accounts per request. The CSV template is downloadable in the form. Each created account is owned by its creator; a different user's account IDs do not grant access.

The system persists the account, membership and onboarding job atomically, with weekly scanning disabled. It then queues these steps:

1. **Research:** OpenAI Responses with web search researches the company and saves the native response and sources.
2. **Brandbook:** a separate strict JSON generation creates the iGEO-style company profile from that research. Evidence quotations must occur verbatim in the research, and URLs must occur in its native sources. Missing facts remain empty/null and appear under Needs verification.
3. **Prompts:** a separate strict JSON generation preserves every supplied prompt and fills the remaining places to exactly 50. Each prompt has a journey section, topic, branded flag, generation ID and version.
4. **Activate:** save the brandbook and validated portfolio, enable the weekly schedule in the account's timezone, and enqueue an idempotent first scan. The Accounts screen shows progress and recoverable failures; Dashboard shows scan progress.

No per-account CLI or database editing is required. Descope authenticates people and their verified profiles are saved in the existing iGEO `users` table. Only database-backed system administrators can create customer brand accounts. `user_accounts` assigns Viewer/Owner access; new users have no account access. Descope controls the login flow and allowed signup methods. See [authentication and user management](AUTHENTICATION.md). Billing and invitation delivery are separate concerns.

## Generation instructions

The versioned instructions and strict schemas live in `apps/scanner/src/onboarding-prompts.ts` (`citevia-onboarding-v1`). `OPENAI_ONBOARDING_MODEL` configures research/brandbook/portfolio generation independently of scan generation and analysis.

- Understand: category, problem, use cases, audience and requirements.
- Prefer: discovery, shortlists, alternatives, comparisons and tradeoffs.
- Trust: proof, credibility, limitations, reviews and risk.
- Convert: commercial evaluation and next steps, without inventing prices, offers or action URLs.

With no manual prompts, allocation is **13 Understand, 13 Prefer, 12 Trust, 12 Convert**. Supplied prompts keep their assigned sections; the remaining places are allocated to the least represented sections. Supplied text is not rewritten. The generator is instructed to create neutral, buyer-realistic, distinct and repeatable questions, generally favoring unbranded discovery. It cannot be relied on to predict actual brand visibility or guarantee semantic diversity; live output quality must still be checked with the configured model.

The application rejects unknown sections, the wrong count/allocation, duplicate normalized questions, invalid records and unverifiable brandbook evidence. Model refusals, incomplete output and provider failures do not silently activate an account. Generated prompts and the brandbook are editable after setup. Editing a prompt increments its version; old scan snapshots remain unchanged.

## Persistence and compatibility

`database/reference/igeo-schema.prisma` is an unchanged copy of iGEO's checked-in schema, captured on 2026-10-19. Its SHA-256 is:

`dfd338e9322f8808fe9d503271a3745f5ea563d029dda137e9520c787e5016a2`

`database/migrations/001_igeo.sql` was generated from that schema with iGEO's installed Prisma CLI. It creates **109 original tables**, with the modeled column names, PostgreSQL types, primary keys, relationships and indexes. This is compatibility with the checked-in Prisma model, not a dump of the live iGEO database: custom triggers, views and manual database changes outside that model are not imported. iGEO's database and data are never accessed by the migration.

The application writes its reporting data into the original tables:

- `accounts`: brand identity, names, domains, about, industry, audience, tone, values, personality, features, source references, case-study references and guidelines.
- `users`, `user_accounts`, `account_settings`: identity membership, roles and per-account scan configuration/limits.
- `topics`, `prompts`, `competitors`: the prompt portfolio, its section in `stage`, active state, generation ID and tracked competitors.
- `scans`: each actual scanning run.
- `prompt_responses`: original text, parsed/native JSON, all native citation occurrences in `sources`, model, usage, status, visibility and nullable recommendation rank. Retrieved-but-not-cited sources are retained separately in JSON.
- `results`: extracted mentioned entities, rank, sentiment and source evidence using iGEO's columns.

`002_citevia.sql` adds five `citevia_*` state tables for versioned project configuration, identity mapping, scan manifests, result leases and onboarding jobs. A sixth table records migration names/checksums. They preserve the scanner's existing API contracts while the original tables retain queryable reporting rows. Existing non-UUID application IDs map deterministically to PostgreSQL UUIDs. The original model remains unchanged.

Failed/refused/incomplete outcomes are also saved in `prompt_responses`. A failed row's zero `visibility` is **not** a valid no-mention measurement: reporting must filter by successful status, just as the client metrics do. Original failures remain gaps. `json_response.companies` includes tracked mentioned companies in iGEO's company/rank/site shape, with additional native and analysis evidence retained alongside it.

## Recovery and scale

Jobs have conditional leases, four attempts per stage, saved research/brandbook/prompt checkpoints and a 24-hour onboarding deadline. A retry reuses valid checkpoints, rather than repeating earlier paid calls. A retry of activation never overwrites a portfolio already applied by that job. Eight explicit owner retries are allowed; duplicate retry request IDs do not reset work again. The scheduled recovery tick repairs expired leases and interrupted queue dispatch.

Creation requires an idempotency key. Repeating a request after an ambiguous failure repairs the same per-item jobs. Reusing a key with different company details is rejected. Owner account limits are enforced inside a database transaction. The AWS default is 100 accounts per owner (`MaxAccountsPerOwner`, configurable to 10,000), 10 concurrent SQS workers, 12 reserved scanner invocations, and 20 reserved API invocations. Each Lambda opens at most two database connections. Coordinate increased worker counts with the OpenAI project's actual rate limits, database capacity and expected scan duration; these defaults are configuration, not a throughput benchmark.

AWS gives scans a 24-hour deadline to tolerate bulk onboarding and weekly queue bursts. Local development retains the original three-hour default. The queue and 15-minute recovery tick use the same scanner Lambda. Onboarding does not add a third application Lambda.

## API and local validation

- `POST /v1/onboarding/accounts`: system administrator only; `{ accounts: [...] }`, at most 25; `Idempotency-Key` required. Returns accepted project/job records. A 207 response reports an owner limit reached after some items were accepted.
- `GET /v1/projects`: lightweight account summaries, active prompt counts and onboarding progress, with database-backed `q`, `limit` and `cursor` search/pagination. Account rows do not load every portfolio or brandbook.
- `GET /v1/projects/:id/onboarding`: persisted job details for account members.
- `POST /v1/projects/:id/onboarding/retry`: owner-only, idempotent retry of a failed job.
- `GET/PATCH /v1/projects/:id/brandbook`: versioned profile, owner-only edits.
- `GET /v1/runtime`: provider configuration status, behind authentication. Missing local credentials block paid work before account/run admission.
- Existing prompt APIs accept `stage`, `topic` and `branded`; bulk creation accepts `texts`. PATCH accepts the current prompt `version` and rejects stale edits. Response lists accept a `stage` filter.
- The dedicated Prompts screen manages active/archived questions and their four sections, and joins measurements only to matching prompt versions and methodology. Editing is blocked until onboarding activation finishes, preventing the generated portfolio from overwriting concurrent manual edits.

`npm run dev` starts an empty persistent PostgreSQL database (PGlite) with the production SQL migrations/repository. There are no runtime fixtures or automatic legacy JSON imports. With OpenAI credentials configured it executes real research, brandbook/portfolio generation and the first scan; without credentials those actions are disabled. Tests use isolated fixtures, never application records. See [local instructions](LOCAL_DEVELOPMENT.md) and [AWS instructions](DEPLOYMENT.md).
