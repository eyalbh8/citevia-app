# Scheduling and dispatch as the account fleet grows

Each account gets two persisted weekly UTC slots, exactly 84 hours apart. New accounts receive slots during onboarding. Existing accounts with the original default weekly expression can be migrated with the configuration command below; explicitly customized expressions are preserved unless selected for migration.

For the first ten accounts, starts are 30 minutes apart on Monday and Thursday: the first account starts Monday 06:00 UTC and Thursday 18:00 UTC, the second at 06:30 and 18:30, and so on. Later accounts fill the largest empty interval across the 84-hour cycle. Previously assigned accounts never move. With 100 allocated accounts, the tested allocation produces 200 distinct weekly starts, 30–75 minutes apart, spread over all seven days. UTC spacing stays constant through daylight-saving changes; Settings displays the actual slots and the next start in the account's timezone.

Allocation uses a PostgreSQL transaction and a fleet-wide advisory lock. Concurrent onboarding cannot reserve the same slot. Each account has two separate EventBridge schedules with versioned occurrence messages. Both replacements must synchronize before the legacy schedule is disabled. Until the initial migration succeeds, only legacy deliveries are effective; deliveries from a partially created replacement are ignored. Successful synchronization persists an activation marker. Later settings edits keep the activated slots effective even while synchronization is pending. The scanner rejects obsolete or mismatched occurrences, skips scheduled deliveries more than 24 hours late, and prevents a second scheduled scan group from overlapping the account's unfinished scheduled group. Skipped occurrences are logged instead of creating an outage catch-up burst. Manual scans retain their explicit run identity and share dispatch limits.

## Work admission and recovery

Migration `015_scan_dispatch.sql` stores ready work, reservations and account turn order in PostgreSQL. Kickoff records the prompt backlog there; SQS receives a bounded slice. Account turns persist across workers, and each claim is transactional. Default limits count queued reservations and executing prompt jobs together:

| Setting | Default |
| --- | ---: |
| `SCAN_DISPATCH_MAX_OUTSTANDING` | 12 across the fleet |
| `SCAN_DISPATCH_MAX_PER_ACCOUNT` | 3 per account |
| `SCAN_DISPATCH_MAX_PER_PROVIDER` | 4 per provider |
| Dispatch/prompt lease | 12 minutes |
| `SCANNER_PROVIDER_MIN_INTERVAL_MS` | 10,000 milliseconds |
| `SCANNER_PROVIDER_MAX_CONCURRENT` | 2 paid requests per provider |

The dispatch limits bound queued work; the existing shared provider admission gate separately controls actual calls. OpenAI analysis from all three collection providers consumes the same OpenAI admission capacity. Work wakes the dispatcher after progress; durable delayed wakeups and the existing 15-minute reconciliation repair delays and lost deliveries. A reservation token may start once. Expired reservations can be reclaimed; old deliveries cannot consume replacement tokens. A lost send may wait for its 12-minute lease to expire and then the next 15-minute repair tick: up to approximately 27 minutes before recovery, plus queue processing time. SQS Standard fair-queue tenant groups provide additional account isolation, while PostgreSQL remains the authority for limits and retries.

Fleet reconciliation publishes independent `reconcile-run` control jobs before optional maintenance. Each run polls its batches and repairs its checkpoints in a separate invocation. A slow provider request or one failing run therefore cannot consume a single fleet-wide Lambda timeout and leave later accounts without recovery. The control jobs perform recovery; paid prompt work still passes through the bounded dispatcher and provider gate.

The scanner Lambda requires `RecursiveLoop: Allow`: each completion intentionally sends the next bounded job to its own SQS queue. AWS's default recursion protection otherwise drops the next invocation after approximately 16 links, even when every link processes a different prompt. Such drops occur before the handler starts, so inspect `RecursiveInvocationsDropped` when jobs stay leased without handler logs. The API retains default recursion protection. Dispatch limits, single-use reservation tokens, provider admission, attempt budgets and run deadlines still apply. This setting does not clear a provider billing circuit. See [AWS recursive invocation configuration](https://docs.aws.amazon.com/lambda/latest/dg/invocation-recursion.html).

Each collection and analysis stage allows one initial attempt plus at most three safe retries. Cooldowns, retry times and attempt counts survive worker restarts. Analysis retries use saved captures, and completed items remain completed. Ambiguous paid-call outcomes stop for review; automatically repeating an uncertain request could purchase a duplicate. Provider quota or billing failures block paid admission until an operator resolves the cause. See [Scanner resilience](SCANNER_RESILIENCE.md) for classification and reset commands.

Scheduled scans use native asynchronous analysis Batch when `ANALYSIS_BATCH_ENABLED=true`; manual/onboarding scans retain realtime analysis. Collected answers are saved before analysis. Each accepted batch receives a durable deadline based on its original submission time: 24 hours of processing plus two hours for polling and importing results. Discovery after an uncertain submission uses the original provider timestamp or original submission attempt, not the later discovery time. Late submission extends the run deadline when needed; it does not immediately expire because collection consumed the initial window. Failed-item retries retain the shared stage budget and leave successful items intact.

## Deployment and schedule migration

1. Back up the current deployment and verify there is no paid call in flight before temporarily pausing workers for a rollout. Keep existing account models, batch configuration and database secrets.
2. Apply migration014 if it is missing, then migration015. Test the migrations on an isolated database before production. The production dispatcher requires these tables; do not deploy its code first.
3. Deploy the scanner and API together, then the client. Verify the scanner's recursion configuration is `Allow`, plus the saved dispatch limits and reconciliation schedule. Existing tokenless prompt messages are adopted into durable dispatch, so a queue purge is unnecessary.
4. Preview schedule allocation, then apply and verify both schedules and the next occurrence. Restore worker processing after validation. Inspect queues, DLQ and operational logs; verification need not create a paid scan.

Use the usual authorized AWS profile and region. Configure `DATABASE_MODE=external`, `DATABASE_SECRET_ARN`, `SCHEDULE_GROUP`, `QUEUE_ARN`, `SCHEDULER_ROLE_ARN`, and, if used, `DLQ_ARN` through the existing deployment environment. Database credentials remain in Secrets Manager. Do not print secret values or copy credentials into commands or reports.

```sh
# Read-only preview; there is no --preview flag because preview is the default.
npm run schedules:configure -- --mode aws

# Assign default accounts and synchronize future EventBridge occurrences.
npm run schedules:configure -- --mode aws --apply

# Explicitly migrate a single custom schedule when intended.
npm run schedules:configure -- --mode aws --project ACCOUNT_ID --migrate-custom --apply
```

These commands never enqueue an immediate scan. Apply also repairs previously assigned schedules using the same slots. A sync failure leaves the durable assignment marked as an error. Periodic maintenance repairs up to five pending/error accounts per tick, selecting the oldest updates first so failing accounts do not permanently block others; rerunning the command also repairs immediately. Settings synchronization, maintenance and the command use the version returned by allocation and compare-and-swap saves, so a concurrent account edit is reapplied before synchronization is reported successful. Account timezone edits do not move assigned UTC slots.

### Rollout record, 2026-10-22

Migration015 passed validation on an isolated Neon branch and was then applied to production. All 785 tests passed before backend deployment began. Backend deployment and post-deployment verification were in progress when this record was written; this record alone does not confirm their completion.

The client changes have **not** been deployed. Amplify rejected a direct artifact upload because the application is connected to Git. Publishing the updated client requires the owner's normal Git-based deployment flow. Source changes remain local, respecting the instruction to keep them local; no GitHub push or pull request was created.

## Capacity and operating limits

At 50 prompts per account, three providers and two scans per week, 100 accounts produce 30,000 collection items and up to 30,000 analysis items weekly. This averages about one collection request per minute per provider; it is workload arithmetic, not a guaranteed completion time. Batch analysis may finish the following day.

Actual provider request, token, daily and batch-enqueued-token quotas have not been verified by the scheduler. No proactive token-per-minute reservation is implemented here. The request gate and provider cooldowns protect admission, but cannot increase purchased limits. Shared credentials used by onboarding, content generation or other applications can consume capacity outside scan admission. Optional per-account estimated cost budgets remain available through `LLM_MONTHLY_BUDGET_USD`.

Before raising limits, measure dispatch backlog age, run completion age, provider throttling/quota failures, batch submission/import status and cost per account. Begin with the existing account and the next two onboardings, then increase fleet size while checking these signals. The 100-account allocation and dispatcher tests cover fairness, bounded work, duplicate delivery and recovery; they do not establish a live provider throughput guarantee.
