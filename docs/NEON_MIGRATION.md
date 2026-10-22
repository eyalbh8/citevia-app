# Aurora to Neon PostgreSQL cutover

This procedure moves the complete database with PostgreSQL's native archive tools.
It preserves all baseline tables, empty tables, users, memberships, scans, answers,
legacy `results`, workflow leases, OAuth grants, migration checksums and sequences.
The helper does not switch Lambda endpoints, run application migrations or delete
the source. Keep the existing S3 evidence bucket and object keys unchanged.

## Production configuration (2026-10-22)

Citevia's production API and scanner now use Neon PostgreSQL 17 in AWS us-east-1,
project `citevia-production`, branch `production`. All 125 original tables and
1,816 original rows were copied and fingerprint-verified. Migrations 011–013
preserve every original column value; repository reads, both rolled-back write
policies, and the live account/dashboard/history/original-answer checks passed.
The final implementation passes 644 tests, TypeScript/build, and SAM validation.

Production uses the pooled endpoint through the reviewed Secrets Manager JSON
credential, strict TLS, `DatabaseMode=external`, `MaintenanceMode=false`,
`CompactRunState=true`, `WriteCompatibilityResults=true`, and
`AnalysisBatchEnabled=false`. Launch is configured for seven-day PITR and daily
03:00 UTC snapshots retained for 14 days, plus the post-migration recovery snapshot.

`RemoveLegacyNetwork=true` and `RetireLegacyDatabase=true` preserve the completed
cutover on later deployments. The NAT, public IP, tunnel, and tunnel IAM resources
are removed. Aurora cluster and writer deletion are verified, and the encrypted final
snapshot `citevia-final-neon-20261022-1717` is available. Automated backups were
retained during deletion; the encrypted pre-cutover snapshot remains available
as an additional recovery point.

Use the migration-aware workflow in this tree for future deployments. The older
workflow on GitHub main now refuses a deployment after external PostgreSQL cutover.
The local, ignored SAM configuration also explicitly preserves the production
external/retirement settings. `db_tunnel prod` explains that external PostgreSQL
uses a direct provider connection rather than trying to recreate an AWS tunnel.

After reopening traffic, Aurora is stale. Restore current Neon data into a fresh
compatible PostgreSQL destination for a full rollback; never switch back to an old
snapshot and discard newer production writes. An Aurora snapshot taken during the
source read-only fence also retains that database default; remove the fence only
on a reviewed restored destination, after reconciling the data to be served.

## Prerequisites

- A fresh Neon database on PostgreSQL **17**, using a direct endpoint for migration
  and its corresponding pooled endpoint for application traffic. Local `pg_dump`
  and `pg_restore` are 17.6; the helper refuses a target older than the dump tool.
  The migration source used PostgreSQL 16.9.
- Source database credentials and its existing private SSM tunnel; target owner
  credentials; permission to create a Secrets Manager secret for the application.
  Load credentials into `SOURCE_DATABASE_URL` and `TARGET_DATABASE_URL` securely.
  Do not put literal URLs in shell history, repository files, chat or build logs.
- Use the real Aurora hostname in the source URL for certificate verification.
  Set the URL port to the local forwarded port, `SOURCE_PGHOSTADDR=127.0.0.1`, and
  `SOURCE_PGSSLROOTCERT` to the checked-in `database/rds-ca.pem` absolute path.
  The target URL must use its direct Neon DNS hostname. TLS verifies certificates
  and hostnames; the helper does not accept an insecure verification bypass.
- Review source extensions, database locale, native roles/grants and any external
  readers before cutover. `--no-owner --no-privileges` makes the restoring Neon
  role own the objects; application users in the `users` table remain untouched.
  Recreate intentional native database grants separately. Keep the production
  compatibility mirror enabled while external `results` consumers remain uncertain.

The helper verifies at most 512 MiB of relation storage by default and rejects
unaccounted-for non-public objects, foreign tables or large objects. Expand the audit
before migrating such a database. It reads customer rows only inside PostgreSQL to
compute SHA-256 multiset fingerprints; row text is never printed or placed in the
JSON manifest. The native archive contains customer data and must remain private.

## Rehearsal and final export

An isolated rehearsal can run while the Aurora application remains live. Create a
fresh child branch from the empty Neon destination, verify its endpoint belongs
to that child through the Neon API, and use the separate rehearsal operator:

```sh
node --import tsx scripts/rehearse-neon-migration.ts \
  --connections-file /private/path/rehearsal-connections.json \
  --output-dir /private/path/rehearsal \
  --expected-target-host ep-child.region.aws.neon.tech \
  --rehearsal-branch-id br-child
```

The private connection JSON contains `sourceDatabaseUrl`, `targetDatabaseUrl`,
and optional `sourcePgHostaddr`, `sourcePgSslRootcert`, `targetPgSslRootcert`.
Require mode 0600 for this file and 0700 for its output directory. The preview
only reads both databases. Append `--apply` to export one shared read-only source
snapshot, restore the complete native archive into that empty child, verify its
exact inventory, apply target migrations, and verify every original column's row
fingerprint again. Migration-ledger comparison preserves all original ledger
rows while allowing the new checked migrations. It compares email normalization,
search behavior and traffic attribution using aggregate fingerprints, records
fixed Unicode probes, exercises repository reads, then checks both checkpoint
write modes inside a transaction that is rolled back and verified against the
complete inventory. Native tools must be supplied through `--pg-dump` and
`--pg-restore` if they are outside `PATH`.

The source remains explicitly read-only in both the exporter and `pg_dump`; its
exporting transaction stays open until the dump finishes. The source can advance
after that snapshot. Sequence state is not transactional, so any sequence mismatch
still fails exact-copy verification. This rehearsal never switches application
endpoints and always reports `cutoverReady:false`. Its archive is for rehearsal;
final cutover needs a new export with the writer fence below. Keep the production
Neon root empty until the final verified export is available.

Read-only inspection:

```sh
node --import tsx scripts/neon-migration.ts inspect
```

It checks both connections, direct target identity, server/tool versions, exact
row counts, schema objects and sequence state. Default `dump` and `restore` are
previews. A real export or restore requires `--apply --writers-paused`.

Before the final export, enable `CITEVIA_MAINTENANCE_MODE=true` on both API and
scanner, stop SQS consumption and scheduled reconciliation, and preserve queued
messages and schedules for resumption. API maintenance must cover public traffic,
authentication/user synchronization and MCP grants, not merely scan creation.
Wait for existing API and scanner invocations to finish: the scanner can run for
300 seconds. Confirm zero concurrent executions and no active application
transactions. A maintenance flag cannot interrupt an invocation already running.
Do not purge queues, discard pending provider batches or manufacture replacement
provider calls. Keep this writer fence throughout export, restore and verification.

Use a new archive path in a private directory. The helper creates missing archive
directories with mode 0700 and files with mode 0600, refuses an existing archive,
and refuses a directory accessible to other users. It never changes `/tmp` or an
existing parent directory's permissions.

```sh
node --import tsx scripts/neon-migration.ts dump \
  --archive /private/tmp/citevia-neon-cutover/source.dump
node --import tsx scripts/neon-migration.ts dump \
  --archive /private/tmp/citevia-neon-cutover/source.dump --apply --writers-paused
```

Export uses `pg_export_snapshot()` and real `pg_dump --format=custom --snapshot`,
with no table/schema exclusion. The read-only exporting transaction remains open
until the archive finishes. The helper then takes a fresh source inventory and
refuses the archive if source data or sequence state changed during export.
`source.dump.manifest.json` records the archive SHA-256, full verification metadata
and source migration ledger. Exporting does not change the source schema.

## Restore and verify before application migrations

```sh
node --import tsx scripts/neon-migration.ts restore \
  --archive /private/tmp/citevia-neon-cutover/source.dump
node --import tsx scripts/neon-migration.ts restore \
  --archive /private/tmp/citevia-neon-cutover/source.dump --apply --writers-paused
node --import tsx scripts/neon-migration.ts verify \
  --archive /private/tmp/citevia-neon-cutover/source.dump
```

Restore refuses a nonempty target and never uses `--clean` or `--create`.
`pg_restore --single-transaction --exit-on-error` makes restore atomic. Archive
hash and unchanged-source checks run before restore. Verification compares every
public table's exact count and SHA-256 row multiset, plus migration checksums,
sequence values/`is_called`, columns, constraints, indexes, partition metadata,
functions, triggers, views, enum values, row-security flags/policies and installed extension versions.
Locale differences are reported separately and must be reviewed for affected text
queries; matching rows alone does not prove identical collation behavior.

Treat session context separately from stored schema. During this migration, fresh
logical, pooled and physical-host connections reused a backend whose session
`search_path` was empty after restore. The resulting catalog text added `public.`
qualifiers to otherwise identical sequence defaults and foreign keys. A local
canonical path proved exact schema equality; no restore or data repair was needed.
This observation alone does not establish which infrastructure component reused
the session. The inventory helper now sets `pg_catalog,public` transaction-locally
for deterministic deparsing and resets it at transaction end.

Before cutover, verify the runtime path independently. Inspect `pg_settings` for
`search_path` including `source`, `reset_val` and `boot_val`, plus database/role
overrides; distinguish a session value from a persistent default. A reviewed
role-in-database setting can define `pg_catalog,public` narrowly. Existing warm
backends may not have loaded a changed login default. After applying or reloading
such settings, require fresh direct and pooled connections to show the intended
effective path and read known tables without schema qualifiers. Exercise the real
`externalDatabaseConfig`/`pg.Pool` settings with two simultaneous read-only
transactions and a new pool reconnect. Compare `current_schemas(true)` with
`{pg_catalog,public}` and original table counts; the valid default `"$user", public`
can have that same effective order as explicit `pg_catalog,public` when no user
schema exists. Do not reject it solely for different setting text or recycle a
healthy backend just to make that text match. Do not use session `SET search_path` to
make this acceptance check pass. Keep native dumps/migrations on direct endpoints
and avoid relying on persistent session settings through transaction pooling.

Require `verified:true` before applying target application migrations. Migrations
011–013 intentionally change schema and add typed values; an old exact-copy
manifest is no longer an expected match afterward. Record the verified baseline,
apply only the repository's checksum-verified additive migrations to the target,
and reconcile original table counts, original migration checksums, new migration
checksums and typed-state backfills before reopening traffic. Run this against the
direct target endpoint, not against Aurora. Do not edit old applied migrations.

## Switch and acceptance

1. Store only the **pooled** target credential object in Secrets Manager:
   `host`, numeric `port`, `database`, `username`, `password`. Configure both API
   and scanner with `DatabaseMode=external` and the same
   `ExternalDatabaseSecretArn`. Keep maintenance enabled while both finish the
   configuration deployment and old Aurora-connected invocations drain.
2. Verify new connections reach the intended Neon database. Validate account/user
   access, scan/history counts, original answers and citations from the existing
   S3 bucket, tracking counters, OAuth and pending Batch reconciliation. No paid
   model request is necessary for these checks.
3. Preserve the two-stage optimization rollout: `CompactRunState=false` until old
   JSON-only scanner invocations have drained; enable it only in a subsequent
   coordinated configuration rollout. Keep the compatibility mirror enabled for
   production until external consumers are resolved.
4. Reopen API traffic, then resume queue consumption and schedules. Confirm no
   duplicate scan kickoff or Batch creation and that existing leases recover.
   Monitor errors, connection counts and p95 latency after idle resume.

Keep Aurora, its credentials, private network and the validated archive through
the rollback window. Selecting external PostgreSQL does not stop Aurora billing.
Only remove obsolete NAT/tunnel resources after every application path uses the
external database and rollback access is deliberately addressed. Retiring Aurora
requires a separate verified snapshot/restore and resource-lifecycle operation.

## Rollback invariant

Before reopening writes on Neon, rollback can switch both functions back to the
still-unchanged Aurora source while keeping the writer fence active.

**After any successful Neon write, Aurora is stale.** A configuration-only switch
back would lose new customer data. Fence/drain writers again, export the current
Neon database, restore it into a fresh compatible PostgreSQL destination, reconcile
the same complete inventory, then switch both functions together. Never overwrite
the retained source or replay an old archive to discard newer writes. Reverting
to a JSON-only application binary additionally requires paused-writer manifest
rehydration, as documented in `COST_OPTIMIZATION.md`.

Neon can suspend truly inactive sessions; idle-in-transaction sessions keep its
compute active. The existing 15-minute reconciliation cadence still wakes the
database. Measure real active time before treating scale-to-zero as zero cost.

References: [Neon migration guidance](https://github.com/neondatabase/website/blob/main/content/docs/import/migrate-from-postgres.md),
[Neon connection pooling](https://github.com/neondatabase/website/blob/main/content/docs/connect/connection-pooling.md),
[PostgreSQL dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[PostgreSQL restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
