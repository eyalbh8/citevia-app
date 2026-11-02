import { z } from 'zod';
import type { PoolConfig } from 'pg';

export type DatabasePurpose = 'runtime' | 'migration';
export interface DatabaseTimeouts {
  statement: number;
  query: number;
  lock: number;
  idleTransaction: number;
}

/** Client deadlines are deliberately longer than server cancellation deadlines. */
export function databaseTimeouts(purpose: DatabasePurpose = 'runtime'): DatabaseTimeouts {
  const prefix = purpose === 'migration' ? 'DATABASE_MIGRATION_' : 'DATABASE_';
  const read = (suffix: string, fallback: number, maximum: number) => {
    const name = `${prefix}${suffix}_TIMEOUT_MS`;
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
      throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
    return Number(value);
  };
  const migration = purpose === 'migration';
  const result = {
    statement: read('STATEMENT', migration ? 240000 : 15000, migration ? 600000 : 60000),
    query: read('QUERY', migration ? 250000 : 20000, migration ? 610000 : 65000),
    lock: read('LOCK', migration ? 10000 : 5000, 30000),
    idleTransaction: read('IDLE_TRANSACTION', migration ? 30000 : 15000, 60000),
  };
  if (result.query <= result.statement || result.lock > result.statement)
    throw new Error(`${prefix}QUERY_TIMEOUT_MS must exceed STATEMENT_TIMEOUT_MS, which must be at least LOCK_TIMEOUT_MS`);
  return result;
}

const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const identifier = z.string().min(1).max(63).regex(/^[^\0\r\n]+$/);
const externalSecret = z.object({
  host: z.string().max(253).regex(hostname),
  port: z.number().int().min(1).max(65535).default(5432),
  database: identifier,
  username: identifier,
  password: z.string().min(1).max(4096),
}).strict();

/** Credentials stay in Secrets Manager, never in the template or Lambda environment. */
export function externalDatabaseConfig(secretString: string): PoolConfig {
  let value: unknown;
  try { value = JSON.parse(secretString); }
  catch { throw new Error('External database secret must be a JSON credential object'); }
  const result = externalSecret.safeParse(value);
  if (!result.success)
    throw new Error('External database secret requires a DNS host, database, username, password and optional numeric port');
  const secret = result.data;
  return {
    host: secret.host,
    port: secret.port,
    database: secret.database,
    user: secret.username,
    password: secret.password,
    // Individual fields prevent URL sslmode options from replacing strict TLS.
    ssl: { rejectUnauthorized: true, servername: secret.host },
    enableChannelBinding: true,
    application_name: 'citevia',
    max: 2,
    min: 0,
    connectionTimeoutMillis: 20000,
    idleTimeoutMillis: 10000,
    maxLifetimeSeconds: 240,
    allowExitOnIdle: true,
  };
}
