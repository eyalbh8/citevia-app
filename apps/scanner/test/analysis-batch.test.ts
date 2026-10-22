import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, PromptResult, ScanMessage, ScanRun } from '@citevia/core';
import { MemoryArtifacts, MemoryCallLedger, MemoryQueue, MemoryRepository, PostgresRepository, SqlAnalysisBatchStore, type ProviderAdmissionStore } from '@citevia/storage';
import type { AnalysisBatchRecord, AnalysisBatchStore } from '../../../packages/storage/src/analysis-batch.js';
import { localPostgres } from '../../../packages/storage/src/local-postgres.js';
import { AnalysisBatchCoordinator, analysisBatchCustomId } from '../src/analysis-batch.js';
import { BatchSubmissionError, OpenAIBatchClient, parseBatchResultLines, type BatchClient, type NativeBatch } from '../src/openai-batch.js';
import { Scanner, runIdFor } from '../src/engine.js';
import { reanalyzeCapturedRun } from '../src/reanalysis.js';
import { analysis, captured, instant, project, snapshot } from './fixtures.js';
import { ProviderError } from '../src/provider.js';

afterEach(() => vi.unstubAllEnvs());

class MemoryBatchStore implements AnalysisBatchStore {
  readonly records = new Map<string, AnalysisBatchRecord>();
  async get(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async open(projectId: string, runId: string) { return structuredClone([...this.records.values()].find((r) => r.projectId === projectId && r.runId === runId && r.status !== 'processed') ?? null); }
  async create(record: AnalysisBatchRecord) {
    if (this.records.has(record.id) || [...this.records.values()].some((r) => r.projectId === record.projectId && r.runId === record.runId && r.status !== 'processed')) return false;
    this.records.set(record.id, structuredClone(record)); return true;
  }
  async save(record: AnalysisBatchRecord, version: number) {
    if (this.records.get(record.id)?.version !== version) return false;
    this.records.set(record.id, structuredClone(record)); return true;
  }
}
function nativeResponse() {
  const brands = analysis(captured()).brands.map(({ mentionOrder: _order, ...row }) => row);
  return { id: 'response-1', model: 'gpt-4.1-mini', status: 'completed', usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ brands }) }] }] };
}
async function setup(count = 2, admission?: ProviderAdmissionStore) {
  const store = new MemoryBatchStore(), artifacts = new MemoryArtifacts(), ledger = new MemoryCallLedger();
  let time = new Date(instant), batch: NativeBatch;
  const run: ScanRun = { projectId: project.id, id: 'run-batch-test', scheduledAt: instant, createdAt: instant, trigger: 'scheduled', status: 'running', snapshot: { ...snapshot, extractionModel: 'gpt-4.1-mini', analysisMode: 'batch' }, totalCount: count, terminalCount: 0, succeededCount: 0, capturedCount: count, resultVersion: 1, deadlineAt: '2026-10-21T08:00:00.000Z', expiresAt: 2_000_000_000 };
  const results: PromptResult[] = Array.from({ length: count }, (_, index) => ({ projectId: project.id, runId: run.id, promptId: `prompt-${index}`, responseId: `${run.id}~prompt-${index}`, prompt: { ...project.prompts[0], id: `prompt-${index}` }, status: 'analysis_pending', captureKey: `projects/p/runs/r/prompts/p-${index}/capture.json`, attempts: 1, version: 1, citationCount: 1, sourceCount: 1, expiresAt: run.expiresAt }));
  for (const result of results) await artifacts.put(result.captureKey!, captured());
  const files = new Map<string, string>();
  const client: BatchClient = {
    upload: vi.fn(async () => 'file-input'),
    create: vi.fn(async (inputFileId, correlationId) => (batch = { id: 'batch-native', input_file_id: inputFileId, status: 'in_progress', metadata: { citevia_batch: correlationId } })),
    retrieve: vi.fn(async () => batch),
    find: vi.fn(async () => null),
    download: vi.fn(async (id) => files.get(id) ?? ''),
  };
  const coordinator = new AnalysisBatchCoordinator({ store, artifacts, client, ledger, now: () => time, pollIntervalMs: 1, admission, random: () => 0 });
  const finish = async (status: NativeBatch['status'] = 'completed', failedIndexes: number[] = []) => {
    const record = [...store.records.values()][0];
    const manifest = await artifacts.get<{ items: { customId: string }[] }>(record.inputKey);
    batch = { ...batch, status, output_file_id: 'file-output', error_file_id: failedIndexes.length ? 'file-errors' : null };
    files.set('file-output', manifest!.items.flatMap((item, index) => failedIndexes.includes(index) ? [] : [JSON.stringify({ custom_id: item.customId, response: { status_code: 200, request_id: `req-${index}`, body: nativeResponse() }, error: null })]).reverse().join('\n'));
    files.set('file-errors', manifest!.items.flatMap((item, index) => failedIndexes.includes(index) ? [JSON.stringify({ custom_id: item.customId, response: null, error: { code: 'batch_expired', message: 'Expired' } })] : []).join('\n'));
    time = new Date(time.getTime() + 120_001);
  };
  return { coordinator, store, artifacts, ledger, client, run, results, files, finish, advance: (ms = 120_001) => { time = new Date(time.getTime() + ms); }, currentBatch: () => batch };
}

describe('native Batch transport and attribution', () => {
  it('uploads JSONL with batch purpose and submits independent Responses requests', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new OpenAIBatchClient({ apiKey: 'test-key', fetch: vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(String(url).endsWith('/files') ? { id: 'file-in' } : { id: 'batch-id', status: 'validating', input_file_id: 'file-in' });
    }) });
    expect(await client.upload('{"custom_id":"one"}\n')).toBe('file-in');
    expect((calls[0].init?.body as FormData).get('purpose')).toBe('batch');
    await client.create('file-in', 'stable-correlation');
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ input_file_id: 'file-in', endpoint: '/v1/responses', completion_window: '24h', metadata: { citevia_batch: 'stable-correlation' } });
    expect(calls[1].url).toBe('https://api.openai.com/v1/batches');
  });
  it('marks timeout/server failures ambiguous and definitive admission failures rejected', async () => {
    const failing = new OpenAIBatchClient({ apiKey: 'test', fetch: vi.fn(async () => new Response('{}', { status: 500 })) });
    await expect(failing.create('file', 'id')).rejects.toMatchObject({ uncertain: true });
    const rejected = new OpenAIBatchClient({ apiKey: 'test', fetch: vi.fn(async () => new Response('{}', { status: 429 })) });
    await expect(rejected.create('file', 'id')).rejects.toMatchObject({ uncertain: false, kind: 'rate_limit', safeToRetry: true, retryable: true });
  });
  it('separates hard quota from transient admission with safe metadata', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'project_spend_limit_exceeded', message: 'PRIVATE' } }, { status: 429 }));
    const client = new OpenAIBatchClient({ apiKey: 'test', fetch: fetcher });
    await expect(client.create('file', 'id')).rejects.toMatchObject({ uncertain: false, kind: 'quota', safeToRetry: false, retryable: false, providerCode: 'project_spend_limit_exceeded' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses custom IDs for out-of-order rows and rejects duplicates or unknown IDs', () => {
    const row = (id: string) => JSON.stringify({ custom_id: id, response: { status_code: 200, body: nativeResponse() } });
    expect([...parseBatchResultLines(`${row('b')}\n${row('a')}`, new Set(['a', 'b'])).keys()]).toEqual(['b', 'a']);
    expect(() => parseBatchResultLines(`${row('a')}\n${row('a')}`, new Set(['a']))).toThrow('duplicate');
    expect(() => parseBatchResultLines(row('unknown'), new Set(['a']))).toThrow('unknown');
  });
  it('discovers uncertain creations by metadata and input file over paginated results', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes('after=') ? { data: [{ id: 'found', input_file_id: 'file-in', status: 'completed', metadata: { citevia_batch: 'scope' } }], has_more: false } : { data: [{ id: 'unrelated', input_file_id: 'other', status: 'completed' }], has_more: true, last_id: 'unrelated' }));
    expect((await new OpenAIBatchClient({ apiKey: 'test', fetch }).find('scope', 'file-in'))?.id).toBe('found');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('durable analysis batching', () => {
  it('grants the full processing and import window after late collection, without extending it on polls', async () => {
    const f = await setup(1);
    f.advance(29 * 60 * 60_000);
    const submittedAt = new Date(Date.parse(instant) + 29 * 60 * 60_000).toISOString();
    const deadlineAt = new Date(Date.parse(submittedAt) + 26 * 60 * 60_000).toISOString();
    const first = await f.coordinator.process(f.run, f.results);
    expect(first).toMatchObject({ updates: [], deadlineAt });
    expect([...f.store.records.values()][0]).toMatchObject({ submittedAt, processingDeadlineAt: deadlineAt });
    f.advance(23 * 60 * 60_000);
    expect(await f.coordinator.process(f.run, f.results)).toMatchObject({ updates: [], deadlineAt });
    await f.finish();
    const completed = await f.coordinator.process(f.run, f.results);
    expect(completed.deadlineAt).toBe(deadlineAt);
    expect(completed.updates[0].analysis).toBeDefined();
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('starts the processing clock on accepted submission, after a definite rejection cooldown', async () => {
    const f = await setup(1);
    vi.mocked(f.client.create).mockRejectedValueOnce(new BatchSubmissionError(false, 'analysis_batch_http_429', null,
      { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 3_600_000 }));
    expect((await f.coordinator.process(f.run, f.results)).deadlineAt).toBeUndefined();
    f.advance(3_600_000);
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.deadlineAt).toBe(new Date(Date.parse(instant) + 27 * 60 * 60_000).toISOString());
    expect([...f.store.records.values()][0].submittedAt).toBe(new Date(Date.parse(instant) + 3_600_000).toISOString());
    expect(f.client.upload).toHaveBeenCalledOnce();
  });
  it('recovers the provider creation time after an ambiguous submission without restarting its clock', async () => {
    const f = await setup(1);
    vi.mocked(f.client.create).mockRejectedValueOnce(new BatchSubmissionError(true, 'submission_uncertain'));
    const initial = await f.coordinator.process(f.run, f.results);
    expect(initial.deadlineAt).toBe(new Date(Date.parse(instant) + 26 * 60 * 60_000).toISOString());
    f.advance(6 * 60 * 60_000);
    expect((await f.coordinator.process(f.run, f.results)).deadlineAt).toBe(initial.deadlineAt);
    const record = [...f.store.records.values()][0];
    const createdAt = Date.parse(instant) / 1000 + 2;
    const recovered: NativeBatch = { id: 'recovered', input_file_id: 'file-input', status: 'in_progress',
      created_at: createdAt, metadata: { citevia_batch: record.id } };
    vi.mocked(f.client.find).mockResolvedValue(recovered);
    vi.mocked(f.client.retrieve).mockResolvedValue(recovered);
    f.advance();
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.deadlineAt).toBe(new Date(createdAt * 1000 + 26 * 60 * 60_000).toISOString());
    expect([...f.store.records.values()][0].submittedAt).toBe(new Date(createdAt * 1000).toISOString());
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('returns a persisted deadline when polling is deferred or a second worker owns the batch lease', async () => {
    const f = await setup(1);
    const initial = await f.coordinator.process(f.run, f.results);
    expect((await f.coordinator.process(f.run, f.results)).deadlineAt).toBe(initial.deadlineAt);
    const record = [...f.store.records.values()][0];
    await f.store.save({ ...record, version: record.version + 1, leaseExpiresAt: new Date(Date.parse(instant) + 600_000).toISOString() }, record.version);
    f.advance();
    expect((await f.coordinator.process(f.run, f.results)).deadlineAt).toBe(initial.deadlineAt);
    expect(f.client.retrieve).toHaveBeenCalledOnce();
  });
  it('retries definite submission throttles at most three times and honors the stored delay', async () => {
    const f = await setup(1);
    vi.mocked(f.client.create).mockRejectedValue(new BatchSubmissionError(false, 'analysis_batch_http_429', null,
      { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 180_000 }));
    await f.coordinator.process(f.run, f.results);
    expect([...f.store.records.values()][0]).toMatchObject({ status: 'prepared', submitAttempts: 1, nextPollAt: new Date(Date.parse(instant) + 180_000).toISOString() });
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).toHaveBeenCalledOnce();
    let final;
    for (let attempt = 1; attempt < 4; attempt++) {
      f.advance(300_000);
      final = await f.coordinator.process(f.run, f.results);
    }
    expect(f.client.create).toHaveBeenCalledTimes(4);
    expect(f.client.upload).toHaveBeenCalledOnce();
    expect(final?.updates[0].error).toMatchObject({ retryable: false, kind: 'rate_limit' });
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).toHaveBeenCalledTimes(4);
    expect([...f.ledger.calls.values()][0].outcome).toMatchObject({ status: 'failed', estimatedUsd: 0 });
  });
  it('recovers a rejected submission with the same saved file and correlation identity', async () => {
    const f = await setup(1);
    vi.mocked(f.client.create).mockRejectedValueOnce(new BatchSubmissionError(false, 'analysis_batch_http_429', null, { kind: 'rate_limit', safeToRetry: true }));
    await f.coordinator.process(f.run, f.results);
    f.advance();
    await f.coordinator.process(f.run, f.results);
    expect(vi.mocked(f.client.create).mock.calls[0]).toEqual(vi.mocked(f.client.create).mock.calls[1]);
    expect([...f.store.records.values()][0]).toMatchObject({ status: 'submitted', submitAttempts: 2 });
    await f.finish();
    expect((await f.coordinator.process(f.run, f.results)).updates[0].analysis).toBeDefined();
    expect(f.client.upload).toHaveBeenCalledOnce();
  });
  it('does not charge an admission deferral against the submission retry limit', async () => {
    const admission: ProviderAdmissionStore = { acquire: vi.fn().mockResolvedValueOnce({ admitted: false, reason: 'spacing', retryAfterMs: 90_000 }).mockResolvedValue({ admitted: true, leaseId: 'lease' }), complete: vi.fn(), resetQuota: vi.fn() };
    const f = await setup(1, admission);
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).not.toHaveBeenCalled();
    expect([...f.store.records.values()][0]).toMatchObject({ status: 'prepared', submitAttempts: 0 });
    f.advance();
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).toHaveBeenCalledOnce();
    expect([...f.store.records.values()][0].submitAttempts).toBe(1);
  });
  it('opens the shared hard-quota circuit and never retries quota-rejected submissions', async () => {
    const admission: ProviderAdmissionStore = { acquire: vi.fn().mockResolvedValue({ admitted: true, leaseId: 'lease' }), complete: vi.fn(), resetQuota: vi.fn() };
    const f = await setup(1, admission);
    vi.mocked(f.client.create).mockRejectedValue(new BatchSubmissionError(false, 'analysis_batch_http_429', null, { kind: 'quota', safeToRetry: false, providerCode: 'insufficient_quota' }));
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0].error).toMatchObject({ kind: 'quota', retryable: false, providerCode: 'insufficient_quota' });
    expect(admission.complete).toHaveBeenCalledWith('openai', 'lease', expect.objectContaining({ kind: 'quota' }));
    f.advance();
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('bounds failed upload retries without submitting inference', async () => {
    const f = await setup(1);
    vi.mocked(f.client.upload).mockRejectedValue(new ProviderError('analysis_batch_network', 'Upload unavailable.', true, null, { kind: 'transient', safeToRetry: true }));
    let output;
    for (let attempt = 0; attempt < 4; attempt++) {
      output = await f.coordinator.process(f.run, f.results);
      f.advance(300_000);
    }
    expect(f.client.upload).toHaveBeenCalledTimes(4);
    expect(f.client.create).not.toHaveBeenCalled();
    expect(output?.updates[0].error?.retryable).toBe(false);
  });
  it('bounds read failures and retains the paid submission for review', async () => {
    const f = await setup(1);
    vi.mocked(f.client.retrieve).mockRejectedValue(new ProviderError('analysis_batch_http_503', 'Read unavailable.', true, null, { kind: 'transient', safeToRetry: true }));
    let output;
    for (let attempt = 0; attempt < 4; attempt++) {
      output = await f.coordinator.process(f.run, f.results);
      f.advance(300_000);
    }
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(f.client.retrieve).toHaveBeenCalledTimes(4);
    expect(output?.updates[0].error?.retryable).toBe(false);
    expect([...f.ledger.calls.values()][0].outcome).toMatchObject({ status: 'uncertain', estimatedUsd: null });
    expect([...f.store.records.values()][0].providerBatchId).toBe('batch-native');
  });
  it('classifies failed batch items individually and preserves successful paid results', async () => {
    const admission: ProviderAdmissionStore = { acquire: vi.fn().mockResolvedValue({ admitted: true, leaseId: 'lease' }), complete: vi.fn(), resetQuota: vi.fn() };
    const f = await setup(3, admission);
    for (const result of f.results) result.analysisAttempts = 1;
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    const rows = f.files.get('file-output')!.split('\n').map(line => JSON.parse(line));
    rows[0].response = { status_code: 429, body: { error: { code: 'insufficient_quota', message: 'SECRET' } } };
    rows[1].response = { status_code: 429, body: { error: { code: 'rate_limit_exceeded', message: 'SECRET' } } };
    f.files.set('file-output', rows.map(row => JSON.stringify(row)).join('\n'));
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0]).toMatchObject({ analysisAttempt: 1, analysis: expect.any(Object) });
    expect(output.updates[1]).toMatchObject({ analysisAttempt: 1, error: { kind: 'rate_limit', safeToRetry: true, retryable: true, providerCode: 'rate_limit_exceeded' } });
    expect(output.updates[2]).toMatchObject({ analysisAttempt: 1, error: { kind: 'quota', safeToRetry: false, retryable: false, providerCode: 'insufficient_quota' } });
    expect(JSON.stringify(output.updates.map(update => update.error))).not.toContain('SECRET');
    expect(admission.complete).toHaveBeenCalledWith('openai', expect.stringMatching(/^batch:/), expect.objectContaining({ kind: 'quota' }));
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('uses safe validation quota codes when the rejected batch has no output rows', async () => {
    const admission: ProviderAdmissionStore = { acquire: vi.fn().mockResolvedValue({ admitted: true, leaseId: 'lease' }), complete: vi.fn(), resetQuota: vi.fn() };
    const f = await setup(1, admission);
    await f.coordinator.process(f.run, f.results);
    await f.finish('failed');
    const batch = f.currentBatch();
    batch.output_file_id = null;
    batch.error_file_id = null;
    batch.errors = { data: [{ code: 'organization_usage_limit_exceeded', message: 'PRIVATE' }] };
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0].error).toMatchObject({ kind: 'quota', retryable: false, providerCode: 'organization_usage_limit_exceeded' });
    expect(JSON.stringify(output.updates[0].error)).not.toContain('PRIVATE');
    expect(admission.complete).toHaveBeenCalledWith('openai', expect.stringMatching(/^batch:/), expect.objectContaining({ kind: 'quota' }));
    expect([...f.ledger.calls.values()][0].outcome).toMatchObject({ status: 'failed', estimatedUsd: 0 });
  });
  it('uses the shared Luna request policy without transmitting local fallback or cost configuration', async () => {
    const f = await setup(1);
    f.run.snapshot.extractionModel = 'gpt-6-luna';
    f.run.snapshot.extractionFallbackModel = 'gpt-4.1-mini';
    await f.coordinator.process(f.run, f.results);
    const line = JSON.parse(vi.mocked(f.client.upload).mock.calls[0][0].trim());
    expect(line.body).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'none' }, max_output_tokens: 12000 });
    expect(line.body).not.toHaveProperty('costContext');
    expect(line.body).not.toHaveProperty('extractionFallbackModel');
    expect(line.body).not.toHaveProperty('tools');
  });
  it('submits once under concurrent duplicate delivery, then imports partial out-of-order output', async () => {
    const f = await setup();
    await Promise.all([f.coordinator.process(f.run, f.results), f.coordinator.process(f.run, f.results)]);
    expect(f.client.create).toHaveBeenCalledOnce();
    const jsonl = vi.mocked(f.client.upload).mock.calls[0][0].trim().split('\n').map((line) => JSON.parse(line));
    expect(jsonl).toHaveLength(2);
    expect(jsonl.every((line) => line.url === '/v1/responses' && !line.body.tools)).toBe(true);
    await f.finish('expired', [1]);
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates.map((u) => [u.promptId, !!u.analysis, !!u.error])).toEqual([['prompt-0', true, false], ['prompt-1', false, true]]);
    expect(output.updates[0].analysis?.usage.totalTokens).toBe(180);
    expect([...f.ledger.calls.values()].map((c) => c.outcome?.status)).toEqual(['succeeded', 'failed']);
    const replay = await f.coordinator.process(f.run, f.results.slice(1));
    expect(replay).toEqual(output);
    expect(f.client.create).toHaveBeenCalledOnce();
    await f.coordinator.complete(output.batchId!);
    expect((await f.store.get(output.batchId!))?.status).toBe('processed');
  });
  it('recovers a temporary saved-analysis write failure by importing the same paid output', async () => {
    const f = await setup(2);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    const put = f.artifacts.put.bind(f.artifacts);
    let failed = false;
    vi.spyOn(f.artifacts, 'put').mockImplementation(async (key, value) => {
      if (key.endsWith('/p-1/analysis.json') && !failed) {
        failed = true;
        throw new Error('Temporary object storage failure');
      }
      return put(key, value);
    });
    await expect(f.coordinator.process(f.run, f.results)).rejects.toThrow('Temporary object storage failure');
    expect([...f.store.records.values()][0].status).toBe('submitted');
    f.advance();
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates).toHaveLength(2);
    expect(output.updates.every(update => update.analysis && !update.error)).toBe(true);
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(f.client.upload).toHaveBeenCalledOnce();
  });
  it('does not discard a validated paid result when its optional receipt observer fails', async () => {
    const f = await setup(1);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const observer = vi.fn(async () => { throw new Error('Telemetry unavailable'); });
      const coordinator = new AnalysisBatchCoordinator({ store: f.store, artifacts: f.artifacts, client: f.client,
        ledger: f.ledger, now: () => new Date(Date.parse(instant) + 120_001), onReceipt: observer });
      const output = await coordinator.process(f.run, f.results);
      expect(output.updates[0].analysis).toBeDefined();
      expect(output.updates[0].error).toBeUndefined();
      expect(observer).toHaveBeenCalledOnce();
      expect(f.client.create).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it('never repeats an ambiguous submission, even when discovery has no match', async () => {
    const f = await setup(1);
    vi.mocked(f.client.create).mockRejectedValueOnce(new BatchSubmissionError(true, 'submission_uncertain'));
    await f.coordinator.process(f.run, f.results);
    f.advance();
    await f.coordinator.process(f.run, f.results);
    expect(f.client.find).toHaveBeenCalledOnce();
    expect(f.client.create).toHaveBeenCalledOnce();
    expect([...f.store.records.values()][0].status).toBe('submission_uncertain');
    expect([...f.ledger.calls.values()][0].outcome).toBeUndefined();
    const record = [...f.store.records.values()][0];
    const recovered: NativeBatch = { id: 'recovered', input_file_id: 'file-input', status: 'in_progress', metadata: { citevia_batch: record.id } };
    vi.mocked(f.client.find).mockResolvedValue(recovered);
    vi.mocked(f.client.retrieve).mockResolvedValue(recovered);
    f.advance();
    await f.coordinator.process(f.run, f.results);
    expect([...f.store.records.values()][0].providerBatchId).toBe('recovered');
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('resumes a crash after submission by discovery rather than a second paid POST', async () => {
    const f = await setup(1), originalSave = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementationOnce(originalSave).mockImplementationOnce(originalSave).mockImplementationOnce(originalSave).mockImplementationOnce(async () => { throw new Error('database unavailable after create'); });
    await f.coordinator.process(f.run, f.results);
    vi.mocked(f.store.save).mockImplementation(originalSave);
    f.advance();
    vi.mocked(f.client.find).mockResolvedValue(f.currentBatch());
    await f.coordinator.process(f.run, f.results);
    expect(f.client.create).toHaveBeenCalledOnce();
    expect(f.client.find).toHaveBeenCalledOnce();
  });
  it('reuses a validated exact analysis before uploading a new batch', async () => {
    const f = await setup(1);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    const completed = await f.coordinator.process(f.run, f.results);
    await f.coordinator.complete(completed.batchId!);
    const retried = [{ ...f.results[0], lastRetryRequestId: 'explicit-retry' }];
    const reused = await f.coordinator.process(f.run, retried);
    expect(reused.updates[0].analysis?.reusedFrom).toContain(`analysis-cache/${project.id}/`);
    expect(reused.updates[0].analysis?.usage.totalTokens).toBe(0);
    expect(reused.updates[0].retryRequestId).toBe('explicit-retry');
    expect(f.client.upload).toHaveBeenCalledOnce();
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('changes request identity for a new explicit retry or different analysis input', async () => {
    const f = await setup(1), body = { model: 'gpt-4.1-mini' };
    const original = analysisBatchCustomId(f.run, f.results[0], body);
    expect(analysisBatchCustomId(f.run, structuredClone(f.results[0]), body)).toBe(original);
    expect(analysisBatchCustomId(f.run, { ...f.results[0], lastRetryRequestId: 'retry-1' }, body)).not.toBe(original);
    expect(analysisBatchCustomId(f.run, f.results[0], { model: 'another-model' })).not.toBe(original);
    expect(analysisBatchCustomId(f.run, { ...f.results[0], analysisAttempts: 2 }, body)).not.toBe(original);
  });
  it('rejects batch admission before inference if the estimated budget is exhausted', async () => {
    vi.stubEnv('LLM_MONTHLY_BUDGET_USD', '0.000001');
    const f = await setup();
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates.every((update) => update.error?.code === 'cost_budget_exceeded')).toBe(true);
    expect(f.client.create).not.toHaveBeenCalled();
  });
  it('keeps raw malformed output and fails safely without buying replacement analyses', async () => {
    const f = await setup(1);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    f.files.set('file-output', '{broken');
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0].error?.code).toBe('analysis_batch_invalid_output');
    expect([...f.artifacts.values.keys()].some((key) => key.endsWith('.file-output.json'))).toBe(true);
    expect(f.client.create).toHaveBeenCalledOnce();
  });
  it('retains the cost reservation when a completed batch omits an item without an explicit error', async () => {
    const f = await setup(1);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    f.files.set('file-output', '');
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0].error?.code).toBe('analysis_batch_completed_missing_item');
    expect([...f.ledger.calls.values()][0].outcome).toMatchObject({ status: 'uncertain', estimatedUsd: null });
  });
  it('retains the cost reservation for a valid response whose native usage is missing or partial', async () => {
    const f = await setup(1);
    await f.coordinator.process(f.run, f.results);
    await f.finish();
    const row = JSON.parse(f.files.get('file-output')!);
    row.response.body.usage = { input_tokens: 120 };
    f.files.set('file-output', JSON.stringify(row));
    const output = await f.coordinator.process(f.run, f.results);
    expect(output.updates[0].analysis).toBeDefined();
    expect([...f.ledger.calls.values()][0].outcome).toMatchObject({ status: 'uncertain', estimatedUsd: null });
  });
});

describe('scanner batch lifecycle', () => {
  it('keeps an explicit saved-answer reanalysis realtime even when the original scan was batched', async () => {
    const f = await setup(1), repository = new MemoryRepository(), queue = new MemoryQueue();
    await repository.saveProject(structuredClone(project), null);
    await repository.createRun(f.run, f.results);
    const replacement = await reanalyzeCapturedRun({ repository, artifacts: f.artifacts, queue }, project.id, f.run.id, 'reviewed-reanalysis', new Date(instant));
    const run = await repository.getRun(project.id, replacement.runId);
    expect(run?.snapshot.analysisMode).toBe('realtime');
    expect(run?.snapshot.projectId).toBe(project.id);
    expect(run?.snapshot.extractionModel).toBe(f.run.snapshot.extractionModel);
    expect(replacement.newCollectionCalls).toBe(0);
  });
  it('captures all answers first, keeps manual scans realtime, then imports scheduled analysis through CAS', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    await repository.saveProject(structuredClone(project), null);
    let ready = false;
    const process = vi.fn(async (_run: ScanRun, results: PromptResult[]) => ({ batchId: ready ? 'test-batch' : undefined, updates: ready ? results.filter((r) => r.status === 'analysis_pending').map((r) => ({ promptId: r.promptId, captureKey: r.captureKey!, analysisKey: `${r.captureKey}.analysis`, analysis: analysis(captured()) })) : [] }));
    const port = { process, complete: vi.fn(async () => {}) }, provider = { collect: vi.fn(async () => captured()), extract: vi.fn(async () => analysis(captured())) };
    const scanner = new Scanner({ repository, artifacts, queue, provider, analysisBatch: port, now: () => new Date(instant) });
    const kickoff: Extract<ScanMessage, { kind: 'kickoff' }> = { kind: 'kickoff', projectId: project.id, scheduledAt: instant };
    await scanner.handle(kickoff);
    const jobs = queue.messages.filter((message) => message.kind === 'prompt');
    await scanner.handle(jobs[0]);
    expect(process).not.toHaveBeenCalled();
    await scanner.handle(jobs[1]);
    expect(process).toHaveBeenCalledOnce();
    expect(provider.extract).not.toHaveBeenCalled();
    expect((await repository.listResults(project.id, runIdFor(kickoff))).every((r) => r.status === 'analysis_pending')).toBe(true);
    await scanner.handleDeadLetter(jobs[0]);
    expect((await repository.getResult(project.id, runIdFor(kickoff), project.prompts[0].id))?.status).toBe('analysis_pending');
    expect((await repository.getRun(project.id, runIdFor(kickoff)))?.snapshot.analysisMode).toBe('batch');
    ready = true;
    await scanner.handle({ kind: 'reconcile' });
    expect((await repository.getRun(project.id, runIdFor(kickoff)))?.status).toBe('completed');
    expect(port.complete).toHaveBeenCalledWith('test-batch');
    await scanner.handle({ ...kickoff, trigger: 'manual', requestId: 'manual-realtime-test' });
    const manual = (await repository.listRuns(project.id)).find((run) => run.trigger === 'manual');
    expect(manual?.snapshot.analysisMode).toBe('realtime');
  });
  it('runs bounded maintenance on reconciliation without letting cleanup failure interrupt scans', async () => {
    const maintenance = { reconcile: vi.fn(async () => { throw new Error('temporary database error'); }) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const scanner = new Scanner({ repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue(), provider: { collect: vi.fn(), extract: vi.fn() }, maintenance });
      await expect(scanner.handle({ kind: 'reconcile' })).resolves.toBeUndefined();
      expect(maintenance.reconcile).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'scanner_maintenance_failed' }));
    } finally { log.mockRestore(); }
  });
});

describe('SQL batch persistence', () => {
  it('keeps exactly one active batch per scan and enforces CAS across store instances', async () => {
    const db = await localPostgres();
    try {
      await new PostgresRepository(db).saveProject(structuredClone(project), null);
      const first = new SqlAnalysisBatchStore(db), second = new SqlAnalysisBatchStore(db);
      const record: AnalysisBatchRecord = { id: 'batch-a', projectId: project.id, runId: 'run-a', version: 0, status: 'prepared', inputKey: 'private-input', createdAt: instant, updatedAt: instant, expiresAt: 2_000_000_000 };
      expect(await first.create(record)).toBe(true);
      expect(await second.create({ ...record, id: 'batch-b' })).toBe(false);
      expect(await second.get(record.id)).toEqual(record);
      expect(await first.save({ ...record, version: 1, status: 'creating' }, 0)).toBe(true);
      expect(await second.save({ ...record, version: 1, status: 'submitted' }, 0)).toBe(false);
      expect((await second.open(project.id, 'run-a'))?.status).toBe('creating');
    } finally { await db.close(); }
  });
});
