import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { cleanupExpiredAuthState, collectStorageAudit, compactEvidenceDuplicates, rehydrateRunManifests,
  FileArtifacts, productionDatabase, S3Artifacts, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { mode: { type: 'string', default: 'local' }, apply: { type: 'boolean', default: false },
    limit: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', default: false } },
});
const usage = `Usage: node --env-file-if-exists=.env --import tsx scripts/database-maintenance.ts
  audit [--mode local|aws]
  cleanup-auth [--mode local|aws] [--limit 500] [--apply]
  compact-evidence [--mode local|aws] [--limit 100] [--after UUID] [--apply]
  rehydrate-run-manifests [--mode local|aws] [--limit 100] [--after CURSOR] [--apply]

All operations default to read-only previews. This command never applies schema migrations.
Cleanup only removes expired authentication state and rate-limit buckets older than seven days.
Compaction verifies original capture and analysis artifacts before removing duplicate SQL raw receipts.
Pause scan writers before rehydrating manifests for rollback to an old JSON-only repository.
Stop the local app before opening its embedded database with this command.`;
if (values.help) {
  console.log(usage);
} else {
  const operation = positionals[0];
  if (positionals.length !== 1 || !['audit', 'cleanup-auth', 'compact-evidence', 'rehydrate-run-manifests'].includes(operation) ||
    !['local', 'aws'].includes(values.mode)) throw new Error(usage);
  if (operation === 'audit' && (values.apply || values.limit || values.after))
    throw new Error('Audit is read-only and does not accept apply, limit or after flags.');
  if (values.after && !['compact-evidence', 'rehydrate-run-manifests'].includes(operation)) throw new Error('Only compaction and rehydration accept an after cursor.');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > (operation === 'cleanup-auth' ? 2000 : 500)))
    throw new Error('Limit must be a positive integer, at most 500 for compaction or 2000 for auth cleanup.');
  const base = resolve(process.env.LOCAL_DATA_DIR || '.local-data/real');
  let db: SqlDatabase;
  if (values.mode === 'local') {
    const databasePath = resolve(base, 'postgres');
    await stat(databasePath); // Never create a new database for an audit or cleanup.
    db = await localPostgres(databasePath, { migrate: false });
  } else {
    db = productionDatabase();
  }
  try {
    let result: unknown;
    if (operation === 'audit') {
      result = await collectStorageAudit(db);
    } else if (operation === 'cleanup-auth') {
      result = await cleanupExpiredAuthState(db, { dryRun: !values.apply, limit });
    } else if (operation === 'rehydrate-run-manifests') {
      result = await rehydrateRunManifests(db, { dryRun: !values.apply, limit, after: values.after });
    } else {
      if (values.mode === 'aws' && !process.env.EVIDENCE_BUCKET)
        throw new Error('Set EVIDENCE_BUCKET to verify the original saved artifacts.');
      const artifacts = values.mode === 'local' ? new FileArtifacts(resolve(base, 'artifacts'))
        : new S3Artifacts(new S3Client({ maxAttempts: 3 }), process.env.EVIDENCE_BUCKET!);
      result = await compactEvidenceDuplicates(db, artifacts, { dryRun: !values.apply, limit, afterId: values.after });
    }
    console.log(JSON.stringify({ operation, mode: values.mode, result }, null, 2));
  } finally {
    await db.close();
  }
}
