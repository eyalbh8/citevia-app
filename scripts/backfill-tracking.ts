import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  FileArtifacts,
  PostgresRepository,
  S3Artifacts,
  migrateDatabase,
  productionDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { backfillTracking } from '../packages/storage/src/tracking-backfill.js';

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    project: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  },
});
if (
  !values.project ||
  !values.from ||
  !values.to ||
  !['local', 'postgres'].includes(values.backend || '')
)
  throw new Error(
    'Usage: npm run tracking:backfill -- --backend local|postgres --project ACCOUNT_ID --from YYYY-MM-DD --to YYYY-MM-DD',
  );
if (values.backend === 'postgres' && !process.env.EVIDENCE_BUCKET)
  throw new Error('Set EVIDENCE_BUCKET for the saved scan artifacts.');
const base = resolve(process.env.LOCAL_DATA_DIR || '.local-data/real');
const db =
  values.backend === 'local'
    ? await localPostgres(resolve(base, 'postgres'))
    : productionDatabase();
try {
  await migrateDatabase(db);
  const repository = new PostgresRepository(db);
  const artifacts =
    values.backend === 'local'
      ? new FileArtifacts(resolve(base, 'artifacts'))
      : new S3Artifacts(
          new S3Client({ maxAttempts: 3 }),
          process.env.EVIDENCE_BUCKET!,
        );
  const result = await backfillTracking(
    { repository, artifacts },
    values.project,
    values.from,
    values.to,
    (progress) =>
      console.log(JSON.stringify({ projectId: values.project, ...progress })),
  );
  if (result.missing) {
    console.error(
      `${result.missing} saved artifacts were unavailable. Restore them and repeat the same date range.`,
    );
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
