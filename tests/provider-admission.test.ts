import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryArtifacts, MemoryCallLedger, SqlProviderAdmissionStore,
  type ProviderAdmissionPolicy, type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { guardScanProvider, providerAdmissionPolicy } from '../apps/scanner/src/provider-admission.js';
import { observeScanProviderCollections, optimizeScanProvider } from '../apps/scanner/src/analysis-costs.js';
import { OpenAIAnswerProvider } from '../apps/scanner/src/openai.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { captured, project, snapshot, target } from '../apps/scanner/test/fixtures.js';

const initialTime = Date.parse('2026-10-22T12:00:00.000Z');
const policy: ProviderAdmissionPolicy = { minIntervalMs: 10_000, maxConcurrent: 2, leaseMs: 300_000 };
let db: SqlDatabase, now: number;
const store = () => new SqlProviderAdmissionStore(db, { now: () => new Date(now) });
beforeAll(async () => { db = await localPostgres(); }, 30_000);
beforeEach(async () => {
  now = initialTime;
  await db.exec('TRUNCATE citevia_provider_leases,citevia_provider_admission');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.close(); });

describe('shared provider admission', () => {
  it('serializes different workers and enforces shared spacing even after a fast completion', async () => {
    const decisions = await Promise.all(Array.from({ length: 8 }, () => store().acquire('openai', policy)));
    expect(decisions.filter(result => result.admitted)).toHaveLength(1);
    const admitted = decisions.find(result => result.admitted)!;
    if (!admitted.admitted) throw Error('Expected admission');
    await store().complete('openai', admitted.leaseId);
    expect(await store().acquire('openai', policy)).toEqual({ admitted: false, reason: 'spacing', retryAfterMs: 10_000 });
    now += 10_000;
    expect(await store().acquire('openai', policy)).toMatchObject({ admitted: true });
    expect(await store().acquire('gemini', policy)).toMatchObject({ admitted: true });
  });

  it('caps in-flight calls across workers and recovers capacity after a crashed lease expires', async () => {
    const concurrent = { ...policy, minIntervalMs: 0 };
    const decisions = await Promise.all(Array.from({ length: 8 }, () => store().acquire('openai', concurrent)));
    expect(decisions.filter(result => result.admitted)).toHaveLength(2);
    expect(decisions.filter(result => !result.admitted)).toEqual(Array(6).fill({ admitted: false, reason: 'concurrency', retryAfterMs: 30_000 }));
    now += policy.leaseMs;
    expect(await store().acquire('openai', concurrent)).toMatchObject({ admitted: true });
    expect((await db.query('SELECT id FROM citevia_provider_leases')).rows).toHaveLength(1);
  });

  it('persists long Retry-After cooldowns without shortening them after another worker succeeds', async () => {
    const first = await store().acquire('openai', { ...policy, minIntervalMs: 0 });
    const second = await store().acquire('openai', { ...policy, minIntervalMs: 0 });
    if (!first.admitted || !second.admitted) throw Error('Expected admissions');
    await store().complete('openai', first.leaseId, { kind: 'rate_limit', retryAfterMs: 1_800_000 });
    await store().complete('openai', second.leaseId);
    await store().complete('openai', 'another-rejected-request', { kind: 'rate_limit', retryAfterMs: 60_000 });
    now += 900_000;
    expect(await store().acquire('openai', policy)).toEqual({ admitted: false, reason: 'cooldown', retryAfterMs: 900_000 });
    now += 900_000;
    expect(await store().acquire('openai', policy)).toMatchObject({ admitted: true });
  });

  it('keeps quota circuits open across workers until an operator resets them and blocks dependent collection', async () => {
    await store().complete('openai', 'rejected-batch-item', { kind: 'quota' });
    now += 30 * 86400_000;
    expect(await store().acquire('openai', policy)).toEqual({ admitted: false, reason: 'quota', blockedScope: 'openai' });
    expect(await store().acquire('gemini', policy, 'openai')).toEqual({ admitted: false, reason: 'quota', blockedScope: 'openai' });
    expect((await db.query('SELECT id FROM citevia_provider_leases')).rows).toHaveLength(0);
    await store().resetQuota('openai');
    expect(await store().acquire('gemini', policy, 'openai')).toMatchObject({ admitted: true });
  });

  it('keeps an extreme Retry-After blocked without a Date overflow', async () => {
    await store().complete('openai', 'extreme-rejection', { kind: 'rate_limit', retryAfterMs: Number.MAX_SAFE_INTEGER });
    const decision = await store().acquire('openai', policy);
    expect(decision).toMatchObject({ admitted: false, reason: 'cooldown' });
    if (!decision.admitted && decision.reason === 'cooldown') expect(decision.retryAfterMs).toBeGreaterThan(365 * 86400_000);
  });

  it('rolls back an admission if updating its pacing state fails', async () => {
    const broken: SqlDatabase = { ...db, transaction: work => db.transaction(tx => work({ ...tx,
      query: async (query, params) => {
        if (query.startsWith('UPDATE citevia_provider_admission SET next_request_at')) throw Error('Storage failure');
        return tx.query(query, params);
      },
    })) };
    await expect(new SqlProviderAdmissionStore(broken).acquire('openai', policy)).rejects.toThrow('Storage failure');
    expect((await db.query('SELECT id FROM citevia_provider_leases')).rows).toHaveLength(0);
    expect((await db.query('SELECT scope FROM citevia_provider_admission')).rows).toHaveLength(0);
  });
});

describe('scanner admission composition', () => {
  it('defers before a paid call or ledger reservation and releases leases after success', async () => {
    const ledger = new MemoryCallLedger(), collect = vi.fn(async () => captured());
    const provider = guardScanProvider(observeScanProviderCollections({ collect, extract: vi.fn() }, { ledger }), store(), { policy: () => policy });
    const gemini = { ...snapshot, provider: 'gemini' as const };
    await provider.collect('test', gemini);
    await expect(provider.collect('test', gemini)).rejects.toMatchObject({ kind: 'deferred', retryAfterMs: 10_000, safeToRetry: true });
    expect(collect).toHaveBeenCalledOnce();
    expect(ledger.calls.size).toBe(1);
    expect((await db.query('SELECT id FROM citevia_provider_leases')).rows).toHaveLength(0);
  });

  it('shares a rejection cooldown across collection and extraction, then opens the quota circuit', async () => {
    const extraction = vi.fn()
      .mockRejectedValueOnce(new ProviderError('openai_http_429', 'Rate limited', true, 'req1',
        { kind: 'rate_limit', retryAfterMs: 1_800_000, safeToRetry: true }))
      .mockRejectedValueOnce(new ProviderError('openai_http_429', 'Quota exhausted', false, 'req2',
        { kind: 'quota', safeToRetry: false }));
    const collect = vi.fn(), provider = guardScanProvider({ collect, extract: extraction }, store(), { policy: () => policy });
    await expect(provider.extract(captured(), snapshot)).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(provider.collect('test', snapshot)).rejects.toMatchObject({ kind: 'deferred', retryAfterMs: 1_800_000 });
    now += 1_800_000;
    await expect(provider.extract(captured(), snapshot)).rejects.toMatchObject({ kind: 'quota' });
    await expect(provider.collect('test', { ...snapshot, provider: 'perplexity' })).rejects.toMatchObject({ code: 'provider_quota_blocked', provider: 'openai' });
    expect(collect).not.toHaveBeenCalled();
    expect(extraction).toHaveBeenCalledTimes(2);
  });

  it('serves a validated exact cache hit even while paid provider usage is blocked', async () => {
    const artifacts = new MemoryArtifacts(), receivedAt = new Date(now).toISOString();
    const extract = vi.fn(async () => ({ requestId: 'request1', receivedAt, response: {
      status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 30, output_tokens: 40, total_tokens: 70 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        companies: [{ name: 'Acme', evidenceId: 0, sentiment: 'positive', sentimentEvidenceId: 0 }],
        brands: { [target.id]: { mentioned: true, sentiment: 'positive', evidenceIds: [0], sentimentEvidenceId: 0, explicitRank: null, rankEvidenceId: null } },
      }) }] }],
    } }));
    const provider = optimizeScanProvider(guardScanProvider(new OpenAIAnswerProvider({ answer: vi.fn(), extract }), store(), { policy: () => policy }),
      { artifacts, now: () => new Date(now) });
    const config = { ...snapshot, projectId: project.id, competitors: [], parserVersion: 'igeo-evidence-v2', extractionModel: 'gpt-6-luna' };
    const answer = captured('Acme is useful.');
    await provider.extract(answer, config);
    await store().complete('openai', 'other-worker', { kind: 'quota' });
    const cached = await provider.extract(answer, config);
    expect(cached.reusedFrom).toBeTruthy();
    expect(cached.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(extract).toHaveBeenCalledOnce();
  });

  it('shares a provider overload Retry-After across workers', async () => {
    const extract = vi.fn().mockRejectedValue(new ProviderError('openai_http_503', 'Overloaded', true, 'request1',
      { kind: 'transient', safeToRetry: true, retryAfterMs: 120_000 }));
    const provider = guardScanProvider({ collect: vi.fn(), extract }, store(), { policy: () => policy });
    await expect(provider.extract(captured(), snapshot)).rejects.toMatchObject({ kind: 'transient' });
    await expect(provider.extract(captured(), snapshot)).rejects.toMatchObject({ kind: 'deferred', retryAfterMs: 120_000 });
    expect(extract).toHaveBeenCalledOnce();
  });

  it('fails closed before HTTP if shared admission is unavailable, without losing an already paid success on release failure', async () => {
    const collect = vi.fn(async () => captured()), admission = store();
    vi.spyOn(admission, 'acquire').mockRejectedValueOnce(Error('Database unavailable'));
    const provider = guardScanProvider({ collect, extract: vi.fn() }, admission, { policy: () => policy });
    await expect(provider.collect('test', snapshot)).rejects.toMatchObject({ kind: 'deferred', code: 'provider_admission_unavailable' });
    expect(collect).not.toHaveBeenCalled();
    const complete = vi.spyOn(admission, 'complete').mockRejectedValue(Error('Database unavailable'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider.collect('test', snapshot)).resolves.toMatchObject({ text: captured().text });
    expect(collect).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('retries only metadata when two circuit writes fail and persists the quota on the third write', async () => {
    const admission = store();
    const complete = vi.spyOn(admission, 'complete')
      .mockRejectedValueOnce(Error('Temporary database failure'))
      .mockRejectedValueOnce(Error('Temporary database failure'));
    const extract = vi.fn().mockRejectedValue(new ProviderError('openai_http_429', 'Quota exhausted', false, 'req1',
      { kind: 'quota', safeToRetry: false }));
    const provider = guardScanProvider({ collect: vi.fn(), extract }, admission, { policy: () => policy });
    await expect(provider.extract(captured(), snapshot)).rejects.toMatchObject({ kind: 'quota', code: 'openai_http_429' });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(extract).toHaveBeenCalledOnce();
    expect(await store().acquire('openai', policy)).toEqual({ admitted: false, reason: 'quota', blockedScope: 'openai' });
  });

  it('supports provider-specific conservative configuration and rejects invalid values', () => {
    expect(providerAdmissionPolicy('openai')).toEqual(policy);
    vi.stubEnv('SCANNER_PROVIDER_MIN_INTERVAL_MS', '15000');
    vi.stubEnv('SCANNER_OPENAI_MAX_CONCURRENT', '1');
    expect(providerAdmissionPolicy('openai')).toEqual({ ...policy, minIntervalMs: 15_000, maxConcurrent: 1 });
    vi.stubEnv('SCANNER_OPENAI_MIN_INTERVAL_MS', '0');
    expect(() => providerAdmissionPolicy('openai')).toThrow('supported range');
  });
});
