import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRepository, MemoryRepository, PostgresRepository,
  type McpConnection, type McpRecord, type Repository, type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { testIdentity } from './fixtures/users.js';
import { newProject } from './fixtures/scanner.js';

const NOW = '2026-10-21T10:00:00.000Z';
const LATER = '2026-10-21T10:01:00.000Z';
const FUTURE = '2026-10-21T11:00:00.000Z';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(kind: string) {
  let db: SqlDatabase | undefined;
  if (kind === 'PostgreSQL') {
    db = await localPostgres();
    cleanups.push(() => db!.close());
  }
  const repository: Repository = db ? new PostgresRepository(db) : new MemoryRepository();
  await repository.syncUser(testIdentity('first'));
  await repository.syncUser(testIdentity('second'));
  await repository.saveProject(newProject({ id: 'alpha' }), null);
  await repository.saveProject(newProject({ id: 'beta' }), null);
  return { repository, db };
}
const connection = (id: string, changes: Partial<McpConnection> = {}): McpConnection => ({
  id, userId: 'first', projectId: 'alpha', name: `Connection ${id}`,
  tokenHash: `sha256:${id}`, keyPrefix: `citevia_${id.slice(0, 4)}`,
  createdAt: NOW, expiresAt: FUTURE, lastUsedAt: null, revokedAt: null,
  kind: 'api_key', ...changes,
});

describe.each(['Memory', 'PostgreSQL'])('%s MCP credential persistence', kind => {
  it('isolates identity and account scopes, preserving an explicit global scope and copies of state', async () => {
    const { repository, db } = await setup(kind);
    const initial = connection('account');
    await repository.createMcpConnection(initial);
    initial.name = 'Caller mutation';
    await repository.createMcpConnection(connection('other-account', { projectId: 'beta' }));
    await repository.createMcpConnection(connection('other-user', { userId: 'second' }));
    await repository.createMcpConnection(connection('global', { projectId: null, kind: 'oauth' }));
    expect((await repository.listMcpConnections('first', 'alpha')).map(item => item.id)).toEqual(['account']);
    expect((await repository.listMcpConnections('first', null)).map(item => item.id)).toEqual(['global']);
    expect(await repository.listMcpConnections('second', null)).toEqual([]);
    expect(await repository.getMcpConnection('missing')).toBeNull();
    expect(await repository.getMcpConnection('__proto__')).toBeNull();
    const loaded = await repository.getMcpConnectionByHash('sha256:account');
    expect(loaded).toEqual(connection('account'));
    loaded!.name = 'Another caller mutation';
    const reloaded = db ? new PostgresRepository(db) : repository;
    expect(await reloaded.getMcpConnection('account')).toEqual(connection('account'));
  });

  it('atomically caps active credentials at twenty per identity and scope while freeing expired and revoked slots', async () => {
    const { repository } = await setup(kind);
    await repository.createMcpConnection(connection('expired', { expiresAt: NOW }));
    await repository.createMcpConnection(connection('revoked', { revokedAt: NOW }));
    const results = await Promise.allSettled(Array.from({ length: 35 }, (_, n) =>
      repository.createMcpConnection(connection(`parallel-${n}`)),
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(20);
    const rejected = results.filter(result => result.status === 'rejected');
    expect(rejected).toHaveLength(15);
    for (const result of rejected)
      expect(result.reason).toMatchObject({ status: 409, code: 'MCP_CONNECTION_LIMIT' });
    await repository.createMcpConnection(connection('independent-account', { projectId: 'beta' }));
    await repository.createMcpConnection(connection('independent-global', { projectId: null }));
    await repository.createMcpConnection(connection('independent-user', { userId: 'second' }));
    const active = (await repository.listMcpConnections('first', 'alpha')).find(item => item.id.startsWith('parallel-'))!;
    expect(await repository.revokeMcpConnection(active.id, 'first', LATER)).toBe(true);
    await repository.createMcpConnection(connection('replacement', { createdAt: LATER }));
  });

  it('rejects credential hash collisions across account scopes and reused connection IDs', async () => {
    const { repository } = await setup(kind);
    const attempts = await Promise.allSettled([
      repository.createMcpConnection(connection('first-key', { tokenHash: 'same-hash' })),
      repository.createMcpConnection(connection('second-key', { tokenHash: 'same-hash', projectId: 'beta' })),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'MCP_CONNECTION_EXISTS' },
    });
    const winner = (await repository.getMcpConnectionByHash('same-hash'))!;
    await expect(repository.createMcpConnection({ ...winner, tokenHash: 'different-hash' }))
      .rejects.toMatchObject({ status: 409, code: 'MCP_CONNECTION_EXISTS' });
    await repository.revokeMcpConnection(winner.id, 'first', LATER);
    await expect(repository.createMcpConnection(connection('reuse-revoked-hash', { tokenHash: 'same-hash' })))
      .rejects.toMatchObject({ status: 409, code: 'MCP_CONNECTION_EXISTS' });
  });

  it('requires the owning identity for revocation and never moves last use backwards or touches inactive credentials', async () => {
    const { repository } = await setup(kind);
    await repository.createMcpConnection(connection('key'));
    expect(await repository.revokeMcpConnection('key', 'second', NOW)).toBe(false);
    await repository.touchMcpConnection('key', LATER);
    await repository.touchMcpConnection('key', NOW);
    expect((await repository.getMcpConnection('key'))?.lastUsedAt).toBe(LATER);
    const revocations = await Promise.all(Array.from({ length: 10 }, () => repository.revokeMcpConnection('key', 'first', LATER)));
    expect(revocations.filter(Boolean)).toHaveLength(1);
    await repository.touchMcpConnection('key', FUTURE);
    expect(await repository.getMcpConnection('key')).toMatchObject({ revokedAt: LATER, lastUsedAt: LATER });
    await repository.createMcpConnection(connection('expired', { expiresAt: NOW }));
    await repository.touchMcpConnection('expired', NOW);
    expect((await repository.getMcpConnection('expired'))?.lastUsedAt).toBeNull();
    expect(await repository.revokeMcpConnection('missing', 'first', NOW)).toBe(false);
  });

  it('consumes OAuth codes, refresh grants, and consent records exactly once under contention', async () => {
    const { repository } = await setup(kind);
    for (const recordKind of ['code', 'refresh', 'consent'] as const) {
      const record: McpRecord = { kind: recordKind, id: 'opaque-token-hash', data: { connectionId: 'key' }, expiresAt: FUTURE };
      await repository.putMcpRecord(record);
      const attempts = await Promise.all(Array.from({ length: 30 }, () => repository.consumeMcpRecord(recordKind, record.id, NOW)));
      expect(attempts.filter(Boolean)).toEqual([record]);
      const saved = await repository.getMcpRecord(recordKind, record.id);
      if (recordKind === 'refresh') expect(saved).toEqual({ ...record, data: { ...record.data, consumed: true } });
      else expect(saved).toBeNull();
    }
    await repository.putMcpRecord({ kind: 'code', id: 'expired', data: {}, expiresAt: NOW });
    expect(await repository.consumeMcpRecord('code', 'expired', NOW)).toBeNull();
    expect(await repository.getMcpRecord('code', 'expired')).toBeNull();
  });

  it('keeps record kinds separate and persists OAuth client/access records across repository instances', async () => {
    const { repository, db } = await setup(kind);
    const client: McpRecord = { kind: 'client', id: 'same-id', data: { redirectUris: ['https://client.test/callback'] }, expiresAt: null };
    const access: McpRecord = { kind: 'access', id: 'same-id', data: { connectionId: 'key' }, expiresAt: FUTURE };
    await repository.putMcpRecord(client);
    await repository.putMcpRecord(access);
    const reloaded = db ? new PostgresRepository(db) : repository;
    expect(await reloaded.getMcpRecord('client', 'same-id')).toEqual(client);
    expect(await reloaded.getMcpRecord('access', 'same-id')).toEqual(access);
    const read = (await repository.getMcpRecord('access', 'same-id'))!;
    read.data.connectionId = 'tampered';
    expect(await reloaded.consumeMcpRecord('client', 'same-id', NOW)).toEqual(client);
    expect(await reloaded.getMcpRecord('access', 'same-id')).toEqual(access);
    expect(await reloaded.getMcpRecord('refresh', 'same-id')).toBeNull();
  });

  it('shares atomic request budgets across workers and rejects delayed requests from older windows', async () => {
    const { repository, db } = await setup(kind);
    const secondWorker = db ? new PostgresRepository(db) : repository;
    const attempts = await Promise.all(Array.from({ length: 80 }, (_, n) =>
      (n % 2 ? repository : secondWorker).limitMcpRequests('connection:key', NOW, 17),
    ));
    expect(attempts.filter(Boolean)).toHaveLength(17);
    expect(await secondWorker.limitMcpRequests('connection:key', NOW, 17)).toBe(false);
    expect(await repository.limitMcpRequests('connection:other-key', NOW, 17)).toBe(true);
    expect(await repository.limitMcpRequests('connection:key', LATER, 17)).toBe(true);
    expect(await repository.limitMcpRequests('connection:key', NOW, 17)).toBe(false);
    expect(await repository.limitMcpRequests('zero-limit', NOW, 0)).toBe(false);
    expect(await repository.limitMcpRequests('invalid-limit', NOW, Number.NaN)).toBe(false);
  });
});

it('deletes account credentials when a PostgreSQL account is removed without creating global grants', async () => {
  const { repository, db } = await setup('PostgreSQL');
  await repository.createMcpConnection(connection('account'));
  await repository.createMcpConnection(connection('global', { projectId: null }));
  await db!.query('DELETE FROM citevia_projects WHERE id=$1', ['alpha']);
  expect(await repository.getMcpConnection('account')).toBeNull();
  expect((await repository.listMcpConnections('first', null)).map(item => item.id)).toEqual(['global']);
});

it('retains grants, consumed records, and request budgets after reopening file storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citevia-mcp-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const repository = await FileRepository.open(file);
  await repository.syncUser(testIdentity('first'));
  await repository.createMcpConnection(connection('global', { projectId: null }));
  await repository.putMcpRecord({ id: 'code-hash', kind: 'code', data: { connectionId: 'global' }, expiresAt: FUTURE });
  await repository.consumeMcpRecord('code', 'code-hash', NOW);
  await repository.putMcpRecord({ id: 'refresh-hash', kind: 'refresh', data: { connectionId: 'global' }, expiresAt: FUTURE });
  await repository.consumeMcpRecord('refresh', 'refresh-hash', NOW);
  await repository.limitMcpRequests('key:global', NOW, 1);
  const reloaded = await FileRepository.open(file);
  expect(await reloaded.getMcpConnection('global')).toEqual(connection('global', { projectId: null }));
  expect(await reloaded.getMcpRecord('code', 'code-hash')).toBeNull();
  expect(await reloaded.getMcpRecord('refresh', 'refresh-hash')).toMatchObject({ data: { connectionId: 'global', consumed: true }, expiresAt: FUTURE });
  expect(await reloaded.consumeMcpRecord('refresh', 'refresh-hash', NOW)).toBeNull();
  expect(await reloaded.limitMcpRequests('key:global', NOW, 1)).toBe(false);
});
