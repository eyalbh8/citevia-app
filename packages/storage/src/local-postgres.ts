import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SqlDatabase, SqlSession } from './sql.js';
import { migrateDatabase } from './sql.js';
export async function localPostgres(path?: string, options: { migrate?: boolean } = {}): Promise<SqlDatabase> {
  if (path && !path.startsWith('memory:'))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pg = await PGlite.create(path || 'memory://');
  const wrap = (value: Pick<typeof pg, 'query' | 'exec'>): SqlSession => ({
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const r = await value.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows };
    },
    exec: (sql) => value.exec(sql),
  });
  const db: SqlDatabase = {
    ...wrap(pg),
    transaction: (work) => pg.transaction((tx) => work(wrap(tx))),
    close: () => pg.close(),
  };
  if (options.migrate !== false) await migrateDatabase(db);
  return db;
}
