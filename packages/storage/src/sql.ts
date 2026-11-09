import { Pool, type PoolClient,type PoolConfig } from 'pg';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { databaseTimeouts, externalDatabaseConfig, type DatabasePurpose } from './database-config.js';

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
interface PoolEntry { promise: Promise<Pool>; createdAt: number }
const pools = new Map<DatabasePurpose, PoolEntry>();
function connectionPool(config: PoolConfig) {
  const pool = new Pool(config);
  pool.on('error', error => {
    const code = (error as { code?: string }).code;
    console.error(JSON.stringify({ event: 'database_pool_error',
      code: code && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'connection_error' }));
  });
  return pool;
}

function configuredDatabase(purpose: DatabasePurpose): SqlDatabase {
  const load = () => {
    const existing = pools.get(purpose);
    if (existing && Date.now() - existing.createdAt <= 300000) return existing.promise;
    if (existing) {
      pools.delete(purpose);
      void existing.promise.then(pool => pool.end()).catch(() => {});
    }
    const timeouts = databaseTimeouts(purpose);
    const entry: PoolEntry = { createdAt: Date.now(), promise: Promise.resolve(undefined as unknown as Pool) };
    entry.promise = (async () => {
      const mode = process.env.DATABASE_MODE || 'aurora';
      if (mode !== 'aurora' && mode !== 'external')
        throw new Error('DATABASE_MODE must be aurora or external');
      const migration = purpose === 'migration';
      const secretId = migration ? process.env.DATABASE_MIGRATION_SECRET_ARN : process.env.DATABASE_SECRET_ARN;
      const poolOptions: PoolConfig = { query_timeout: timeouts.query,
        application_name: migration ? 'citevia-migration' : 'citevia', max: migration ? 1 : 2 };
      if (mode === 'external') {
        if (!secretId) throw new Error(`Configure ${migration ? 'DATABASE_MIGRATION_SECRET_ARN' : 'DATABASE_SECRET_ARN'} for external PostgreSQL`);
        const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
        const config = externalDatabaseConfig(secret.SecretString || '');
        if (migration && /-pooler\./i.test(config.host || ''))
          throw new Error('Database migrations require a direct connection, not a transaction-pooler host');
        // PgBouncer transaction pooling does not support server timeout startup options.
        // Standalone statements use role defaults; explicit transactions use SET LOCAL.
        return connectionPool({ ...config, ...poolOptions });
      }
      const connectionString = migration ? process.env.DATABASE_MIGRATION_URL : process.env.DATABASE_URL;
      if (connectionString) return connectionPool({ connectionString, connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000, ...poolOptions });
      const host = migration ? process.env.DATABASE_MIGRATION_HOST || process.env.DATABASE_HOST : process.env.DATABASE_HOST;
      if (!secretId || !host)
        throw new Error(migration ? 'Configure DATABASE_MIGRATION_HOST and DATABASE_MIGRATION_SECRET_ARN, or DATABASE_MIGRATION_URL'
          : 'Configure DATABASE_HOST and DATABASE_SECRET_ARN, or DATABASE_URL');
      const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
      let credentials: { username?: unknown; password?: unknown };
      try { credentials = JSON.parse(secret.SecretString || '{}'); }
      catch { throw new Error('Database secret must be a JSON credential object'); }
      if (typeof credentials?.username !== 'string' || !credentials.username ||
          typeof credentials.password !== 'string' || !credentials.password)
        throw new Error('Database secret must contain username and password');
      const { rootCertificates } = await import('node:tls');
      return connectionPool({ host, port: 5432, database: process.env.DATABASE_NAME || 'citevia',
        user: credentials.username, password: credentials.password, connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000, ...poolOptions, ssl: { rejectUnauthorized: true,
          ca: process.env.RDS_CA_BUNDLE || [...rootCertificates,
            await readFile(resolve(process.env.LAMBDA_TASK_ROOT || '.', 'database/rds-ca.pem'), 'utf8')].join('\n') } });
    })().catch(error => {
      if (pools.get(purpose) === entry) pools.delete(purpose);
      throw error;
    });
    pools.set(purpose, entry);
    return entry.promise;
  };
  return {
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => session(await load()).query<T>(sql, params),
    exec: async sql => session(await load()).exec(sql),
    transaction: async work => {
      const timeouts = databaseTimeouts(purpose);
      const client = await (await load()).connect();
      let begun = false, discard = false;
      try {
        await client.query('BEGIN');
        begun = true;
        await client.query(`SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true),
          set_config('idle_in_transaction_session_timeout',$3,true)`,
        [`${timeouts.statement}ms`, `${timeouts.lock}ms`, `${timeouts.idleTransaction}ms`]);
        const result = await work(session(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A client-side deadline does not prove the server stopped or rolled back.
        // Destroy failed clients, never retry ambiguous writes, and preserve the original error.
        discard = true;
        if (begun && !(error instanceof Error && error.message === 'Query read timeout')) {
          try { await client.query('ROLLBACK'); } catch { /* discard the unusable connection */ }
        }
        throw error;
      } finally { client.release(discard || undefined); }
    },
    close: async () => {
      const entry = pools.get(purpose);
      if (entry) { pools.delete(purpose); await (await entry.promise).end(); }
    },
  };
}

export function productionDatabase(): SqlDatabase { return configuredDatabase('runtime'); }
/** Dedicated owner credentials/direct endpoint, never a fallback to the runtime login. */
export function migrationDatabase(): SqlDatabase { return configuredDatabase('migration'); }
export async function migrateDatabase(
  db: SqlDatabase,
  directory = resolve(
    process.env.LAMBDA_TASK_ROOT || '.',
    'database/migrations',
  ),
) {
  await db.transaction(async (tx) => {
    // Unqualified migration DDL must create objects in public regardless of the
    // caller's path. pg_catalog remains implicitly first for built-in lookups.
    await tx.query('SET LOCAL search_path = public');
    await tx.query('SELECT pg_advisory_xact_lock(867530919)');
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS citevia_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of [
      '001_igeo.sql',
      '002_citevia.sql',
      '003_descope_users.sql',
      '004_prompt_metadata.sql',
      '005_url_tracking.sql',
      '006_mcp.sql',
      '007_ai_traffic.sql',
      '008_traffic_installations.sql',
      '009_agent_posts.sql',
      '010_agent_images.sql',
      '011_storage_efficiency.sql',
      '012_analysis_batches.sql',
      '013_provider_costs.sql',
      '014_provider_admission.sql',
      '015_scan_dispatch.sql',
      '016_website_health.sql',
      '017_social_automation.sql',
      '018_social_review_schedule.sql',
      '019_geo_backlinks.sql',
      '020_social_review_links.sql',
    ]) {
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
