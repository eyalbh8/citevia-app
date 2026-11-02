# Security and operational assurance inventory

Baseline reviewed 2026-11-02. This is a work inventory, not an attestation that every control has passed. See [SECURITY_ASSURANCE.md](SECURITY_ASSURANCE.md) for implemented changes, production verification and remaining acceptance gates.

## 01. Account isolation and permissions

Priority: High. Baseline: Verify.

The API checks membership and owner permissions centrally; repository queries commonly include project IDs. Existing cross-account and disabled-user tests are useful evidence, but sampled code is not proof for every route.

Work: Inventory every HTTP and MCP operation. Test viewer, owner, system administrator, removed member, guessed IDs, artifacts and concurrent access revocation. Keep account scope mandatory in repository methods; assess database row policies as added protection.

Acceptance evidence: An automated permission matrix passes for every exposed operation.

Sources: [apps/api/src/app.ts](../apps/api/src/app.ts), [packages/storage/src/users.ts](../packages/storage/src/users.ts), [tests/users.test.ts](../tests/users.test.ts).

## 02. Login, sessions and administrator protection

Priority: High. Baseline: Verify.

Descope sessions are validated server-side, profiles must be active and verified, and disabled users are rejected. A management profile lookup occurs for each authenticated API request.

Work: Verify administrator MFA, session expiry, logout and revocation, account linking and recovery in the actual identity configuration. Bound identity-service latency and quota use; evaluate short caching only with an explicit revocation requirement.

Acceptance evidence: Session and recovery abuse tests pass; administrator MFA and identity-service failure behavior are documented.

Sources: [apps/api/src/descope.ts](../apps/api/src/descope.ts), [docs/AUTHENTICATION.md](../docs/AUTHENTICATION.md).

## 03. MCP and OAuth scope

Priority: High. Baseline: Improve.

Hashed credentials, PKCE, refresh rotation, revocation checks and MCP audit logs already exist. System administrators can create connections spanning all accounts; non-expiring API keys are allowed.

Work: Prefer read-only, account-scoped credentials and bounded expiry. Review global administrator consent, cost-incurring tools, client registration abuse, token reuse and refresh races. Make read/write capabilities explicit where needed.

Acceptance evidence: A connector can perform only the granted actions and account access, including after role changes.

Sources: [apps/api/src/mcp.ts](../apps/api/src/mcp.ts), [apps/api/src/mcp-oauth.ts](../apps/api/src/mcp-oauth.ts), [tests/mcp-oauth.test.ts](../tests/mcp-oauth.test.ts).

## 04. Injection, unsafe URLs and outbound requests

Priority: High. Baseline: Verify.

Sampled SQL is parameterized, answer rendering avoids raw HTML, JSON-LD escapes '<', and article retrieval pins validated public DNS addresses and rechecks redirects. These are valuable existing defenses.

Work: Test SQL sorting and dynamic identifiers, XSS in model output and links, command arguments, traversal, SSRF, redirect chains and DNS changes across every URL-consuming adapter. Reuse the stronger URL controls consistently.

Acceptance evidence: Adversarial payload tests cover each input-to-execution or input-to-rendering boundary.

Sources: [apps/scanner/src/geo-backlink-articles.ts](../apps/scanner/src/geo-backlink-articles.ts), [apps/client/src/AgentPostPreview.tsx](../apps/client/src/AgentPostPreview.tsx), [packages/storage/src/postgres.ts](../packages/storage/src/postgres.ts).

## 05. Abuse limits for users, accounts and public routes

Priority: High. Baseline: Observed gap.

API Gateway has a shared 25-request/second throttle and burst 50. MCP, traffic collection and some generation operations have additional limits. General authenticated routes do not share a comprehensive user/account quota policy.

Work: Add route-specific and tenant-specific limits for expensive reports, scan creation, exports, uploads and authentication failures. Include queue and storage consumption. Traffic Origin checks are forgeable by a non-browser client; decide how to validate site ownership and label untrusted analytics.

Acceptance evidence: One tenant or public caller cannot exhaust the shared API, database, queue or provider budget.

Sources: [infra/template.yaml](../infra/template.yaml), [apps/api/src/traffic.ts](../apps/api/src/traffic.ts), [apps/api/src/app.ts](../apps/api/src/app.ts).

## 06. Browser security headers and content policy

Priority: High. Baseline: Observed gap.

The checked-in frontend header file defines caching only. A Content Security Policy, frame restrictions and a complete browser security-header policy are not declared there. Actual hosted responses were not inspected.

Work: Define and test CSP, frame-ancestors, HSTS, Referrer-Policy, Permissions-Policy and nosniff at the hosting layer. Account for authentication, API endpoints, images and font sources. Verify CORS separately from authorization.

Acceptance evidence: Hosted application responses have the reviewed headers without breaking login or integrations.

Sources: [customHttp.yml](../customHttp.yml), [infra/template.yaml](../infra/template.yaml).

## 07. Secrets, credentials and rotation

Priority: High. Baseline: Verify.

Environment files are ignored and production code supports Secrets Manager. Database pools refresh credentials; some provider instances cache a loaded key for the lifetime of a warm worker.

Work: Scan current files and Git history without printing secrets. Verify rotation for database, AI, publishing and identity credentials, narrow access, separate environments, and inspect compiled frontend assets for private values. Distinguish intentionally public browser keys.

Acceptance evidence: Rotating each credential succeeds without a prolonged outage; no private secret reaches browser assets or logs.

Sources: [.gitignore](../.gitignore), [apps/scanner/src/provider-http.ts](../apps/scanner/src/provider-http.ts), [packages/storage/src/sql.ts](../packages/storage/src/sql.ts).

## 08. Bring every paid AI workflow under cost controls

Priority: High. Baseline: Observed gap.

The scan pipeline has a cost ledger and provider admission. Social text/style/image-review requests and image generation call providerPost directly without those wrappers. The social worker does save checkpoints to avoid duplicate purchases.

Work: Route social calls through account-scoped cost reservations, usage reporting, shared provider limits and quota stops. Inventory onboarding, content, competitor research, backlink work and evaluation calls too. Include image and multimodal charges, not only text tokens.

Acceptance evidence: Every paid call has an attributable reservation, outcome and admission decision.

Sources: [apps/scanner/src/social-media.ts](../apps/scanner/src/social-media.ts), [apps/scanner/src/social-media.ts](../apps/scanner/src/social-media.ts), [apps/scanner/src/cost-observer.ts](../apps/scanner/src/cost-observer.ts), [apps/scanner/src/providers.ts](../apps/scanner/src/providers.ts).

## 09. Budgets and spending stops

Priority: High. Baseline: Observed gap.

LLM_MONTHLY_BUDGET_USD defaults to zero in the template, example environment and deployment workflow, which disables admission limits. A positive value limits estimated monthly spend per account; it is not a global invoice ceiling. The live value was not read.

Work: Set deliberate account limits plus a global safety stop, workflow limits and spend alerts. Verify what happens with uncertain charges, month changes, concurrent reservations and unavailable cost storage. Pair application controls with provider-side controls where available.

Acceptance evidence: Concurrent paid work stops at the intended admission thresholds; operators receive actionable alerts.

Sources: [infra/template.yaml](../infra/template.yaml), [packages/storage/src/costs.ts](../packages/storage/src/costs.ts), [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

## 10. Pricing coverage and invoice reconciliation

Priority: High. Baseline: Observed gap.

The built-in price map covers a limited set of text models. It does not include the default social text/image models or Perplexity. Server-only overrides can supply prices. Unknown prices are preserved, and observed unpriced requests fail closed when a budget is enabled.

Work: Cover every configured model, provider, search tool, image, cached input and reasoning charge. Validate native usage fields and reconcile against provider billing. Test enabling a budget without unexpectedly disabling supported workflows.

Acceptance evidence: All enabled production workflows are priced or explicitly blocked, and estimated totals reconcile within an agreed tolerance.

Sources: [apps/scanner/src/cost-observer.ts](../apps/scanner/src/cost-observer.ts), [apps/scanner/src/social-media.ts](../apps/scanner/src/social-media.ts), [packages/storage/src/costs.ts](../packages/storage/src/costs.ts).

## 11. Token efficiency, models, caching and batching

Priority: Medium. Baseline: Improve.

Analysis caching is scoped to exact inputs and account; eligible OpenAI scheduled analysis supports Batch. Output limits and structured responses already exist. Social generation can repeat style, image and review work across destinations.

Work: Measure input/output/cached/reasoning tokens and calls per completed result. Trim redundant context, cache stable style inputs, cap image references and generation fan-out, and benchmark cheaper models. Preserve fresh collection and measurement comparability when considering reuse.

Acceptance evidence: A labelled quality evaluation passes and cost per completed workflow is measured before and after each optimization.

Sources: [apps/scanner/src/analysis-costs.ts](../apps/scanner/src/analysis-costs.ts), [apps/scanner/src/analysis-batch.ts](../apps/scanner/src/analysis-batch.ts), [apps/scanner/src/social-media.ts](../apps/scanner/src/social-media.ts), [scripts/evaluate-analysis.ts](../scripts/evaluate-analysis.ts).

## 12. Prompt injection and model output trust

Priority: High. Baseline: Verify.

The app ingests websites, saved answers, social posts and images. Structured schemas, evidence validation and instructions that external content is data are present, but schemas alone do not establish trust.

Work: Test malicious text and image instructions, fabricated citations, leaking other account data and instructions to publish or call tools. Keep authority and permissions in code. Enforce approval against the exact content/media snapshot for consequential actions.

Acceptance evidence: Untrusted source content cannot expand permissions, bypass approval or turn generated text into executable authority.

Sources: [apps/scanner/src/social-media.ts](../apps/scanner/src/social-media.ts), [apps/scanner/src/scoring-extraction.ts](../apps/scanner/src/scoring-extraction.ts), [packages/core/src/social-automation.ts](../packages/core/src/social-automation.ts).

## 13. Runtime database privileges and tenant boundaries

Priority: High. Baseline: Verify.

Migration notes document production on Neon. The external runtime loads a configurable database user; its actual privileges were not inspected. The legacy Aurora path explicitly uses the master secret. No new tenant row policies appear in the application extension migrations sampled.

Work: Use restricted runtime roles and a separate migration role; inspect ownership, DDL rights, default grants and bypass privileges. Separate API and worker access where useful. Evaluate row policies as defense in depth without weakening current application checks.

Acceptance evidence: Runtime roles cannot alter schema or access data beyond their intended responsibilities.

Sources: [packages/storage/src/database-config.ts](../packages/storage/src/database-config.ts), [infra/template.yaml](../infra/template.yaml), [docs/NEON_MIGRATION.md](../docs/NEON_MIGRATION.md).

## 14. Query and transaction deadlines

Priority: High. Baseline: Observed gap.

Connection acquisition timeouts and small pools are configured. The shared database adapter does not configure statement_timeout, lock_timeout or idle-in-transaction limits. Database-side defaults remain unverified.

Work: Set reviewed database/role limits, shorter API query deadlines and transaction bounds. Cancel expensive work when a request expires. Verify pool rollover, failed commits and rollback behavior under connection loss.

Acceptance evidence: A blocked or expensive query terminates before it exhausts the API or worker execution budget.

Sources: [packages/storage/src/database-config.ts](../packages/storage/src/database-config.ts), [packages/storage/src/sql.ts](../packages/storage/src/sql.ts).

## 15. Query size, pagination and repeated reads

Priority: Medium. Baseline: Observed gap.

Some answer lists paginate in SQL and have compact projections. Other dashboards load all matching history for a period, calculate in memory, and may read legacy evidence from S3. Some routes paginate only after loading their source data.

Work: Profile the slowest and most frequent queries. Move suitable filtering, aggregation and pagination into SQL; reduce JSON payloads and repeated evidence reads. Use stable cursors where offsets become expensive, and bound active-job reconciliation.

Acceptance evidence: Representative large-account workloads meet latency, memory, query-count and database-transfer targets.

Sources: [apps/api/src/dashboard.ts](../apps/api/src/dashboard.ts), [apps/api/src/app.ts](../apps/api/src/app.ts), [packages/storage/src/postgres.ts](../packages/storage/src/postgres.ts), [packages/storage/src/agents-postgres.ts](../packages/storage/src/agents-postgres.ts).

## 16. Indexes, integrity, transactions and migrations

Priority: High. Baseline: Verify.

The repository uses parameter binding, optimistic version checks, transactions and advisory locks. Migrations have checksums, a migration lock and rehearsal tooling. There are existing typed reporting indexes.

Work: Use real query plans and statistics before changing indexes. Test constraints, concurrent writes, lock ordering and job counters on real PostgreSQL. Validate additive migrations, mixed-version compatibility, roll-forward recovery and backup before destructive changes.

Acceptance evidence: Production-like concurrency and migration rehearsals pass; query plans support the agreed workload.

Sources: [packages/storage/src/sql.ts](../packages/storage/src/sql.ts), [database/migrations/011_storage_efficiency.sql](../database/migrations/011_storage_efficiency.sql), [tests/postgres.test.ts](../tests/postgres.test.ts), [scripts/rehearse-neon-migration.ts](../scripts/rehearse-neon-migration.ts).

## 17. HTTP timeouts, response bounds and contract validation

Priority: Medium. Baseline: Observed gap.

Provider requests have deadlines and safe error classification. The shared provider transport reads JSON without a byte cap and follows fetch's redirect default. Batch response size is checked after the full body is buffered. Several request bodies are also checked after text() completes.

Work: Standardize bounded streaming reads, connect/body/overall deadlines, approved destinations, redirect policy and upstream schema validation. Apply byte limits before allocation, and preserve uncertainty for paid mutations. Reuse the bounded MCP body-reader pattern where appropriate.

Acceptance evidence: Slow, oversized, redirected or malformed upstream responses fail within predictable resource limits.

Sources: [apps/scanner/src/provider-http.ts](../apps/scanner/src/provider-http.ts), [apps/scanner/src/openai-batch.ts](../apps/scanner/src/openai-batch.ts), [apps/api/src/app.ts](../apps/api/src/app.ts), [apps/api/src/mcp.ts](../apps/api/src/mcp.ts).

## 18. Queue reliability, retries and idempotency

Priority: High. Baseline: Verify.

Scan leases, durable stages, retry budgets, delayed dispatch, deadlines, reconciliation and uncertain-call handling already exist. Social automation also stores generation and publication intent and receipts.

Work: Fault-test duplicates, lost responses, crashes between S3 and SQL writes, partial batch results, poison messages, cancellation and manual retries across every worker family. Distinguish safe read retries from uncertain paid calls and publication.

Acceptance evidence: Fault injection produces no duplicated accepted results, unauthorized publications or blind repeat purchases.

Sources: [apps/scanner/src/engine.ts](../apps/scanner/src/engine.ts), [apps/scanner/src/social-automation.ts](../apps/scanner/src/social-automation.ts), [apps/scanner/src/handler.ts](../apps/scanner/src/handler.ts).

## 19. Fleet capacity, fairness and execution cost

Priority: High. Baseline: Verify.

Lambda concurrency, queue concurrency, small database pools and provider pacing are configurable. Each warm Lambda can create its own database pool; several workflow families share execution and provider resources.

Work: Load-test tenant fairness, total database connections, queue age, provider throughput, reconciliation and API latency together. Bound per-account work and align lease, request, visibility and Lambda timeouts. Measure Lambda duration, memory and egress costs.

Acceptance evidence: A busy account and provider outage do not starve other tenants or recovery work.

Sources: [infra/template.yaml](../infra/template.yaml), [infra/template.yaml](../infra/template.yaml), [packages/storage/src/database-config.ts](../packages/storage/src/database-config.ts), [apps/scanner/src/provider-admission.ts](../apps/scanner/src/provider-admission.ts).

## 20. Uploads, media processing and publishing

Priority: High. Baseline: Improve.

Private version-pinned uploads, MIME/size/signature checks, expiration and approval snapshots exist. Media processing uses ffmpeg/ffprobe and shares the worker environment. Current objects and abandoned uploads have no dedicated deletion policy in the inspected configuration.

Work: Fuzz malformed files and enforce pixel, frame, duration and processing limits. Assess isolating native parsers from provider secrets and publishing credentials. Clean up abandoned uploads, test signed URL expiry and replay, and verify approved bytes/content cannot change before publication.

Acceptance evidence: Untrusted media cannot exceed processing bounds or gain broader worker authority; publication matches the approved snapshot.

Sources: [packages/storage/src/social-uploads.ts](../packages/storage/src/social-uploads.ts), [apps/scanner/src/social-video.ts](../apps/scanner/src/social-video.ts), [apps/api/src/social.ts](../apps/api/src/social.ts), [packages/core/src/social-automation.ts](../packages/core/src/social-automation.ts).

## 21. Error visibility, security audit trails and alerts

Priority: High. Baseline: Observed gap.

Logs redact sensitive provider failures; MCP records audit events. Infrastructure alarms on Lambda Errors and queue health. The API catches failures and returns HTTP 500, which can leave Lambda's Errors metric at zero. No API Gateway 5xx alarm is declared in this template.

Work: Alert on actual HTTP failures, latency, throttles, handled worker failures, stuck jobs, cost-ledger failures and unusual spend. Correlate request, account, run and provider IDs. Add durable audit records for access, settings, credential and publication changes.

Acceptance evidence: Synthetic failures trigger the right notification and lead operators to a useful, redacted trace.

Sources: [apps/api/src/app.ts](../apps/api/src/app.ts), [infra/template.yaml](../infra/template.yaml), [apps/api/src/mcp.ts](../apps/api/src/mcp.ts), [apps/scanner/src/cost-observer.ts](../apps/scanner/src/cost-observer.ts).

## 22. Backups and tested restoration

Priority: High. Baseline: Verify.

Migration notes document Neon seven-day point-in-time recovery, daily snapshots retained 14 days and retained Aurora recovery snapshots. Evidence storage is versioned. These configuration claims were not verified against live services.

Work: Define recovery time and acceptable data loss. Restore SQL, evidence, identities and configuration into an isolated environment; verify their consistency. Review deletion protection, backup access and accidental account deletion recovery.

Acceptance evidence: A timed restoration drill demonstrates the agreed recovery targets using the active production services.

Sources: [docs/NEON_MIGRATION.md](../docs/NEON_MIGRATION.md), [infra/template.yaml](../infra/template.yaml), [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## 23. Retention, deletion and data minimization

Priority: High. Baseline: Observed gap.

Documentation explicitly says current SQL records and evidence have no automatic deletion policy. S3 expires noncurrent versions and the analysis cache separately. URLs are stripped of queries and country lookup avoids storing IPs in the traffic collector.

Work: Choose retention by data class: answers, prompts, PII, cost events, logs, media, caches and provider files. Implement account deletion/export and a backup-expiry policy. Review provider-side retention, regional data paths and what content is sent to each service.

Acceptance evidence: A test account can be exported and deleted across all active stores while retained records have documented reasons and expiry.

Sources: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md), [infra/template.yaml](../infra/template.yaml), [apps/api/src/traffic.ts](../apps/api/src/traffic.ts).

## 24. Cloud permissions, network exposure and configuration drift

Priority: High. Baseline: Verify.

The template uses scoped secret ARNs, blocked public S3 access, encrypted storage, TLS policies, OIDC deployment and configurable concurrency. Production documentation records a move to externally hosted PostgreSQL and retirement of legacy network resources.

Work: Compare deployed IAM, bucket policies, database access, DNS/TLS, frontend configuration and deployment environments with source. Reduce API/worker blast radius, review outbound access, provider restrictions and edge abuse controls appropriate to the architecture.

Acceptance evidence: A production configuration inventory shows intended exposure and least-privilege permissions with no unexplained drift.

Sources: [infra/template.yaml](../infra/template.yaml), [infra/template.yaml](../infra/template.yaml), [.github/workflows/deploy.yml](../.github/workflows/deploy.yml), [docs/NEON_MIGRATION.md](../docs/NEON_MIGRATION.md).

## 25. Incident response, rollback and safe operations

Priority: High. Baseline: Verify.

Maintenance mode, provider quota recovery and database cutover runbooks already exist. Older documentation and legacy infrastructure defaults coexist with the documented current Neon setup.

Work: Assign alert ownership and escalation. Rehearse compromised credentials, provider overspend, account exposure, database failure and a bad deployment. Maintain tested stop switches, rollback compatibility and a clear current production runbook; keep destructive tools preview-first.

Acceptance evidence: Operators can stop affected work, rotate access, preserve evidence and recover using a rehearsed runbook.

Sources: [apps/api/src/handler.ts](../apps/api/src/handler.ts), [docs/SCANNER_RESILIENCE.md](../docs/SCANNER_RESILIENCE.md), [docs/DATABASE_CUTOVER_MAINTENANCE.md](../docs/DATABASE_CUTOVER_MAINTENANCE.md).

## 26. Known vulnerable dependencies and supply-chain checks

Priority: High. Baseline: Observed gap.

The approved npm audit flagged three packages: zod 3.25.76 (high, production), vitest 4.1.11 and @vitest/mocker 4.1.11 (moderate, development). The latter two share advisory lineage. Existing CI does not declare dependency, secret, static-security or infrastructure-security scanning.

Work: Triage Zod input reachability and plan a compatible patched-version migration; the audit's suggested fix crosses a major version. Update Vitest tooling and verify runtime bundling. Add ongoing vulnerability/secret/static/infrastructure checks, update ownership and immutable action references.

Acceptance evidence: Reachable high-risk findings are fixed or explicitly mitigated, dependency changes are regression-tested and CI enforces the policy.

Sources: [package.json](../package.json), [package-lock.json](../package-lock.json), [.github/workflows/ci.yml](../.github/workflows/ci.yml).

## 27. Security, integration and failure testing

Priority: High. Baseline: Improve.

The current run passed TypeScript and 125 test files: 1,521 tests passed and one skipped. The suite includes permission, OAuth, resilience and embedded-PostgreSQL tests. Passing tests alone do not establish live database, browser, cloud or hostile-input behavior.

Work: Map meaningful tests to the threat model. Add targeted real-PostgreSQL integration, staging browser journeys, abuse/fuzz tests, migration checks, load tests and external penetration testing before broad production assurance. Track the skipped test's reason.

Acceptance evidence: Critical security and recovery requirements have independent tests and staging evidence.

Sources: [vitest.config.ts](../vitest.config.ts), [tests/mcp-oauth.test.ts](../tests/mcp-oauth.test.ts), [tests/scanner-resilience-integration.test.ts](../tests/scanner-resilience-integration.test.ts), [.github/workflows/ci.yml](../.github/workflows/ci.yml).

## 28. Maintainability and consistent implementation

Priority: Medium. Baseline: Observed gap.

TypeScript strict mode is enabled. The central API file has 1,347 lines, the scanner engine 1,067 and the main PostgreSQL adapter 996. No lint/format configuration or lint script was found in the repository inventory.

Work: Define module boundaries and common validation, error, authorization and transport patterns. Split large modules around stable responsibilities when touching them; enforce linting and formatting, reduce unsafe casts and replace silent catches with intentional recovery or telemetry.

Acceptance evidence: New routes and workflows use shared controls and automated checks without duplicating security logic.

Sources: [tsconfig.json](../tsconfig.json), [apps/api/src/app.ts](../apps/api/src/app.ts), [apps/scanner/src/engine.ts](../apps/scanner/src/engine.ts), [packages/storage/src/postgres.ts](../packages/storage/src/postgres.ts).

## 29. Frontend performance, caching and reporting correctness

Priority: Medium. Baseline: Verify.

The client scopes cached reads by identity and path, clears denied data and invalidates writes. Reports rely on provider, prompt-version, cohort and date semantics; demo data is derived through a dedicated runtime.

Work: Measure bundle size, render cost, polling volume, query duplication and memory on large accounts. Test account switching, stale responses, cache invalidation and export consistency. Preserve demo/real data separation and verify denominators, missing data and timezone boundaries.

Acceptance evidence: A large-account browser journey stays responsive and all views agree on access, data freshness and metric definitions.

Sources: [apps/client/src/query-cache.ts](../apps/client/src/query-cache.ts), [apps/client/src/api.ts](../apps/client/src/api.ts), [packages/core/src/prompt-metrics.ts](../packages/core/src/prompt-metrics.ts), [packages/storage/src/demo.ts](../packages/storage/src/demo.ts).

## 30. Accessibility and safe user-facing workflows

Priority: Medium. Baseline: Verify.

The application includes account switching, filters, previews, approvals and asynchronous progress/error states. This review did not perform a complete interactive accessibility or browser-compatibility pass.

Work: Check keyboard and screen-reader use, focus management, labels, contrast and responsive layouts. Make queued, uncertain, failed and stale states understandable. Ensure retries and approvals cannot accidentally purchase work or publish outdated content.

Acceptance evidence: Core login, reporting, scan and approval journeys pass browser and accessibility checks with clear failure recovery.

Sources: [apps/client/src/AccountSwitcher.tsx](../apps/client/src/AccountSwitcher.tsx), [apps/client/src/SocialPublicationReview.tsx](../apps/client/src/SocialPublicationReview.tsx), [apps/client/src/Loading.tsx](../apps/client/src/Loading.tsx).
