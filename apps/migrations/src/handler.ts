import { migrateDatabase, migrationDatabase } from '@citevia/storage';
import { z } from 'zod';

const request = z.object({ kind: z.literal('database:migrate') }).strict();

/** No HTTP, queue, or scheduled event source. Only an IAM-authorized direct invocation. */
export async function handler(event: unknown) {
  request.parse(event);
  if (process.env.CITEVIA_MAINTENANCE_MODE === 'true') return { maintenance: true };
  const db = migrationDatabase();
  try { await migrateDatabase(db); return { migrated: true }; }
  finally { await db.close(); }
}
