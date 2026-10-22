import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScanProvider } from '@citevia/core';
import type { SqlDatabase } from '../packages/storage/src/sql.js';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import {
  MemoryScanDispatchStore, SqlScanDispatchStore,
  type ScanDispatchJob, type ScanDispatchPolicy, type ScanDispatchStore,
} from '../packages/storage/src/scan-dispatch.js';

const initialTime = Date.parse('2026-10-22T12:00:00.000Z');
const providers: ScanProvider[] = ['openai', 'gemini', 'perplexity'];
const policy: ScanDispatchPolicy = { globalLimit: 12, accountLimit: 3, providerLimit: 4, leaseMs: 600_000 };
let db: SqlDatabase, now = initialTime;
beforeAll(async () => {
  db = await localPostgres(undefined, { migrate: false });
  // Exact parent keys suffice to exercise this module without storing customer data or fixture accounts.
  await db.exec(`CREATE TABLE citevia_projects(id text PRIMARY KEY);
    CREATE TABLE citevia_prompt_results(project_id text NOT NULL,run_id text NOT NULL,prompt_id text NOT NULL,
      PRIMARY KEY(project_id,run_id,prompt_id));`);
  await db.exec(await readFile('database/migrations/014_provider_admission.sql', 'utf8'));
  await db.exec(await readFile('database/migrations/015_scan_dispatch.sql', 'utf8'));
}, 30_000);
beforeEach(async () => {
  now = initialTime;
  await db.exec(`TRUNCATE citevia_dispatch_jobs,citevia_dispatch_accounts,citevia_prompt_results,citevia_projects,
    citevia_provider_admission,citevia_provider_leases CASCADE;
    UPDATE citevia_dispatch_state SET sequence=0`);
});
afterAll(async () => { await db.close(); });
function jobs(accounts = 4, prompts = 3): ScanDispatchJob[] {
  return Array.from({ length: accounts }, (_, account) => providers.flatMap(provider =>
    Array.from({ length: prompts }, (_, prompt) => ({
      projectId: `account-${String(account).padStart(3, '0')}`, runId: `run-${provider}`,
      promptId: `prompt-${String(prompt).padStart(3, '0')}`, provider, readyAt: new Date(now).toISOString(),
    })))).flat();
}
async function seed(items: ScanDispatchJob[]): Promise<void> {
  await db.query(`INSERT INTO citevia_projects(id) SELECT DISTINCT project_id
    FROM jsonb_to_recordset($1::jsonb) AS j(project_id text) ON CONFLICT DO NOTHING`,
  [JSON.stringify(items.map(job => ({ project_id: job.projectId })))]);
  await db.query(`INSERT INTO citevia_prompt_results(project_id,run_id,prompt_id)
    SELECT project_id,run_id,prompt_id FROM jsonb_to_recordset($1::jsonb) AS j(project_id text,run_id text,prompt_id text)
    ON CONFLICT DO NOTHING`, [JSON.stringify(items.map(job => ({ project_id: job.projectId, run_id: job.runId, prompt_id: job.promptId })))]);
}

for (const mode of ['sql', 'memory'] as const) describe(`${mode} durable scan dispatch`, () => {
  const makeStore = (): ScanDispatchStore => mode === 'sql'
    ? new SqlScanDispatchStore(db, { now: () => new Date(now) })
    : new MemoryScanDispatchStore({ now: () => new Date(now) });
  async function prepared(items = jobs()) {
    const store = makeStore();
    if (mode === 'sql') await seed(items);
    await store.enqueue(items);
    return store;
  }

  it('bounds simultaneous claims globally, per account and per provider across competing dispatchers', async () => {
    const store = await prepared();
    const stores = mode === 'sql' ? Array.from({ length: 8 }, makeStore) : Array(8).fill(store);
    const claimed = (await Promise.all(stores.map(other => other.claim(policy)))).flat();
    expect(claimed).toHaveLength(12);
    for (const provider of providers) expect(claimed.filter(job => job.provider === provider)).toHaveLength(4);
    for (const id of new Set(claimed.map(job => job.projectId)))
      expect(claimed.filter(job => job.projectId === id)).toHaveLength(3);
    expect(new Set(claimed.map(job => job.token)).size).toBe(12);
    expect(await store.claim(policy)).toEqual([]);
  });

  it('uses all providers for a small account instead of filling its capacity with one provider', async () => {
    const store = await prepared(jobs(1, 50));
    const claimed = await store.claim(policy);
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map(job => job.provider))).toEqual(new Set(providers));
  });

  it('consumes tokens exactly once and preserves active reservations during repeated reconciliation', async () => {
    const store = await prepared(jobs(1, 1));
    const [claimed] = await store.claim({ ...policy, limit: 1 });
    expect(await Promise.all(Array.from({ length: 6 }, () => store.start(claimed, policy.leaseMs))))
      .toEqual([true, false, false, false, false, false]);
    await store.enqueue([{ ...claimed, readyAt: new Date(now + 3600_000).toISOString() }]);
    await store.complete({ ...claimed, token: 'stale-token' });
    expect(await store.start(claimed, policy.leaseMs)).toBe(false);
    await store.complete(claimed);
    expect(await store.start(claimed, policy.leaseMs)).toBe(false);
  });

  it('recovers lost sends and crashed workers, and fences their delayed messages and cleanup', async () => {
    const store = await prepared(jobs(1, 1));
    const first = await store.claim(policy);
    expect(await store.start(first[0], policy.leaseMs)).toBe(true);
    now += policy.leaseMs;
    expect(await store.start(first[1], policy.leaseMs)).toBe(false);
    const recovered = await store.claim(policy);
    expect(recovered).toHaveLength(3);
    expect(recovered.every(job => !first.some(old => old.token === job.token))).toBe(true);
    for (const stale of first) {
      await store.complete(stale);
      await store.defer(stale, new Date(now + 3600_000).toISOString());
      expect(await store.start(stale, policy.leaseMs)).toBe(false);
    }
    for (const current of recovered) expect(await store.start(current, policy.leaseMs)).toBe(true);
  });

  it('honors durable retry times, keeps repeated enqueue idempotent, and resumes without an SQS timer', async () => {
    const item = jobs(1, 1)[0], store = await prepared([item]);
    const [first] = await store.claim(policy);
    const readyAt = new Date(now + 3600_000).toISOString();
    await store.defer(first, readyAt);
    await store.enqueue([item, item]);
    expect(await store.claim(policy)).toEqual([]);
    now += 3600_000;
    const [second] = await store.claim(policy);
    expect(second.token).not.toBe(first.token);
    expect(second.readyAt).toBe(readyAt);
    await store.complete(second);
    expect(await store.claim(policy)).toEqual([]);
  });

  it('moves saved captures into the OpenAI analysis lane without changing a live reservation', async () => {
    const item = { ...jobs(1, 1)[0], provider: 'gemini' as const }, store = await prepared([item]);
    const [collection] = await store.claim(policy);
    await store.enqueue([{ ...item, provider: 'openai' }]);
    await store.defer(collection, new Date(now).toISOString(), 'openai');
    const [analysis] = await store.claim(policy);
    expect(analysis.provider).toBe('openai');
    await store.defer(analysis, new Date(now).toISOString());
    await store.enqueue([{ ...item, provider: 'perplexity' }]);
    expect((await store.claim(policy))[0].provider).toBe('perplexity');
  });

  it('discards only a finalized run and fences both queued and running deliveries', async () => {
    const store = await prepared(jobs(1, 2));
    const current = await store.claim(policy);
    const removed = current.find(job => job.provider === 'openai')!;
    expect(await store.start(removed, policy.leaseMs)).toBe(true);
    await store.discardRun(removed.projectId, removed.runId);
    expect(await store.start(removed, policy.leaseMs)).toBe(false);
    for (const job of current.filter(job => job !== removed)) await store.complete(job);
    const remaining = await store.claim(policy);
    expect(remaining).toHaveLength(2);
    expect(remaining.every(job => job.runId !== removed.runId)).toBe(true);
  });

  it('gives all 100 accounts a turn before returning to a noisy account in a 15,000-job backlog', async () => {
    const items = jobs(100, 50), store = await prepared(items);
    const order: string[] = [];
    while (order.length < 108) {
      // Reconstructing SQL adapters between rounds checks that fairness is persisted across Lambda invocations.
      const current = mode === 'sql' ? makeStore() : store;
      const batch = await current.claim(policy);
      expect(batch.length).toBeLessThanOrEqual(policy.globalLimit);
      expect(batch.length).toBeGreaterThan(0);
      order.push(...batch.map(job => job.projectId));
      await Promise.all(batch.map(job => current.complete(job)));
    }
    expect(new Set(order.slice(0, 100)).size).toBe(100);
    if (mode === 'sql') expect((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM citevia_dispatch_jobs')).rows[0].count)
      .toBe(15000 - order.length);
  }, 30_000);
});

describe('SQL dispatch operational safety', () => {
  it('holds provider cooldown work in Postgres while other providers continue and leaves quota diagnosis to the worker', async () => {
    const items = jobs(1, 2); await seed(items);
    const store = new SqlScanDispatchStore(db, { now: () => new Date(now) });
    await store.enqueue(items);
    await db.query(`INSERT INTO citevia_provider_admission(scope,cooldown_until,quota_blocked_at)
      VALUES('openai',$1,$2)`, [new Date(now + 1800_000).toISOString(), new Date(now).toISOString()]);
    const first = await store.claim(policy);
    expect(first.every(job => job.provider !== 'openai')).toBe(true);
    await Promise.all(first.map(job => store.complete(job)));
    now += 1800_000;
    const next = await store.claim(policy);
    expect(next.some(job => job.provider === 'openai')).toBe(true);
  });
  it('removes dispatch intent automatically when a prompt checkpoint is deleted', async () => {
    const items = jobs(1, 1); await seed(items);
    const store = new SqlScanDispatchStore(db, { now: () => new Date(now) });
    await store.enqueue(items);
    await db.query('DELETE FROM citevia_prompt_results WHERE project_id=$1', [items[0].projectId]);
    expect(await store.claim(policy)).toEqual([]);
  });
  it('rolls back a reservation if persisting the fairness turn fails', async () => {
    const items = jobs(1, 1); await seed(items);
    const store = new SqlScanDispatchStore(db, { now: () => new Date(now) });
    await store.enqueue(items);
    const broken: SqlDatabase = { ...db, transaction: work => db.transaction(tx => work({ ...tx,
      query: async (sql, params) => {
        if (sql.startsWith('UPDATE citevia_dispatch_accounts SET last_turn')) throw Error('Storage unavailable');
        return tx.query(sql, params);
      },
    })) };
    await expect(new SqlScanDispatchStore(broken, { now: () => new Date(now) }).claim(policy)).rejects.toThrow('Storage unavailable');
    expect(await store.claim(policy)).toHaveLength(3);
  });
});
