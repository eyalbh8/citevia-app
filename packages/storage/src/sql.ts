import { Pool, type PoolClient,type PoolConfig } from 'pg';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface SqlSession {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  exec(sql: string): Promise<unknown>;
}
export interface SqlDatabase extends SqlSession {
  transaction<T>(work: (sql: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function uuidFor(value: string): string {
  if (/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return value;
  const hex = createHash('sha256').update(`citevia:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function session(client: Pool | PoolClient): SqlSession {
  return {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    exec: (sql) => client.query(sql),
  };
}
let poolPromise: Promise<Pool> | undefined;
let poolCreatedAt = 0;
function connectionPool(config:PoolConfig){const pool=new Pool(config);pool.on('error',error=>{console.error(JSON.stringify({event:'database_pool_error',code:(error as {code?:string}).code||'connection_error'}));});return pool;}
export function productionDatabase(): SqlDatabase {
  const load = () => {
    if (poolPromise && Date.now() - poolCreatedAt > 300000) {
      const old = poolPromise;
      poolPromise = undefined;
      void old.then((pool) => pool.end()).catch(() => {});
    }
    if (poolPromise) return poolPromise;
    poolCreatedAt = Date.now();
    return (poolPromise = (async () => {
      if (process.env.DATABASE_URL)
        return connectionPool({
          connectionString: process.env.DATABASE_URL,
          max: 2,
          connectionTimeoutMillis: 10000,
          idleTimeoutMillis: 30000,
        });
      const secretId = process.env.DATABASE_SECRET_ARN,
        host = process.env.DATABASE_HOST;
      if (!secretId || !host)
        throw new Error(
          'Configure DATABASE_HOST and DATABASE_SECRET_ARN, or DATABASE_URL',
        );
      const secret = await new SecretsManagerClient({}).send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      const credentials = JSON.parse(secret.SecretString || '{}');
      if (!credentials.username || !credentials.password)
        throw new Error('Database secret must contain username and password');
      const { rootCertificates } = await import('node:tls');
      return connectionPool({
        host,
        port: 5432,
        database: process.env.DATABASE_NAME || 'citevia',
        user: credentials.username,
        password: credentials.password,
        max: 2,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        ssl: {
          rejectUnauthorized: true,
          ca:
            process.env.RDS_CA_BUNDLE ||
            [
              ...rootCertificates,
              await readFile(
                resolve(
                  process.env.LAMBDA_TASK_ROOT || '.',
                  'database/rds-ca.pem',
                ),
                'utf8',
              ),
            ].join('\n'),
        },
      });
    })().catch((error) => {
      poolPromise = undefined;
      throw error;
    }));
  };
  return {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => session(await load()).query<T>(sql, params),
    exec: async (sql) => session(await load()).exec(sql),
    transaction: async (work) => {
      const client = await (await load()).connect();
      try {
        await client.query('BEGIN');
        const result = await work(session(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: async () => {
      if (poolPromise) {
        await (await poolPromise).end();
        poolPromise = undefined;
      }
    },
  };
}
export async function migrateDatabase(
  db: SqlDatabase,
  directory = resolve(
    process.env.LAMBDA_TASK_ROOT || '.',
    'database/migrations',
  ),
) {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(867530919)');
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS citevia_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of ['001_igeo.sql', '002_citevia.sql', '003_descope_users.sql']) {
      const source = await readFile(resolve(directory, name), 'utf8'),
        checksum = createHash('sha256').update(source).digest('hex');
      const { rows } = await tx.query(
        'SELECT checksum FROM citevia_migrations WHERE name=$1',
        [name],
      );
      if (rows.length) {
        if (rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await tx.exec(source);
      await tx.query(
        'INSERT INTO citevia_migrations(name,checksum) VALUES($1,$2)',
        [name, checksum],
      );
    }
  });
}
