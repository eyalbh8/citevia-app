# Native scan providers

Each account owns one portfolio of up to 50 active prompts. A weekly or manual kickoff freezes the prompts, brand, competitors, locale, provider list and models, then creates a separate run for each enabled provider. All three providers produce up to 150 answers and 150 independent analyses per account per week. Exact compatible analysis reuse can avoid paid calls; scheduled analyses can use native Batch. Onboarding research, generation and retries add calls. Provider APIs are billed separately. See [cost optimization and rollout](COST_OPTIMIZATION.md).

New accounts enable ChatGPT, Perplexity and Gemini. Existing accounts with no `scanProviders` setting retain OpenAI only. An owner or system administrator can enable providers and edit their models/presets in **Settings → Scan providers**. Saving changes applies to future kickoffs; captured answers and historical snapshots are preserved. At least one provider must remain enabled.

The top-bar **AI provider** selector applies to Dashboard, Prompts, Mentions and Sources. Those screens show one provider’s selected scan, with independent trends, visibility denominators, rank, sentiment, citations and retrieved sources. **Run scan** runs every enabled provider, regardless of the provider currently being viewed. Failed collection/analysis remains a gap; one failed provider does not cancel another provider’s run. Retries reuse an already captured answer instead of making another collection call.

## Configure local credentials

Put real credentials in the root `.env`, using an editor. Never put keys in `VITE_*`, commit them, or paste them into shared logs.

```dotenv
OPENAI_API_KEY=YOUR_OPENAI_KEY
PERPLEXITY_API_KEY=YOUR_PERPLEXITY_KEY
GEMINI_API_KEY=YOUR_GEMINI_KEY
OPENAI_GENERATION_MODEL=gpt-4.1-2025-04-14
OPENAI_EXTRACTION_MODEL=gpt-6-luna
PERPLEXITY_PRESET=fast@2026-10-16.0
GEMINI_GENERATION_MODEL=gemini-3.8-flash
```

Alternatively set `OPENAI_SECRET_ARN`, `PERPLEXITY_SECRET_ARN` and `GEMINI_SECRET_ARN`. A secret accepts a raw key or JSON with the corresponding `*_API_KEY` field. Local Secrets Manager access needs an AWS identity with permission to read those exact secrets. Direct keys need no AWS access. Restart `npm run dev` after configuration changes. Descope configuration and login are also required; see [local setup](LOCAL_DEVELOPMENT.md).

OpenAI remains required for generating brandbooks/prompts and for structured evidence analysis of every provider’s captured answer. Analysis uses the original saved answer only, with no tools/search, and validates every evidence quote and rank/sentiment span. Perplexity and Gemini collection calls go directly to their native APIs. They never use OpenAI to impersonate another provider. There is no fallback to a different collection provider.

`GET /v1/runtime` reports the presence of server key/secret configuration without exposing values. It does not prove valid billing, permissions or model access. Manual admission checks all enabled providers and OpenAI analysis before enqueueing. New-account onboarding checks all three because its initial scans enable all three. A scheduled job with invalid/missing credentials records a provider-specific failure through the normal retry/deadline process.

## Native APIs and evidence

- **ChatGPT:** OpenAI Responses API with required web search, native URL annotations and returned search sources. The existing OpenAI collection/extraction behavior is retained.
- **Perplexity:** `POST https://api.perplexity.ai/v1/agent`, with a versioned `preset`, neutral user question, language preference and the web search tool. The preset’s native citation/search instructions are preserved. The full response, actual preset/model, text, annotations, native source references, search results and usage are retained. Inline numeric or typed `[id]` citations map to the API’s returned search-result IDs, never their array order. Repeated references are preserved; conflicting IDs are not assigned an invented URL. Retrieved-only sources remain separate from citations.
- **Gemini:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `googleSearch`. Grounding chunks populate retrieved sources; grounding supports populate citations. Native UTF-8 byte offsets are converted to JS text offsets and checked against the native segment text. Unusable offsets retain the citation URL with a null text range. Thought parts are excluded from the displayed answer. Refusals and token-limit endings remain distinct from complete answers. Search suggestions returned by Google appear in a sandboxed iframe with scripts disabled. Query counts are stored separately from search-call counts.

The checked-in Gemini and Perplexity defaults are candidates taken from current documentation, **not live-validated configuration**. Run the commands below using your accounts before production. Prefer versioned presets/model IDs; a moving alias can change underlying behavior. The native returned model/version remains in each capture for audit. Comparisons require the same provider, configured model/preset, extraction model, parser, brand/competitors, locale and matching prompt versions.

Native receipts are stored privately before analysis, with separate S3 paths for every provider run. PostgreSQL retains the iGEO baseline: `account_settings.ai_engines` records configurations; `scans` gets one record per provider run; `prompt_responses.provider` and the optional `results.provider` mirror contain `openai`, `perplexity` or `gemini`. Workflow snapshots store `provider`, the frozen `scanProviders` and `groupId`. Historical snapshots with no provider mean OpenAI. Cost optimizations add migrations 011–013; originals and historical methodology remain preserved.

Google may return Google-hosted redirect URLs for citations. Citevia preserves those exact native links and aggregates their returned URL hosts; it does not guess a publisher domain from a title or fetch arbitrary citation destinations. The native receipt is the authority for attribution. API observations also differ from personalized consumer ChatGPT, Perplexity or Gemini browser sessions.

## Reporting API

All endpoints require a verified Descope session and the same account access checks as before.

```text
GET /v1/projects/{id}/dashboard?provider=gemini
GET /v1/projects/{id}/runs?provider=perplexity
GET /v1/projects/{id}/responses?provider=gemini
GET /v1/projects/{id}/sources?provider=perplexity
GET /v1/projects/{id}/dashboard?provider=gemini&runId={geminiRunId}
```

`provider` accepts `openai`, `perplexity` and `gemini`. An explicit run from a different requested provider is rejected. Dashboard trends and week-over-week comparisons only use the selected provider. `POST /v1/projects/{id}/runs` still requires an `Idempotency-Key`; it returns the primary `runId` plus `runs: [{provider, runId}]` for the enabled providers. The worker freezes the authoritative configuration when it creates the primary manifest. Sibling runs share `groupId`, and interrupted kickoff delivery repairs fan-out using that frozen snapshot. Owners can retry failed prompts from an individual run in Settings.

## Live validation, prepared for later

Use a text file containing your actual questions, one per line. Each command selects **only one provider**, with 1–10 prompts. It makes real paid collection requests and paid OpenAI extraction requests; it does not insert accounts into the running application or provide fabricated answers.

```sh
npm run scan:spike -- --help
npm run scan:spike -- --provider openai --prompts ./prompts.txt --brand "YOUR_BRAND" --domain YOUR_DOMAIN --count 3
npm run scan:spike -- --provider perplexity --prompts ./prompts.txt --brand "YOUR_BRAND" --domain YOUR_DOMAIN --count 3
npm run scan:spike -- --provider gemini --prompts ./prompts.txt --brand "YOUR_BRAND" --domain YOUR_DOMAIN --count 3
```

Inspect the private `.local-data/spike/<timestamp>/report.json` and evidence files. Compare native citation URLs and text ranges, retrieved-only sources, ranked/unranked answers, brand aliases, no-mention cases, sentiment evidence, refusals, completeness, latency and actual billed usage. The command does not automatically repeat failed paid calls. No live calls are run as part of the tests or build.

## AWS

Follow [DEPLOYMENT.md](DEPLOYMENT.md). Create one server-only Secrets Manager secret for each provider and supply `OpenAiSecretArn`, `PerplexitySecretArn` and `GeminiSecretArn` to SAM. Optional model parameters are `GenerationModel`, `ExtractionModel`, `PerplexityPreset` and `GeminiGenerationModel`. New-account defaults are passed to the API Lambda; the scanner receives the same defaults and secret ARNs. The API can see provider ARN configuration but cannot read provider secret values. Only the scanner role has scoped provider secret-read permissions.

There are still exactly two application Lambdas, one shared SQS queue, and one weekly schedule per account. The scanner fans out provider runs, which use the same leases, idempotency, S3 checkpointing, failed-job retry, DLQ and reconciliation mechanisms. Queue concurrency is shared across providers; size it for all three providers’ rate limits and the increased volume. No AWS resources are deployed by the implementation/tests.

## Documentation used

- [Perplexity Sonar migration and current supported Agent API](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview): Sonar support ended September 27, 2026; new integrations use Agent API.
- [Perplexity presets and version pinning](https://docs.perplexity.ai/docs/agent-api/presets).
- [Perplexity web search and source results](https://docs.perplexity.ai/docs/agent-api/tools/web-search).
- [Gemini generateContent and grounding segment byte offsets](https://ai.google.dev/api/generate-content).
- [Gemini Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search).

Documentation was checked October 20, 2026. Context7 tools were unavailable in this session, so official provider documentation was used directly. Availability and charges must be validated with your own provider accounts before enabling production schedules.

## Rank, sentiment and saved-answer reanalysis

### Reporting contract and iGEO alignment

The implementation follows iGEO's prompt DTO, `prompts.service.ts`, `prompt-visibility-aggregation.util.ts`, `sources-from-responses.service.ts` and the Dashboard/Prompts/Mentions/Sources client components, without importing customer data. Data flows from each native API capture to private S3 checkpoints, validated company evidence, the original `scans`/`prompt_responses`/`results` tables, and authenticated account-scoped report endpoints.

- **Dashboard:** successful-answer visibility, company-appearance rank, numeric sentiment, citation totals and comparable provider-specific weekly history. `groups.stages`, `groups.topics`, `groups.branding` and `groups.intents` use the selected run's frozen prompt metadata, with explicit prompt/analyzed counts and null unmeasured scores. Branded questions are reported separately from organic discovery.
- **Prompts:** original/versioned question, section, topic, search intent, brand presence, locale, dates, status, native citation count, visibility, rank, sentiment and comparable changes. Measurements cannot attach to edited text/version or another provider/methodology. A refreshed portfolio waits for real new answers; old answers are never relabeled as answers to new questions.
- **Mentions:** one original provider answer per question, target presence/rank/sentiment and exact evidence, plus all verified companies in appearance order in answer details. Scans assess each identified company's sentiment independently, including untracked alternatives, and retain exact supporting evidence. Legacy companies without that assessment retain unknown sentiment. Failures remain gaps, and original native answers/citations are always retained.
- **Sources:** all native citation occurrences, distinct citing answers, normalized domains/URLs, distinct prompt counts, ownership, first/last observation times and answer drill-down. `avgCitations` is occurrences divided by distinct answers citing that source. `usedPercent` follows iGEO's frequency formula (occurrences divided by captured answers × 100), so repeats can exceed 100%. `coverage` separately counts distinct citing answers and cannot exceed 100%. Retrieved-only references remain separate and do not receive citation scores. Unknown editorial/domain classifications are not fabricated.

Summary caches declare `reportingVersion:2`; the API rebuilds older derived summaries from saved evidence without paid model requests. The native schema stays unchanged. The compatibility projection adds all verified company rows and exact citation attribution, and stores `intent` in the existing native prompt `type` field.

The `igeo-evidence-v2` parser matches iGEO’s company-appearance rank and numeric sentiment definition. Analysis identifies all relevant companies, including untracked alternatives; the server verifies their names against saved text and assigns unique ranks by actual first-appearance offsets. Rank is not a score out of 100 and does not imply preference. Explicit numbered recommendation position remains separate. Older reports retain their original extraction method.

Sentiment uses `round(50 + 50 * (positive - negative) / classified_mentions)`. A single positive mention is 100, negative is 0, neutral/mixed is 50. Missing/failed analysis, absence and unknown sentiment have no score and are excluded from averages. A real negative zero is displayed as zero. Model-selected evidence IDs resolve to original text server-side; the model never recreates quotes or offsets. Each v2 failed/uncertain call stops and requires explicit retry.

Evidence resolution preserves independently verified metrics when an optional field is unsupported. Non-identifying extra mention excerpts are omitted; an unverified explicit recommendation rank stays null rather than discarding valid appearance rank and sentiment. A missing tracked-company inventory entry can be completed only from exact, already-verified brand evidence. Misplaced company evidence is resolved to an exact occurrence in the answer; invented untracked companies remain invalid. A claim of presence is rejected as measured absence when no known name or alias appears outside URLs anywhere in the saved answer. Unsupported sentiment stays unknown with a null score. Private analysis retains the original receipt, `validationVersion` and resolution warnings. These checks can reparse a saved receipt without another paid call.

`GET /v1/projects/{id}/prompt-metrics?days=7&provider=openai` returns `avgVisibility`, `avgRank`, `avgSentimentScore`, and visibility/rank/sentiment percentage changes for each prompt. Allowed periods are 1, 7 (default), 14, 30 and 90 days, or `days=custom` with inclusive UTC `start` and `end` dates; omitting `provider` aggregates all configured providers. Presets share Dashboard and Mentions boundaries: 1 is a rolling 24 hours, while longer presets start at UTC midnight on the first selected day. The response includes exact current/previous period boundaries, real active/limit usage, measurement denominators and the latest matching response ID. The client uses these same server values for the table, sorting and CSV.

`GET /v1/projects/{id}/dashboard/overview` uses the selected capture period and provider/region/prompt filters for every card, including competitor sentiment. Ranking sentiment is the rounded mean across all classified mentions in that selection; unknown sentiment is excluded, and a measured negative score of zero is retained. Sentiment changes remain score-point differences between the first and last observed days, or null when either endpoint has no classified sentiment. Mention changes include zero-mention observed days, with provider changes using that provider's observation dates. Active stage visibility excludes historical answers to older prompt text or versions.

Visibility is the rounded percentage of successful analyses mentioning the brand. Sentiment is the rounded mean of classified brand-mention scores; rank is the unrounded mean of measured appearance ranks, displayed to one decimal. Changes use the preceding equal-length period and iGEO's two-decimal percentage formula. A zero-to-positive visibility/sentiment baseline gives +100%; zero-to-zero gives 0%; rank improvements invert the sign. Missing answers, failed analyses, incompatible models/locales/brand configuration and edited prompt versions never become zeros. Unavailable baselines stay null. Reanalysis is counted once using the original capture key and timestamp, with the latest compatible successful analysis. Period reads query the database's original observations without the scan-list pagination limit.

The existing `?runId=...` mode remains available for single-scan clients. The table no longer uses that mode. The native `prompt_responses.response_rank`, `results.rank`, `prompt_responses.json_response.sentimentScore`, and private structured analysis retain the measurements; period aggregates are derived, not saved as stale global prompt scores.

Apply `004_prompt_metadata.sql` before deploying the new API. It adds native `prompts.seo_keyword`, repairs existing prompt region/language mirrors and makes failed-response visibility nullable. SEO keywords, tags and intent pass strict API validation and are saved transactionally to versioned project JSON and native prompt rows. The topic relationship remains in storage for compatibility, but topics are omitted from this screen. No iGEO customer data or screenshot values are imported into runtime data.

An operator with scanner Lambda invocation permission can submit an IAM-only maintenance payload `{"kind":"scan:reanalyze","projectId":"EXISTING_PROJECT_ID","runId":"EXISTING_RUN_ID","requestId":"UNIQUE_REVIEWED_REQUEST_ID"}`. SQS rejects maintenance payloads. Repeating the same request reuses the same report and does not reset attempts. The worker creates a new report linked by `reanalysisOf`, snapshots the current competitor list, preserves the original target, questions, provider, locale, answers/citations and their capture timestamps, stops pending old analysis, and analyzes only completed saved answers. This supports measuring newly assigned competitors in older captures. It makes extraction calls when a compatible saved analysis is unavailable; dashboard reads never trigger paid analysis. Missing evidence stays a failed measurement; reanalysis cannot purchase a replacement answer. Original run snapshots and receipts remain available.
