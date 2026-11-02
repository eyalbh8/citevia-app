# Database execution and privilege controls

The API and scanner use `productionDatabase()` with the restricted runtime login. Schema changes use `migrationDatabase()` from the dedicated migration Lambda, with a separate direct owner connection. The scanner rejects `database:migrate`; it must never receive the migration secret or permission to read it.

## Deadlines and pooled connections

Runtime defaults are a 15-second server statement deadline, 5-second lock wait, 15-second idle transaction deadline and 20-second client query deadline. Explicit transactions use transaction-local `set_config(..., true)`, which works with Neon's transaction pooling. Standalone statements rely on the runtime role's database-specific defaults. The provisioning and rehearsal tools verify these defaults. Client deadlines alone cannot prove the server stopped executing an ambiguous write; failed transactions are discarded and writes are never automatically retried by the SQL adapter.

The defaults are configurable with positive integer millisecond values:

| Variable | Runtime default | Maximum |
| --- | ---: | ---: |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 15000 | 60000 |
| `DATABASE_QUERY_TIMEOUT_MS` | 20000 | 65000 |
| `DATABASE_LOCK_TIMEOUT_MS` | 5000 | 30000 |
| `DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` | 15000 | 60000 |

`QUERY_TIMEOUT_MS` must exceed `STATEMENT_TIMEOUT_MS`; the lock limit cannot exceed the statement limit. Invalid settings fail closed. Changing runtime statement, lock or idle limits also requires updating the login's PostgreSQL role defaults, rehearsing the change and reconnecting pooled clients. Environment changes alone affect explicit transactions, not existing standalone role defaults.

Migrations use the corresponding `DATABASE_MIGRATION_*_TIMEOUT_MS` names, with defaults of 240000/250000/10000/30000 milliseconds for statement/query/lock/idle. The statement/query maxima are 600000/610000 milliseconds. Match the migration Lambda timeout to any increased deadline. The production runtime and migration pools hold at most two and one connections respectively. Pool credential caches expire after five minutes; individual external connections live at most four minutes.

## Separate secrets

- Runtime: `DATABASE_MODE=external`, `DATABASE_SECRET_ARN` pointing to the restricted login's pooled endpoint.
- Migration: `DATABASE_MODE=external`, `DATABASE_MIGRATION_SECRET_ARN` pointing to the owner login's direct endpoint. A `-pooler` host is rejected, and there is no fallback to the runtime secret.
- Local PostgreSQL: runtime `DATABASE_URL` and separate `DATABASE_MIGRATION_URL` are supported in `DATABASE_MODE=aurora` for existing development compatibility.
- Aurora migration configuration uses `DATABASE_MIGRATION_SECRET_ARN` and `DATABASE_MIGRATION_HOST` (or the existing `DATABASE_HOST`), verified TLS and the existing CA bundle.

Both Secrets Manager objects use the existing strict JSON fields: `host`, optional numeric `port`, `database`, `username`, `password`. Never store the JSON or password in Git, Lambda environment variables, CI logs, CLI arguments, or documentation.

## Least-privilege rollout

1. Run `scripts/inspect-database-security.ts --secret-arn OWNER_SECRET` with the approved AWS profile. It opens a read-only transaction and prints only privilege, schema-health and storage aggregates.
2. Create an isolated Neon branch from the production branch with a short expiry. Use `scripts/rehearse-database-runtime-role.ts --source-secret-arn OWNER_SECRET --branch-host CHILD_DIRECT_HOST --branch-id CHILD_BRANCH_ID` to preview, then add `--apply` to rehearse. It refuses the source endpoint, connects only to the child, verifies migration checksums, creates a fresh role, checks actual pooled role defaults, exercises repository reads and rolled-back scanner writes, denies seven schema/unrelated-data operations, and verifies server statement/lock cancellation.
3. Preview production grants with `scripts/provision-database-runtime-role.ts --secret-arn OWNER_SECRET --expected-host DIRECT_HOST --expected-database citevia --role citevia_runtime_v1`. The preview is read-only. The explicit allowlist lives in `scripts/lib/database-runtime-role.ts`.
4. Add `--apply --runtime-host POOLED_HOST --credentials-file /private/0700-directory/runtime.json` only after successful rehearsal. The tool saves a new exclusive 0600 credential file before committing the new login. Preserve that file if the command reports an ambiguous network failure, inspect whether the role was created, and do not overwrite the role blindly. No passwords or server error text are printed. Move the credential into the dedicated runtime Secrets Manager secret, then remove the temporary local file after verification.
5. Deploy the dedicated migration Lambda and its owner-secret IAM grant. The API and scanner should read only the runtime secret. Run the dedicated migration Lambda, then switch the application runtime secret and smoke-test authentication, account/project reads, scanner capture/analysis and asynchronous job reconciliation. Verify the effective login and its role defaults using the runtime secret.
6. Preserve the previous runtime secret/version and application release for rollback. Roll back the application secret reference if representative business flows fail; the new role and grants are additive and do not change stored customer data.

For the AWS rollout, `scripts/prepare-database-credentials.ts` provides an alternative to step 4 that keeps credentials entirely in memory and Secrets Manager. Supply `--source-secret-arn`, `--expected-host`, `--expected-database`, `--role`, `--runtime-secret-name` and `--migration-secret-name`. Preview is the default; `--apply` creates only fresh secrets and a fresh role, preserves the source secret, then performs read-only repository checks through the new pooled runtime login. It never switches application configuration. If a partial failure occurs, it reports the stage and any new secret ARNs so an operator can inspect and recover without blindly rotating credentials. Existing target secret names cause a refusal, including after a partially successful previous attempt.

The provisioner only creates a fresh `citevia_runtime_*` role. It grants CRUD on the explicit application tables and USAGE on their owned sequences, without TRUNCATE, TRIGGER, schema creation, owner memberships, superuser, role creation, database creation, replication or RLS bypass. It excludes the migration ledger and unrelated legacy tables. It refuses any pre-existing role, missing application table, or PUBLIC privilege/security-definer function that could undermine those restrictions. It does not revoke global privileges or change existing roles automatically.

Every migration that adds a runtime table must extend the reviewed allowlist and update runtime grants before application code uses that table. Future grant refreshes and password rotation need their own reviewed maintenance procedure; recreating an existing role is deliberately unsupported.

## Verification and remaining boundaries

`tests/database-connection.test.ts` covers client limits, transaction-local server limits, concurrent client isolation, failed rollback handling, ambiguous timeout handling and runtime/migration pool separation. `tests/database-runtime-role.test.ts` provisions the real migration schema in PGlite, verifies every table's privileges and exercises repository identity/project/membership behavior. `tests/migration-handler.test.ts` covers strict direct-invocation input, maintenance freeze and connection cleanup. The isolated Neon rehearsal adds actual LOGIN/PgBouncer and server deadline evidence beyond local tests.

The runtime role still serves multiple tenants; application authorization is the tenant boundary. This work does not claim PostgreSQL row-level security, an independent penetration test, restore-test certification, or an audit certification. Retention and point-in-time recovery must be reviewed against the required recovery objectives, and restore rehearsals, slow-query monitoring, access reviews and credential rotation must remain operational processes.

References: [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [node-postgres client configuration](https://node-postgres.com/apis/client), [PostgreSQL role settings](https://www.postgresql.org/docs/17/sql-alterrole.html), [PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html).
