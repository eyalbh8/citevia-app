import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';

const state = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  send: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));
vi.mock('pg', () => ({ Pool: class {
  constructor(config: Record<string, unknown>) { state.configs.push(config); }
  on() { return this; }
  query = state.query;
  end = state.end;
} }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = state.send; },
  GetSecretValueCommand: class { constructor(readonly input: unknown) {} },
}));
import { productionDatabase } from '../packages/storage/src/sql.js';

const credentials = {
  host: 'ep-example-pooler.us-east-1.aws.neon.tech',
  database: 'citevia', username: 'citevia_app', password: 'private-password',
};
beforeEach(() => {
  state.configs.length = 0;
  state.send.mockReset().mockResolvedValue({ SecretString: JSON.stringify(credentials) });
  state.query.mockReset().mockResolvedValue({ rows: [{ healthy: true }], rowCount: 1 });
  state.end.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await productionDatabase().close();
  vi.unstubAllEnvs();
});

describe('external PostgreSQL connection', () => {
  it('uses explicit credential fields with verified TLS and a bounded small pool', () => {
    const config = externalDatabaseConfig(JSON.stringify(credentials));
    expect(config).toMatchObject({ host: credentials.host, user: 'citevia_app', database: 'citevia',
      port: 5432, ssl: { rejectUnauthorized: true, servername: credentials.host },
      enableChannelBinding: true, max: 2, min: 0, idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 20000, maxLifetimeSeconds: 240 });
    expect(config.connectionString).toBeUndefined();
  });
  it.each([
    { ...credentials, ssl: false },
    { ...credentials, host: 'postgresql://user:secret@example.com/db' },
    { ...credentials, port: '5432' },
    { ...credentials, port: 70000 },
    { ...credentials, password: '' },
    { ...credentials, database: 'citevia\nother' },
    { ...credentials, username: undefined },
  ])('rejects malformed or TLS-overriding secret fields without exposing credentials', value => {
    try { externalDatabaseConfig(JSON.stringify(value)); throw new Error('Expected rejection'); }
    catch (error) {
      expect((error as Error).message).toContain('External database secret requires');
      expect((error as Error).message).not.toContain(credentials.password);
    }
  });
  it('redacts malformed JSON from validation errors', () => {
    expect(() => externalDatabaseConfig('private-password')).toThrow('External database secret must be a JSON credential object');
  });
  it('loads the selected AWS secret and never falls back to a stale inline URL', async () => {
    vi.stubEnv('DATABASE_MODE', 'external');
    vi.stubEnv('DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:neon-private');
    vi.stubEnv('DATABASE_URL', 'postgres://wrong:wrong@old.example.com/old');
    const db = productionDatabase();
    await expect(db.query('SELECT true AS healthy')).resolves.toMatchObject({ rows: [{ healthy: true }] });
    expect(state.send.mock.calls[0][0].input).toEqual({ SecretId: process.env.DATABASE_SECRET_ARN });
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]).toMatchObject({ host: credentials.host, database: 'citevia', ssl: { rejectUnauthorized: true } });
    expect(state.configs[0].connectionString).toBeUndefined();
    await db.query('SELECT true AS healthy');
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it('fails closed when external credentials are missing or malformed', async () => {
    vi.stubEnv('DATABASE_MODE', 'external');
    vi.stubEnv('DATABASE_SECRET_ARN', '');
    vi.stubEnv('DATABASE_URL', 'postgres://wrong:wrong@old.example.com/old');
    await expect(productionDatabase().query('SELECT 1')).rejects.toThrow('Configure DATABASE_SECRET_ARN');
    expect(state.configs).toHaveLength(0);
    vi.stubEnv('DATABASE_SECRET_ARN', 'external-secret');
    state.send.mockResolvedValueOnce({ SecretString: JSON.stringify({ ...credentials, ssl: false }) });
    await expect(productionDatabase().query('SELECT 1')).rejects.toThrow('External database secret requires');
    expect(state.configs).toHaveLength(0);
  });
  it('does not retry an ambiguous write after a connection error', async () => {
    vi.stubEnv('DATABASE_MODE', 'external');
    vi.stubEnv('DATABASE_SECRET_ARN', 'external-secret');
    state.query.mockRejectedValueOnce(new Error('connection lost after write'));
    await expect(productionDatabase().query('UPDATE example SET value=1')).rejects.toThrow('connection lost after write');
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('preserves the local DATABASE_URL path outside external mode', async () => {
    vi.stubEnv('DATABASE_MODE', 'aurora');
    vi.stubEnv('DATABASE_URL', 'postgres://local:local@localhost/citevia');
    await productionDatabase().query('SELECT 1');
    expect(state.configs[0].connectionString).toBe(process.env.DATABASE_URL);
    expect(state.send).not.toHaveBeenCalled();
  });
  it('rejects misspelled modes instead of silently selecting another database', async () => {
    vi.stubEnv('DATABASE_MODE', 'exernal');
    await expect(productionDatabase().query('SELECT 1')).rejects.toThrow('DATABASE_MODE must be aurora or external');
    expect(state.configs).toHaveLength(0);
  });
});
