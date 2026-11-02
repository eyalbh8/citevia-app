# Security and operational assurance

Owner contacts: eyal@citevia.io, gaby@citevia.io, info@citevia.io. Review date: 2026-11-02.

This program aims at a defensible, evidence-backed security baseline. It is not a SOC 2/ISO 27001 certification, a penetration-test report, or a guarantee that every vulnerability has been found. The [30-area inventory](SECURITY_REVIEW_INVENTORY.md) records the full scope and acceptance criteria. Preserve the evidence below and refresh it after material changes.

## Implementation and rollout plan

1. Establish a baseline: inventory application boundaries, dependencies, provider calls, database privileges and live AWS configuration. Preserve deployment parameters and prior secret references for rollback.
2. Patch dependencies and add repeatable gates: TypeScript, behavior tests, security lint, vulnerability audit, secret history scan, dependency inventory, CloudFormation policy checks and pinned workflow actions.
3. Bound application work: streaming request/response limits, JSON complexity, per-user/per-account request admission, safe upstream redirects/timeouts, shared provider concurrency and monthly cost reservations.
4. Separate privilege: restrict normal database access to the 44 application tables; put owner credentials only on a dedicated, IAM-invoked migration function; separate provider secrets so publishing access does not expose AI credentials.
5. Deploy operational safeguards: encrypted logs, actual HTTP 5xx/latency/throttle alarms, SQS and asynchronous reconciliation failure capture, cost-ledger failure alarms, private storage access logs and security response headers.
6. Establish account-level detection: independent retained multi-region CloudTrail, log integrity validation, regional GuardDuty with S3/Lambda protection, retained findings and security-change alerts.
7. Rehearse, release and verify: test real pooled PostgreSQL privileges/deadlines on an isolated production branch; run the full suite and build; inspect CloudFormation changes; deploy preserving existing routing/model/schedule settings; check health, authorization, logs, alarm delivery state and database identity.
8. Complete operational acceptance: confirm SNS subscriptions, run authenticated browser smoke tests, review identity-provider MFA/recovery, measure load/fairness, reconcile invoices and perform a timed restoration drill. Track these as open until evidence exists.

## Implemented controls

- Authentication and account membership remain server-side. The existing tenant/owner/disabled-user tests continue to run. New authenticated HTTP limits use durable, atomic counters shared by Lambda instances: per-user read/write defaults 600/120 per minute, and per-account 1,200/240 per minute. A 429 includes `Retry-After`.
- JSON requests are bounded while reading and before schema validation. API character limits remain compatible with multilingual content; nesting, collection size and total nodes are bounded. Provider and batch bodies are bounded while streaming, redirects are refused for paid requests, and uncertain paid outcomes retain their reservation.
- Every paid scan, onboarding, content and social model call is accounted for through reservation/outcome handling and shared provider admission. Model configurations and saved measurement snapshots are preserved. Search tool fan-out is bounded.
- Runtime PostgreSQL uses a separate non-owner login, explicit CRUD grants on 44 application tables, no migration-ledger/legacy-table access, no role/schema privileges, and role-level deadlines. API/scanner IAM cannot read the migration secret. The migration Lambda has no public or scheduled event source.
- Provider secrets are separated by function. The original combined secret remains available to operators for rollback until old workers have drained; normal API/scanner roles move to individual secret ARNs.
- API responses include security headers. Frontend enforcement covers HTTPS, base URL, objects and framing; the stricter source policy starts in report-only mode to preserve Descope SSO, CAPTCHA and signed media workflows pending complete browser evidence.
- Operational logs retain 90 days under a rotating customer-managed KMS key. Storage access logs retain 90 days. Audit records omit request bodies, query strings, credentials and arbitrary path identifiers.
- Dependency audit, lint, tests and typecheck are release checks. Scheduled security CI checks dependencies, a CycloneDX SBOM, Git history secrets and both infrastructure templates. Workflow actions are pinned to verified commits; npm is pinned to the tested installer version.

## Monthly cost policy

The user-selected target is **$100 per customer account per UTC calendar month**, including AI, database, storage and other APIs. The initial admission policy allows at most **$70 of estimated/reserved AI work**, leaving **$30 for infrastructure and other services**. A stricter configured AI allowance wins. An optional global AI allowance exists but remains unset because no whole-application amount has been chosen.

Admission is serialized in the database so concurrent calls cannot all spend the same remaining allowance. Calls without a price or explicit policy reservation fail closed; ambiguous or incomplete billing retains a conservative hold rather than being treated as free. Social image and vision calls reserve $3 each; Perplexity fast reserves $1; these are holds, not advertised provider prices or guaranteed maximum charges. Verified native USD totals and valid usage counters settle the reservation. Operators must reconcile unresolved holds before releasing them.

The $30 reserve is a planning allocation. AWS/Neon/shared API invoices are delayed and are not divided by customer automatically by those vendors. It would be inaccurate to call this an exact $100 all-in invoice ceiling. Storage, mandatory security logging and in-flight charges cannot safely be stopped by deleting customer data. If measured non-AI allocation exceeds $30, reduce the AI allowance or adjust usage before the next period.

Use `npm run costs:report -- --mode aws --project ACCOUNT_ID` for completed AI estimates, outstanding holds and remaining admission. Add `--non-ai-usd AMOUNT` only after allocating verified non-AI charges for that account and reporting period. Missing allocations keep the all-in total explicitly unknown. Allocate dedicated charges directly; allocate shared compute/API usage by measured requests/duration and storage by bytes; divide fixed platform/security cost using a documented active-account rule. Reconcile with provider, AWS and Neon invoices monthly and investigate any unknown billing rows.

The report's production connection uses `DATABASE_MODE=external` and
`DATABASE_SECRET_ARN` pointing to the deployed restricted runtime credential,
with the approved operator AWS profile. It does not need the migration secret.
[The operator command and policy overrides](COST_OPTIMIZATION.md#cost-visibility-and-budget-semantics)
keep passwords and secret JSON out of command arguments and logs. The report
uses the 100/30/70 defaults unless the configured policy is supplied explicitly.
Setting the standalone AI allowance to zero does not disable a configured
account policy; a reserve greater than or equal to the account allowance is invalid.

Before enabling a global AI allowance at production scale, profile the global
monthly reservation query and its transaction lock wait under representative
concurrency. The existing reservation index begins with `project_id` and serves
account-scoped admission; it is not proof of efficient all-account month scans.
Review a partial `created_at` index for reservation rows if the measured plan
requires it, using an additive migration and normal runtime-grant review. The
global check serializes admissions, so its query latency is part of fleet
throughput. This capacity acceptance remains open while the global cap is unset.

## Database and recovery evidence

See [database-security.md](database-security.md), [Neon rehearsal evidence](database-runtime-role-rehearsal-2026-11-02.json), and [production role preparation](database-runtime-role-production-2026-11-02.json). The rehearsal verifies migration checksums, real pooled-login timeout defaults, representative API/scanner operations, rollback and permission denial. It proves the tested role transition, not a complete disaster-recovery exercise.

Neon reports seven-day point-in-time history. Existing evidence S3 objects remain versioned. Preserve current customer data until retention periods and deletion/export requirements have been approved. Current SQL/evidence has no blanket automatic expiration. Define recovery-time/data-loss targets with the business and record a timed SQL+evidence restoration before representing recovery as tested end to end.

## Release and rollback

- Build three Lambda bundles with `npm run build`; package `infra/template.yaml`. Use the deployed parameters as the starting point. In production retain external database mode, retired Aurora flags, queue concurrency 2 and the current provider/model settings.
- Do not enable reserved Lambda concurrency while the account quota is only 10. That is insufficient for the template's reservations. Keep queue concurrency bounded and monitor throttles; request a quota increase before reserving capacity.
- Change `ExternalDatabaseSecretArn` to the restricted runtime secret and `DatabaseMigrationSecretArn` to the direct owner secret. Keep owner access off the scanner. Invoke `MigrationFunctionName` with `{"kind":"database:migrate"}`; the scanner rejects that payload.
- Set all three alert email parameters and the 100/30/70 cost parameters. A recipient must click its AWS SNS confirmation link before emails can be delivered.
- Inspect the change set before executing. Reject unexpected database recreation, customer-data replacement/deletion, provider model changes, domain changes or legacy network restoration. Keep the previous packaged template and parameter manifest.
- Deploy `infra/security-account.yaml` as **`${applicationStackName}-security`** so its alarms match the parent topic/key policies. Do not create a second detector/trail if another owner has since enabled one. Retained audit resources require an explicit reviewed retirement procedure.
- For a release regression, deploy the previous backend code and parameter manifest, including the previous database/provider secret ARNs. The old credentials and schema remain intact. Stop new paid work if outcomes are uncertain; inspect checkpoints rather than repurchasing. Roll the frontend back to the previous successful Amplify deployment if needed.
- Verify GET `/health`, unauthenticated API denial, OAuth metadata, tracker delivery, response headers, current Lambda database identity, CloudFormation completion and alarms after release. Do not trigger paid scans, content generation or publication merely as a smoke test.

## Incident response

Eyal, Gaby and the shared info inbox receive operational/security alerts. Assign the first responder and incident lead when an event occurs. Record UTC times, affected accounts/resources, observed evidence and authorized actions in an incident record.

For a suspected credential compromise, revoke the affected integration/session and rotate that specific secret; preserve log evidence. For an uncertain provider/publishing outcome, inspect the persisted intent/receipt before retrying. For API/database saturation, inspect HTTP errors, throttles, queue age and query waits, then reduce admission or pause the affected workload. Use the existing maintenance switch only if a coordinated write freeze is required; it intentionally affects customer availability.

After containment, verify cross-account exposure, scope customer impact, restore from known-good artifacts, reconcile billed work, and document the cause and corrective action. Customer/regulatory notification decisions require the responsible business/legal owner; do not claim a statutory deadline without jurisdiction-specific review.

## Remaining acceptance work

These are material due-diligence items, not findings that should be silently marked complete:

- Independently validate administrator MFA, recovery, access reviews and session-revocation behavior in Descope and AWS IAM. User-controlled MFA enrollment cannot be completed by code changes alone.
- Run an authenticated browser journey covering login/SSO, dashboards, uploads, OAuth consent and publishing approval; enforce the strict CSP only after all supported paths pass.
- Commission independent penetration testing and verify remediation; automated tests and dependency scans do not replace it.
- Complete production-size query profiling/load and tenant-fairness tests. Preserve report completeness when moving full-history aggregation into SQL; do not truncate records as an optimization.
- Define data retention, account deletion/export, vendor/subprocessor responsibilities and contractual requirements; retain customer records until those requirements are settled.
- Complete a timed recovery drill with SQL and S3 evidence consistency, and define RPO/RTO based on actual recovery results.
- Reconcile all-in costs and validate provider billing fields for every enabled model. A configured global AI ceiling and vendor-side billing safeguards remain separate operational decisions.
- Assess WAF coverage for the HTTP API topology. This application uses API Gateway **HTTP API v2**; direct REST API WAF recipes do not apply. Adding an edge layer requires an origin-bypass design and compatibility testing. Current controls include gateway throttling, authenticated durable limits and bounded inputs.
- Isolate native media parsing from publishing/provider authority if threat modeling or fuzz testing indicates the shared worker boundary is insufficient.
- Review branch protection, required reviewers, environment access, credential rotation cadence, inventory ownership and vendor/security evidence with the business. Document who owns each control and the recurring review cadence.

## Reference baseline

Use [OWASP ASVS](https://asvs.owasp.org/) for application verification and [OWASP's prompt-injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) for untrusted model inputs. AWS implementation references: [custom headers](https://docs.aws.amazon.com/amplify/latest/userguide/setting-custom-headers.html), [CloudTrail](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudtrail-trail.html), [GuardDuty](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_settingup.html), [encrypted SNS alarm delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html) and [CloudWatch log encryption](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html).
