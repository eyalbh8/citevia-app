import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, PromptResult, ScanMessage, ScanRun } from '@citevia/core';
import { MemoryArtifacts, MemoryCallLedger, MemoryQueue, MemoryRepository, PostgresRepository, SqlAnalysisBatchStore } from '@citevia/storage';
import type { AnalysisBatchRecord, AnalysisBatchStore } from '../../../packages/storage/src/analysis-batch.js';
import { localPostgres } from '../../../packages/storage/src/local-postgres.js';
import { AnalysisBatchCoordinator, analysisBatchCustomId } from '../src/analysis-batch.js';
import { BatchSubmissionError, OpenAIBatchClient, parseBatchResultLines, type BatchClient, type NativeBatch } from '../src/openai-batch.js';
import { Scanner, runIdFor } from '../src/engine.js';
import { reanalyzeCapturedRun } from '../src/reanalysis.js';
import { analysis, captured, instant, project, snapshot } from './fixtures.js';

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
async function setup(count = 2) {
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
  const coordinator = new AnalysisBatchCoordinator({ store, artifacts, client, ledger, now: () => time, pollIntervalMs: 1 });
  const finish = async (status: NativeBatch['status'] = 'completed', failedIndexes: number[] = []) => {
    const record = [...store.records.values()][0];
    const manifest = await artifacts.get<{ items: { customId: string }[] }>(record.inputKey);
    batch = { ...batch, status, output_file_id: 'file-output', error_file_id: failedIndexes.length ? 'file-errors' : null };
    files.set('file-output', manifest!.items.flatMap((item, index) => failedIndexes.includes(index) ? [] : [JSON.stringify({ custom_id: item.customId, response: { status_code: 200, request_id: `req-${index}`, body: nativeResponse() }, error: null })]).reverse().join('\n'));
    files.set('file-errors', manifest!.items.flatMap((item, index) => failedIndexes.includes(index) ? [JSON.stringify({ custom_id: item.customId, response: null, error: { code: 'batch_expired', message: 'Expired' } })] : []).join('\n'));
    time = new Date(time.getTime() + 120_001);
  };
  return { coordinator, store, artifacts, ledger, client, run, results, files, finish, advance: () => { time = new Date(time.getTime() + 120_001); }, currentBatch: () => batch };
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
    await expect(rejected.create('file', 'id')).rejects.toMatchObject({ uncertain: false });
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
