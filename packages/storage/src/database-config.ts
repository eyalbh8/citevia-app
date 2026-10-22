import { z } from 'zod';
import type { PoolConfig } from 'pg';

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
