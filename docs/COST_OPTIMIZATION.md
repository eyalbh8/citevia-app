# Cost optimization and rollout

The app keeps visibility collection independent from analysis. Provider answers
remain original observations with their own model, date and citations. The
optimizations reduce the work needed to interpret, store and report those answers.

Production moved to Neon PostgreSQL; the verified settings and recovery procedure are recorded in [NEON_MIGRATION.md](NEON_MIGRATION.md).

## Implemented behavior

- New accounts default to `gpt-6-luna` analysis. Existing accounts and historical
  run snapshots keep their explicit models until the configuration command is applied.
- Analysis sends compact evidence IDs/text. Exact offsets, block identities,
  native citations and rank verification remain server-side. Luna uses no reasoning
  for this constrained extraction task.
- An exact, account-scoped cache revalidates native receipts before reuse. Its key
  includes the complete analysis request, parser, block identities and fallback
  policy. Reuse records zero newly purchased tokens. It never skips fresh collection.
- Scheduled scans can use native OpenAI Batch: one independent answer per request,
  durable submission/import state, stable IDs, selective failures and a minimum
  30-hour deadline. Manual scans and saved-answer reanalysis stay immediate.
- Passive tracker installation heartbeats are limited to once per 30 minutes per
  browser session/origin/account. SQL also coalesces fresh same-version receipts.
  Actual AI pageviews and explicit connection tests bypass the passive throttle.
- PostgreSQL retains compact reporting projections and references to private
  original evidence. New projections omit full native receipts and repeated blocks.
  Existing projections can be compacted only after verifying readable original artifacts.
- Typed run state and indexed original observation dates reduce writes and history
  query work. Prompt-answer date/rank/citation/sentiment pages filter, deduplicate,
  sort and paginate in SQL, returning each needed run manifest once. Model sort and
  ambiguous legacy ordering retain the historical comparator. Unchanged measurement
  finalization skips repeated projection writes.
- The native `results` mirror is configurable. Local/new repositories default off;
  production deployment defaults preserve it until external consumers are verified.
  Set `CITEVIA_WRITE_COMPATIBILITY_RESULTS=false` explicitly after that review.
  Canonical Citevia results, normalized analyses and citation reporting stay enabled.
- Reconciliation removes at most 100 expired auth records and 100 rate-limit buckets
  older than seven days per invocation. Non-expiring clients, active credentials,
  saved answers and scan history are retained.
- S3 expires only the disposable `analysis-cache/` prefix after 90 days. This does
  not impose deletion on original evidence or scan/report history.

## Model validation and configuration

Create a JSONL evaluation corpus from saved captures. Each row has `answer`
(`CapturedAnswer`), `snapshot` (`RunSnapshot`) and optional human labels in
`expected.brands` and `expected.companies`. Use `analysis:eval --help` for the full
label format. Include languages, aliases, absent brands, URLs-only mentions,
untracked companies, long answers, mixed sentiment and numbered lists.

```sh
npm run analysis:eval -- --input saved-answers.jsonl --candidate gpt-6-luna
npm run analysis:eval -- --input saved-answers.jsonl --candidate gpt-6-luna --execute --output evaluation.json
```

The first command only validates the corpus and estimates the workload. The
second purchases at most two analysis requests per sample, uses no collection or
search, and does not alter production measurements. Unknown labels are excluded
from metric denominators. Invalid outputs count as abstentions. Agreement with
the old model is not proof of correctness; the report never certifies quality on
its own. Use human-labelled precision/recall, sentiment/rank/company metrics and
evidence validity to decide whether to roll out.

Preview the effect on existing accounts, then apply to a selected account:

```sh
npm run analysis:configure -- --mode aws
npm run analysis:configure -- --mode aws --project ACCOUNT_ID --model gpt-6-luna --apply
```

Without `--project`, only retiring GPT-4.1 mini account settings are selected.
The command uses compare-and-swap and reports concurrent edits. It never changes
collection models or saved run snapshots. After a passing pilot, `--apply` without
`--project` rolls out to the retiring-model cohort.

Optional `OPENAI_EXTRACTION_FALLBACK_MODEL` permits one additional realtime call
after `invalid_extraction`. It never runs after a timeout/uncertain provider call.
Both native receipts and the actual returned model remain attributable. Batch
validation failures stay failed individual items for explicit retry rather than
silently purchasing immediate replacements.

## Native Batch admission and recovery

`ANALYSIS_BATCH_ENABLED` / SAM `AnalysisBatchEnabled` defaults to false until
model quality, provider access and completion latency have been validated. Enabling
it affects new scheduled manifests only. Turning it off does not abandon batches
already in progress. Keep their configured provider credential available.

The coordinator waits until collection work in a provider run has completed,
failed or reached `analysis_pending`, then submits the remaining uncached analyses.
It releases Lambda/SQS execution while waiting. The existing reconciliation
schedule polls and imports results idempotently. A partial output preserves
successful items; retries operate only on selected failed items.

A creation timeout is uncertain. The coordinator discovers the original batch
using saved submission metadata and the input file ID; it does not automatically
POST another paid batch when discovery finds nothing. Missing/unattributable output
retains uncertain cost reservations. Inspect the stored batch envelope and original
output/error files before authorizing another attempt. Expiry of the local scan
does not prove that an uncertain provider job was never billed.

## Cost visibility and budget semantics

`citevia_cost_events` records append-only attempt reservations and outcomes without
customer prompts, answers or credentials. It attributes account/run/prompt/stage,
requested/returned models, cached/reasoning tokens, search counters and estimates.
Native receipts remain in the evidence artifacts. Failed and uncertain attempts
stay visible. Missing usage or unknown model prices are not reported as free calls.

```sh
npm run costs:report -- --mode aws --start 2026-10-01 --end 2026-11-01
```

The end is exclusive. Reports separate completed estimates, outstanding reservations
and unpriced attempts. They are not invoices. During the brief pre-013 migration
transition, workers can stage metadata under private `provider-costs/` S3 keys;
these staged records require reconciliation and are not in the SQL report.

`LLM_MONTHLY_BUDGET_USD=0` disables admission limits. A positive value serializes
account admissions against UTC calendar-month estimates and outstanding reservations.
It is an estimated request-admission limit, not a guaranteed invoice ceiling:
tool use, provider adjustments, free credits and token usage can differ. Unknown
prices or an unavailable SQL admission ledger fail closed when a limit is enabled.
Provide missing provider/model rates through server-only `LLM_MODEL_PRICES_JSON`.
Do not replace unpriced attempts with zero when reconciling costs.

## Database maintenance

All operator commands preview by default, use an existing database, and never
apply migrations implicitly. Stop the local app before opening embedded storage.
For AWS, configure the existing private database access and evidence bucket.

```sh
npm run db:audit -- --mode aws
npm run db:cleanup-auth -- --mode aws --limit 100
npm run db:compact-evidence -- --mode aws --limit 100
```

Add `--apply` only to the reviewed cleanup/compaction operation. Compaction uses
optimistic JSON comparison, preserves original artifacts and normalized analysis,
and skips missing, unreadable or mismatched evidence. Apply the same starting
cursor used by a preview; advance using the **apply result's** next cursor.

The audit reports relation/index sizes, row estimates, scan statistics, reset times
and foreign keys. It does not certify unused tables. Review views/triggers,
external consumers and a full operating cycle before an additive drop migration.
No legacy tables or original evidence are automatically dropped. There is no new
automatic history-retention policy: the old 400-day metadata was never a deletion
job, and changing that contract requires a retention/restore decision.

The read-only production audit on 22 October 2026 found all 97 statically
unreferenced baseline tables empty, with 3,317,760 bytes total relation/index space.
Dropping them would reclaim only about 3.2 MiB. The populated `results` table had
recorded reads (329 sequential and 635 index scans; the stats reset time was
unavailable), so lack of a current code reader does not establish lack of consumers.
Production defaults preserve its writes while those consumers are investigated.

## Coordinated deployment

1. Build and validate the backend/client. Keep `AnalysisBatchEnabled=false` and
   `CompactRunState=false` on the **first** production rollout. The new repository
   handles the pre-011 schema; migration 011 backfills typed state, 012 adds batch
   coordination and 013 adds cost events. The deployment workflow runs migrations.
2. Leave compact state disabled until every pre-optimization scanner invocation
   has drained (at least the configured maximum Lambda timeout after the old
   deployment stops receiving work). This temporarily mirrors state into JSON so
   an old in-flight writer cannot overwrite new aggregate counters.
3. Verify both API and scanner run this release and migrations succeeded. Enable
   `CompactRunState=true` in the subsequent coordinated configuration rollout.
4. Review Aurora load, connections and p95 latency before adopting the new-stack
   template minimum of 0.5 ACU. The deployment workflow preserves a 1-ACU floor
   unless `AURORA_MIN_CAPACITY` is explicitly set. Auto-pause at zero is optional and can be
   limited by page traffic, open connections and periodic reconciliation.
5. Run the labelled model pilot, configure the chosen accounts, and enable native
   Batch only after its turnaround is acceptable. Collection/onboarding GPT-4.1
   migration remains a separate measurement/lifecycle decision.

Aurora mode keeps the NAT gateway for public provider API access. External
PostgreSQL mode removes Lambda VPC attachment, and a separate explicit cleanup
deployment can remove legacy NAT/tunnel charges after verification. Aurora stays
retained and continues billing until a separately reviewed retirement. See
[the staged external PostgreSQL cutover](DEPLOYMENT.md#external-postgresql-cutover-and-legacy-network-cleanup).

After compact typed writes begin, rolling back to a legacy JSON-only binary needs
paused writers and a bounded `db:rehydrate-runs` preview/apply pass first. That
command copies authoritative mutable state into JSON, preserves frozen snapshots,
and supports `--limit`/`--after` pagination. Keep the new readers while completing
the rollback. Merely reverting the binary can expose stale JSON counters.

Official references: [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[model deprecations](https://developers.openai.com/api/docs/deprecations),
[Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).
