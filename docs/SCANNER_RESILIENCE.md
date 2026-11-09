# Scanner resilience

The scanner separates temporary capacity limits from account quota and billing failures. Each collection and analysis stage has an initial attempt plus at most **three retries**. A retry consumes the same durable stage budget across queue delivery, reconciliation and manual retry requests. Admission deferrals do not count as provider calls.

## Request admission

Migration `014_provider_admission.sql` adds small coordination tables in PostgreSQL. Workers serialize admission with a row lock, release the database connection before inference, and share the following defaults:

- At least ten seconds between new requests per provider.
- At most two requests in flight per provider.
- Five-minute leases recover capacity after a worker crashes.
- OpenAI analysis shares capacity across OpenAI, Perplexity and Gemini scans.
- A quota error blocks new paid calls until an operator resolves the provider account and explicitly clears the block. Perplexity and Gemini collection also check the shared OpenAI quota block before collecting more answers that cannot be analyzed.

Set `SCANNER_PROVIDER_MIN_INTERVAL_MS` and `SCANNER_PROVIDER_MAX_CONCURRENT` to tune defaults. Provider overrides use `SCANNER_OPENAI_`, `SCANNER_GEMINI_` or `SCANNER_PERPLEXITY_` with the same suffixes. Adjust using the limits of the actual provider project. Request pacing reduces bursts; it does not increase purchased credits, token limits or a monthly spending cap. Other applications using the same credentials can consume those limits too.

Validated analysis cache hits bypass provider admission. Cost reservations happen inside admission, so waiting for capacity does not look like a paid request. Definitive HTTP429 and quota rejections release their cost reservations; ambiguous network/server outcomes retain conservative reservations.

## Retry and recovery

Temporary rate limits and eligible HTTP failures use delayed queue messages with exponential backoff and per-prompt jitter. The scanner honors `Retry-After` and relevant exhausted OpenAI request/token reset headers. The retry timestamp is stored before dispatch. Early or duplicate messages cannot bypass it; reconciliation repairs a failed dispatch. SQS delays are capped at fifteen minutes, but longer provider cooldowns remain in PostgreSQL and are never shortened. The scan deadline is the final bound.

An analysis retry loads the original captured answer. It does not buy another search or collection. Successful artifacts are checkpoints, so an interrupted database write can recover from the saved object. A timeout or disconnected paid request without a saved result is uncertain: it requires explicit review, rather than automatically purchasing a duplicate. A completed analysis that fails evidence/JSON validation can receive a correction only after its native receipt is saved. The correction receives the validation error and uses the same initial-plus-three analysis budget, backoff, admission and deadline. Refusals, incomplete responses, unknown outcomes, and failed receipt saves do not purchase automatic replacement calls. Batch items use the same rule; malformed or unattributable batch files remain stopped for review.

Exact name matching preserves original evidence offsets while recognizing typographic apostrophe/quote variants and attached Hebrew prepositions or conjunctions. Article assimilation is restricted to multiword institutional names (for example, המוסד → למוסד); it never strips the first letter from arbitrary proper names. This does not translate names, change singular/plural spelling, create aliases or accept service categories as brands.

Durable scans make one model call per stage attempt. They do not invoke the optional validation fallback inside that attempt, because an extra call would bypass the shared limiter and retry budget. Standalone model evaluation can still explicitly compare a configured fallback.

Scheduled scans continue to use provider Batch; manual scans remain realtime. Batch submission and failed-item retries keep durable attempt identities. Successful items are preserved. An ambiguous batch submission is discovered through its saved metadata, never blindly resubmitted.

Errors retain allowlisted machine codes and safe messages. Provider error bodies, prompts and credentials do not enter operational logs or scheduling state.

## Operations

Configure the usual AWS profile, region, `DATABASE_MODE=external` and `DATABASE_SECRET_ARN` for these commands. Database credentials stay in Secrets Manager.

```sh
npm run scanner:providers
npm run scanner:providers -- --provider openai
```

If a provider reports exhausted credits, a spend cap or a usage limit, first fix that issue in the provider account. Then explicitly reopen admission:

```sh
npm run scanner:providers -- --provider openai --reset-quota --billing-resolved
```

This does not change billing limits or start a scan. Failed items remain available for explicit retry within their remaining attempt budget. A new scan is a separate user decision.

Apply migration014 before deploying the new scanner. Missing admission tables fail closed and defer requests. Keep batching, the existing database configuration and existing account model selections when deploying.

Production rollout completed on 2026-10-22 at 19:41 UTC. All 734 tests passed, TypeScript and production builds passed, and migration014 was tested on an isolated Neon branch before applying to production. The deployed Lambda package checksum matched the local build; its environment stayed unchanged. Workers resumed, a canceled-scan no-op invocation passed, the queue drained to zero, and API health returned OK. No paid provider call was made during verification. The temporary test branch was deleted. Source changes remain local until the owner commits and deploys them through the normal repository workflow.

On 2026-10-22, the unwanted XTrade scan group `run_13c8ddcdaeb000b949c85095` and its two sibling provider runs were canceled. Database cleanup removed 150 prompt checkpoints, 150 answer projections, 233 compatibility result rows, 150 capture records and 689 citation rows. Empty canceled run records prevent queued work from recreating the scan. Earlier answer/checkpoint fingerprints matched before and after cleanup. This cleanup did not erase historical private S3 evidence or the cost ledger.

References: [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes).
