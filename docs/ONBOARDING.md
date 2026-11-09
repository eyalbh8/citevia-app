# Account onboarding and iGEO database compatibility

## Implemented flow

A system administrator opens **Accounts → New account** and supplies the brand name, region, language and official website URL. An optional prompt focus prioritizes a particular product or service. Without a focus, the generator covers the main offerings supported by the research. Region is a two-letter country/region code and language is a code such as en or en-GB. Research discovers the company context automatically; onboarding does not accept notes, manual prompts or a timezone. Bulk CSV/JSON uses the same fields, up to 25 accounts per request. New accounts receive two scheduled scans per week. Each account is owned by its creator, and system administrators can assign users to it.

The system persists the account, membership and onboarding job atomically, with weekly scanning disabled. It then queues these steps:

1. **Research:** OpenAI Responses with web search researches the company and up to five direct competitors, including their official websites, and saves the native response and sources.
2. **Brandbook:** a separate strict JSON generation creates the iGEO-style company profile and a separate competitor list from that research. The model selects IDs from a server-built catalog of citation-linked research excerpts. The server copies each exact quote and its native URL; it never accepts a generated or paraphrased evidence quote. Selected evidence and all returned URLs are validated before saving. Competitors require name-bearing evidence linked to their official domain; unsupported candidates are omitted. Missing profile facts remain empty/null and appear under Needs verification.
3. **Prompts:** a separate strict JSON generation creates exactly 50 questions using the four brand-specific tactics. Each prompt has a journey section, topic, branded flag, generation ID and version.
4. **Activate:** save the brandbook, validated portfolio and verified competitors, enable the weekly schedule in the account's timezone, and enqueue an idempotent first scan. Existing manual competitor choices, including an explicitly empty list, are preserved. All provider scans receive the same assigned competitors. The Accounts screen shows progress and recoverable failures; Dashboard shows scan progress.

No per-account CLI or database editing is required. Descope authenticates people and their verified profiles are saved in the existing iGEO `users` table. Only database-backed system administrators can create customer brand accounts. `user_accounts` assigns Viewer/Owner access; new users have no account access. Descope controls the login flow and allowed signup methods. See [authentication and user management](AUTHENTICATION.md). Billing and invitation delivery are separate concerns.

## Generation instructions

The versioned instructions and strict schemas live in `apps/scanner/src/onboarding-prompts.ts` (`citevia-onboarding-v7`). `OPENAI_ONBOARDING_MODEL` configures research/brandbook/portfolio generation independently of scan generation and analysis.

- Understand: whether AI understands the brand’s business, offerings, audiences and use cases.
- Prefer: discovery, shortlists, alternatives, comparisons and tradeoffs.
- Trust: whether AI treats the brand’s expertise and published information as credible source material.
- Convert: commercial evaluation and next steps, without inventing prices, offers or action URLs.

The 50 generated prompts contain **40 unbranded and 10 branded searches**. Understand and Prefer each receive 13 prompts and Trust and Convert each receive 12. The default branded allocation is 3/3/2/2. Each generated branded prompt must contain the submitted brand name. Unbranded searches must make sense on their own and give the answerer a reason to name businesses, such as recommending, comparing or hiring a provider. A general definition or a list of application requirements does not serve that purpose.

Prefer includes at least three branded and three unbranded comparisons. When research identifies named competitors, the generator uses up to three distinct competitors for direct comparisons. Otherwise it asks about alternatives for the same buyer need. The generated portfolio uses the requested language and market, and mixes sentence openings and search forms.

The scanner verifies the actual wording against the brand and its aliases, the counts, comparison coverage, stage intents, length and duplicate wording. It checks for repetitive openings across the portfolio and rejects common generic question forms in English and Hebrew. Each prompt supports up to 20 whitespace-separated words and 160 characters. Account owners can edit prompts after setup. On older pending jobs, existing manual questions consume the relevant slots.

## Persistence and compatibility

`database/reference/igeo-schema.prisma` is an unchanged copy of iGEO's checked-in schema, captured on 2026-10-19. Its SHA-256 is:

`dfd338e9322f8808fe9d503271a3745f5ea563d029dda137e9520c787e5016a2`

`database/migrations/001_igeo.sql` was generated from that schema with iGEO's installed Prisma CLI. It creates **109 original tables**, with the modeled column names, PostgreSQL types, primary keys, relationships and indexes. This is compatibility with the checked-in Prisma model, not a dump of the live iGEO database: custom triggers, views and manual database changes outside that model are not imported. iGEO's database and data are never accessed by the migration.

The application writes its reporting data into the original tables:

- `accounts`: brand identity, names, domains, about, industry, audience, tone, values, personality, features, source references, case-study references and guidelines.
- `users`, `user_accounts`, `account_settings`: identity membership, roles and per-account scan configuration/limits.
- `topics`, `prompts`, `competitors`: the prompt portfolio, its section in `stage`, active state, generation ID and tracked competitors.
- `scans`: each actual scanning run.
- `prompt_responses`: original text, parsed/native JSON, all native citation occurrences in `sources`, model, usage, status, visibility and nullable appearance rank (legacy scans retain their original rank definition). Retrieved-but-not-cited sources are retained separately in JSON.
- `results`: extracted mentioned entities, rank, sentiment and source evidence using iGEO's columns.

`002_citevia.sql` adds five `citevia_*` state tables for versioned project configuration, identity mapping, scan manifests, result leases and onboarding jobs. A sixth table records migration names/checksums. They preserve the scanner's existing API contracts while the original tables retain queryable reporting rows. Existing non-UUID application IDs map deterministically to PostgreSQL UUIDs. The original model remains unchanged.

Failed/refused/incomplete outcomes are also saved in `prompt_responses`. A failed row's zero `visibility` is **not** a valid no-mention measurement: reporting must filter by successful status, just as the client metrics do. Original failures remain gaps. `json_response.companies` includes every verified company in appearance order, including untracked alternatives, in iGEO's company/rank/site shape. Sentiment/site stay unknown/null if they were not measured; they are never inferred from the target company's score. Native `results` rows include ranked alternatives. The non-null native rank column is never filled with a fabricated zero for unranked entities; those remain in JSON. Company-specific sources require a native citation range overlapping verified company evidence; all answer citations remain available separately.

`prompts.type` stores generated search intent; `prompts.stage` retains Understand/Prefer/Trust/Convert. No original iGEO columns or tables are replaced. Default aggregate columns on native prompts are not authoritative reporting values: selected-run, provider, version and methodology filters are applied by the reporting API.

## Recovery and scale

Jobs have conditional leases, saved research/brandbook/prompt checkpoints and a 24-hour onboarding deadline. After saving a completed prompt response that failed validation, onboarding can generate up to two corrected portfolios using the previous draft and validation feedback. A stored portfolio from an older policy also goes through validation before activation. A refusal, uncertain provider outcome or failed response save requires explicit owner retry. Infrastructure-only work can retry up to four times without purchasing another model response. A retry reuses valid checkpoints, rather than repeating earlier paid calls. A retry of activation never overwrites a portfolio already applied by that job. Eight explicit owner retries are allowed; duplicate retry request IDs do not reset work again. Before a model call, the worker persists a unique call intent. An expired lease with an unresolved intent stops with onboarding_call_uncertain instead of silently purchasing another response. A saved checkpoint is reused without a new call. The scheduled recovery tick repairs interrupted dispatch but never reactivates failed/stopped jobs.

Creation requires an idempotency key. Repeating a request after an ambiguous failure repairs the same per-item jobs. Reusing a key with different company details is rejected. Owner account limits are enforced inside a database transaction. The AWS default is 100 accounts per owner (`MaxAccountsPerOwner`, configurable to 10,000), 10 concurrent SQS workers, 12 reserved scanner invocations, and 20 reserved API invocations. Each Lambda opens at most two database connections. Coordinate increased worker counts with the OpenAI project's actual rate limits, database capacity and expected scan duration; these defaults are configuration, not a throughput benchmark.

AWS gives scans a 24-hour deadline to tolerate bulk onboarding and weekly queue bursts. Local development retains the original three-hour default. The queue and 15-minute recovery tick use the same scanner Lambda. Onboarding does not add a third application Lambda.

## API and local validation

- `POST /v1/onboarding/accounts`: system administrator only; `{ accounts: [...] }`, at most 25; `Idempotency-Key` required. Returns accepted project/job records. A 207 response reports an owner limit reached after some items were accepted.
- `GET /v1/projects`: lightweight account summaries, active prompt counts and onboarding progress, with database-backed `q`, `limit` and `cursor` search/pagination. Account rows do not load every portfolio or brandbook.
- `GET /v1/projects/:id/onboarding`: persisted job details for account members.
- `POST /v1/projects/:id/onboarding/retry`: owner-only, idempotent retry of a failed job.
- `GET/PATCH /v1/projects/:id/brandbook`: versioned profile, owner-only edits.
- `GET /v1/projects/:id/competitors/suggestions`: account members can retrieve verified alternatives from a sample of up to 300 recent saved answers, without another AI request. Owners assign competitors through Settings; historical verified mentions contribute to the dashboard, while unmeasured sentiment remains unknown. Indexed analysis is read in batches with artifact fallback for legacy records.
- `GET /v1/runtime`: provider configuration status, behind authentication. Missing local credentials block paid work before account/run admission.
- Existing prompt APIs accept `stage`, `topic` and `branded`; bulk creation accepts `texts`. PATCH accepts the current prompt `version` and rejects stale edits. Response lists accept a `stage` filter.
- The dedicated Prompts screen manages active/archived questions and their four sections, and joins measurements only to matching prompt versions and methodology. Editing is blocked until onboarding activation finishes, preventing the generated portfolio from overwriting concurrent manual edits.

`npm run dev` starts an empty persistent PostgreSQL database (PGlite) with the production SQL migrations/repository. There are no runtime fixtures or automatic legacy JSON imports. With OpenAI credentials configured it executes real research, brandbook/portfolio generation and the first scan; without credentials those actions are disabled. Tests use isolated fixtures, never application records. See [local instructions](LOCAL_DEVELOPMENT.md) and [AWS instructions](DEPLOYMENT.md).

New accounts persist three scan provider configurations. Activation sends one idempotent kickoff, which creates one provider-specific run per configuration using the same frozen prompts, brand and locale. Each has its own native `scans`, `prompt_responses` and `results` records and private evidence. `firstRunId` identifies the primary run; sibling runs share `groupId`. Provider settings live in the workflow JSON and in native `account_settings.ai_engines`; no iGEO schema changes or historical rewrites are needed. OpenAI remains the onboarding and evidence-analysis provider.

## Prompt tactics

The system generates exactly 50 unique questions for the researched brand and requested region/language:

- **Understand (13):** Does AI understand what the brand does? Questions test its business, offerings, audiences, use cases and category.
- **Prefer (13):** Does AI prefer the brand over rivals? Neutral discovery, shortlists, comparisons, alternatives and tradeoffs allow AI to choose.
- **Trust (12):** Does AI trust the brand as a source? Questions test expertise, credible official guidance, evidence and authority as a source. Reviews and product reliability do not replace source authority.
- **Convert (12):** Does AI help buyers take the next step? Questions support relevant buying, product/service selection, booking, seller discovery, contact or quotes. The researched business determines applicable actions; demos/trials are not assumed.

These are design goals, not literal questions sent to scan providers. At least 35 questions must be unbranded. Examples of natural phrasing are “What is the best trading platform?”, “Trading platforms with low fees”, “Where can I check a broker's licence?” and “How do I open a trading account?”; actual questions must fit the researched industry and requested language. The generator must not invent products, rivals, claims, prices or action URLs. Invalid output stops after that attempt, preserving its receipt; only explicit retry permits another paid call. Saved portfolios awaiting activation are checked against the new length and branding policy before they can start scans. Completed historical reports remain unchanged.

An IAM operator can refresh an existing account's portfolio from its saved brandbook with the scanner's `prompts:refresh` maintenance operation. It reserves a persisted call intent before generation, saves the output checkpoint, validates it, and increments existing prompt versions on the same account. Repeating a completed request is a no-op; a saved checkpoint is reused after an apply conflict. A missing checkpoint after an uncertain/failed call stops instead of purchasing another request. Concurrent prompt/brandbook edits prevent stale output from applying. The operation never creates another account, repeats research, overwrites scan snapshots or starts immediate scans. See the command in [deployment instructions](DEPLOYMENT.md).

The public API accepts only:

```json
{
  "accounts": [
    {
      "name": "YOUR_BRAND_NAME",
      "region": "US",
      "language": "en",
      "website": "https://YOUR_OFFICIAL_DOMAIN"
    }
  ]
}
```

Use `POST /v1/onboarding/accounts` with an authenticated system-administrator session and an `Idempotency-Key`. The server maps region to the existing country field and adds internal UTC scheduling and empty legacy context; promptFocus is optional. Prompts can be edited after setup in the dedicated Prompts screen.

## Stop and explicit retry

An owner or system administrator can select **Stop setup** in Accounts or call `POST /v1/projects/{id}/onboarding/stop`. The persisted stopped state fences late model completions, stale queue deliveries and recovery. An already in-flight provider request may finish and incur its cost; its saved receipt can be preserved, but it cannot start the next stage. API calls to start scans or enable a weekly schedule are rejected until onboarding has completed. The scanner independently checks the same status, including stale scheduled messages.

A generation/validation failure stops automatically after that attempt. The UI displays the reason and makes it clear that no further generation/scanning begins automatically. **Retry setup** calls the existing owner-only retry endpoint, clears the old call intent, and resumes from saved valid checkpoints. Up to eight explicit retry intents are allowed. A new retry is a deliberate paid action where the failed stage needs another response; duplicate HTTP/SQS deliveries do not reset the intent.

For brandbooks, research evidence must have a valid native citation range, source URL and exact saved quote. If no usable evidence exists, the worker stops before purchasing the brandbook call. Invalid evidence IDs, free-form quotes, unvisited URLs, malformed JSON or invalid portfolio counts stop rather than repeatedly asking the model to repair its own output. Failed native receipts are saved under unique attempt IDs; a diagnostic storage failure does not cause another model call.
