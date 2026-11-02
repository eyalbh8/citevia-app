import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseTimeouts, externalDatabaseConfig } from '../packages/storage/src/database-config.js';

const state = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  send: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));
vi.mock('pg', () => ({ Pool: class {
  constructor(config: Record<string, unknown>) { state.configs.push(config); }
  on() { return this; }
  query = state.query;
  end = state.end;
  connect = state.connect;
} }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = state.send; },
  GetSecretValueCommand: class { constructor(readonly input: unknown) {} },
}));
import { migrationDatabase, productionDatabase } from '../packages/storage/src/sql.js';

const credentials = {
  host: 'ep-example-pooler.us-east-1.aws.neon.tech',
  database: 'citevia', username: 'citevia_app', password: 'private-password',
};
beforeEach(() => {
  state.configs.length = 0;
  state.send.mockReset().mockResolvedValue({ SecretString: JSON.stringify(credentials) });
  state.query.mockReset().mockResolvedValue({ rows: [{ healthy: true }], rowCount: 1 });
  state.end.mockReset().mockResolvedValue(undefined);
  state.transactionQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  state.release.mockReset();
  state.connect.mockReset().mockResolvedValue({ query: state.transactionQuery, release: state.release });
});
afterEach(async () => {
  await productionDatabase().close();
  await migrationDatabase().close();
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


describe('database execution safeguards', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_MODE', 'external');
    vi.stubEnv('DATABASE_SECRET_ARN', 'runtime-secret');
  });
  it('sets a client deadline without unsupported transaction-pooler startup settings', async () => {
    await productionDatabase().query('SELECT 1');
    expect(state.configs[0].query_timeout).toBe(20000);
    for (const setting of ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'options'])
      expect(state.configs[0][setting]).toBeUndefined();
  });
  it('uses transaction-local server deadlines and commits on the same connection', async () => {
    await productionDatabase().transaction(async tx => tx.query('UPDATE example SET value=$1', [42]));
    expect(state.transactionQuery.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', expect.stringContaining("set_config('statement_timeout',$1,true)"), 'UPDATE example SET value=$1', 'COMMIT',
    ]);
    expect(state.transactionQuery.mock.calls[1][1]).toEqual(['15000ms', '5000ms', '15000ms']);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it('preserves the original error and destroys the client if rollback also fails', async () => {
    const original = new Error('transaction failed');
    state.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection already terminated');
      return { rows: [] };
    });
    await expect(productionDatabase().transaction(async () => { throw original; })).rejects.toBe(original);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('destroys a timed-out transaction without queueing a rollback behind the unknown query', async () => {
    state.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE example SET value=1') throw new Error('Query read timeout');
      return { rows: [] };
    });
    await expect(productionDatabase().transaction(tx => tx.query('UPDATE example SET value=1'))).rejects.toThrow('Query read timeout');
    expect(state.transactionQuery.mock.calls.some(call => call[0] === 'ROLLBACK')).toBe(false);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('keeps concurrent transaction deadlines on their own checked-out clients', async () => {
    const clients = [0, 1].map(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }));
    state.connect.mockReset().mockResolvedValueOnce(clients[0]).mockResolvedValueOnce(clients[1]);
    await Promise.all([0, 1].map(value => productionDatabase().transaction(tx => tx.query('SELECT $1', [value]))));
    for (const [index, client] of clients.entries()) {
      expect(client.query.mock.calls[2]).toEqual(['SELECT $1', [index]]);
      expect(client.query.mock.calls[3][0]).toBe('COMMIT');
      expect(client.release).toHaveBeenCalledOnce();
    }
  });
  it.each(['0', '-1', 'Infinity', 'NaN', '1.5', '900000', '1e4'])('rejects unbounded or invalid timeout %s', value => {
    vi.stubEnv('DATABASE_QUERY_TIMEOUT_MS', value);
    expect(() => databaseTimeouts()).toThrow('DATABASE_QUERY_TIMEOUT_MS');
  });
  it('requires client deadlines to leave time for server cancellation', () => {
    vi.stubEnv('DATABASE_QUERY_TIMEOUT_MS', '15000');
    expect(() => databaseTimeouts()).toThrow('must exceed');
  });
  it('requires a separate direct migration secret', async () => {
    vi.stubEnv('DATABASE_MIGRATION_SECRET_ARN', '');
    await expect(migrationDatabase().query('SELECT 1')).rejects.toThrow('DATABASE_MIGRATION_SECRET_ARN');
    vi.stubEnv('DATABASE_MIGRATION_SECRET_ARN', 'migration-secret');
    await expect(migrationDatabase().query('SELECT 1')).rejects.toThrow('direct connection');
  });
  it('keeps runtime and migration credentials, pools and timeouts separate', async () => {
    vi.stubEnv('DATABASE_MIGRATION_SECRET_ARN', 'migration-secret');
    state.send.mockImplementation(async (command: { input: { SecretId: string } }) => ({ SecretString: JSON.stringify(
      command.input.SecretId === 'migration-secret' ? { ...credentials, host: 'ep-example.us-east-1.aws.neon.tech', username: 'owner' } : credentials) }));
    await productionDatabase().query('SELECT 1');
    await migrationDatabase().query('SELECT 1');
    expect(state.configs).toHaveLength(2);
    expect(state.configs[0]).toMatchObject({ user: 'citevia_app', max: 2, query_timeout: 20000 });
    expect(state.configs[1]).toMatchObject({ user: 'owner', max: 1, query_timeout: 250000 });
  });
});
