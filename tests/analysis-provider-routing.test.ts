import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisProvider, DEFAULT_ANALYSIS_MODEL } from '@citevia/core';
import { MemoryArtifacts, MemoryCallLedger, MemoryQueue, MemoryRepository, MemoryScanDispatchStore, type ProviderAdmissionStore } from '@citevia/storage';
import { createScanProviderFromEnv } from '../apps/scanner/src/providers.js';
import { guardScanProvider } from '../apps/scanner/src/provider-admission.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { analysis, captured, instant, project, snapshot } from '../apps/scanner/test/fixtures.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const config = { ...snapshot, projectId: project.id, competitors: [], parserVersion: 'igeo-evidence-v2', extractionModel: DEFAULT_ANALYSIS_MODEL };
const content = {
  companies: [{ name: 'Acme', evidenceId: 0, sentiment: 'positive', sentimentEvidenceId: 0 }],
  brands: { [project.brand.id]: { mentioned: true, sentiment: 'positive', evidenceIds: [0], sentimentEvidenceId: 0, explicitRank: null, rankEvidenceId: null } },
};
function geminiResponse(text = JSON.stringify(content)) {
  return {
    modelVersion: DEFAULT_ANALYSIS_MODEL,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 150 },
  };
}

describe('analysis provider routing', () => {
  it('derives Gemini routing from the frozen model and preserves legacy OpenAI models', () => {
    expect(analysisProvider(DEFAULT_ANALYSIS_MODEL)).toBe('gemini');
    expect(analysisProvider('gemini-custom')).toBe('gemini');
    expect(analysisProvider('gpt-6-luna')).toBe('openai');
    expect(analysisProvider('extract-snapshot')).toBe('openai');
  });

  it('analyzes answers from all three collectors through Gemini with native cost attribution', async () => {
    vi.stubEnv('APP_MODE', 'local');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-only');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_SECRET_ARN', '');
    const fetcher = vi.fn(async () => Response.json(geminiResponse()));
    vi.stubGlobal('fetch', fetcher);
    const ledger = new MemoryCallLedger(), provider = createScanProviderFromEnv(undefined, ledger);
    for (const name of ['openai', 'gemini', 'perplexity'] as const) {
      const result = await provider.extract({ ...captured('Acme is useful.'), provider: name }, { ...config, provider: name });
      expect(result.brands[0]).toMatchObject({ mentioned: true, sentiment: 'positive' });
      expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 10 });
      expect(result.raw).toMatchObject({ response: { candidates: expect.any(Array) } });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toContain(`models/${DEFAULT_ANALYSIS_MODEL}:generateContent`);
      const body = JSON.parse(String(init.body));
      expect(body).not.toHaveProperty('tools');
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('gemini-test-only');
    }
    expect(ledger.calls.size).toBe(3);
    for (const call of ledger.calls.values()) {
      expect(call.intent).toMatchObject({ provider: 'gemini', model: DEFAULT_ANALYSIS_MODEL, stage: 'analysis' });
      expect(call.outcome).toMatchObject({ status: 'succeeded', usage: { outputTokens: 50 } });
      expect(call.outcome!.estimatedUsd).toBeGreaterThan(0);
    }
  });

  it('keeps a saved OpenAI analysis model on the OpenAI endpoint', async () => {
    vi.stubEnv('APP_MODE', 'local');
    vi.stubEnv('OPENAI_API_KEY', 'openai-test-only');
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'completed', model: 'gpt-6-luna',
      usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }],
    }));
    vi.stubGlobal('fetch', fetcher);
    await createScanProviderFromEnv().extract(captured('Acme is useful.'), { ...config, extractionModel: 'gpt-6-luna' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
  });

  it('never uses a frozen OpenAI fallback after invalid Gemini output', async () => {
    vi.stubEnv('APP_MODE', 'local');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-only');
    const fetcher = vi.fn(async () => Response.json(geminiResponse('{}')));
    vi.stubGlobal('fetch', fetcher);
    await expect(createScanProviderFromEnv().extract(captured('Acme is useful.'), { ...config, extractionFallbackModel: 'gpt-6-luna' }))
      .rejects.toMatchObject({ code: 'invalid_extraction' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('supports an explicitly frozen Gemini fallback only after a returned validation failure', async () => {
    vi.stubEnv('APP_MODE', 'local');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-only');
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(geminiResponse('{}')))
      .mockResolvedValueOnce(Response.json(geminiResponse()));
    vi.stubGlobal('fetch', fetcher);
    const result = await createScanProviderFromEnv().extract(captured('Acme is useful.'), { ...config, extractionFallbackModel: 'gemini-fallback' });
    expect(result.validationWarnings).toContain(`Analyzer fallback from ${DEFAULT_ANALYSIS_MODEL}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain('models/gemini-fallback:generateContent');
  });

  it('uses Gemini admission for analysis and the collection quota dependency', async () => {
    const store: ProviderAdmissionStore = { acquire: vi.fn(async () => ({ admitted: true as const, leaseId: 'lease' })),
      complete: vi.fn(async () => {}), resetQuota: vi.fn(async () => {}) };
    const provider = guardScanProvider({ collect: vi.fn(async () => captured()), extract: vi.fn(async answer => analysis(answer)) }, store);
    await provider.collect('Question?', { ...config, provider: 'perplexity' });
    await provider.extract(captured(), config);
    expect(store.acquire).toHaveBeenNthCalledWith(1, 'perplexity', expect.any(Object), 'gemini');
    expect(store.acquire).toHaveBeenNthCalledWith(2, 'gemini', expect.any(Object), undefined);
    expect(store.complete).toHaveBeenNthCalledWith(2, 'gemini', 'lease', undefined);
  });

  it('runs scheduled Gemini analysis immediately and defers captured work under Gemini capacity', async () => {
    vi.stubEnv('ANALYSIS_BATCH_ENABLED', 'true');
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    const dispatch = new MemoryScanDispatchStore({ now: () => new Date(instant) });
    const deferred = vi.spyOn(dispatch, 'defer'), enqueued = vi.spyOn(dispatch, 'enqueue');
    const extract = vi.fn().mockRejectedValueOnce(new ProviderError('gemini_http_429', 'Rate limited', true, null,
      { kind: 'rate_limit', safeToRetry: true, retryAfterMs: 60_000 }));
    const batch = { process: vi.fn(), complete: vi.fn() };
    const scanner = new Scanner({ repository, artifacts, queue, dispatch, analysisBatch: batch,
      provider: { collect: vi.fn(async () => captured()), extract }, now: () => new Date(instant) });
    await repository.saveProject({ ...structuredClone(project), extractionModel: DEFAULT_ANALYSIS_MODEL, prompts: [project.prompts[0]] }, null);
    await scanner.handle({ kind: 'kickoff', projectId: project.id, scheduledAt: instant });
    const run = (await repository.listRuns(project.id))[0];
    expect(run.snapshot.analysisMode).toBe('realtime');
    const job = queue.messages.find(message => message.kind === 'prompt')!;
    await scanner.handle(job);
    expect(extract).toHaveBeenCalledOnce();
    expect(batch.process).not.toHaveBeenCalled();
    expect(deferred).toHaveBeenCalledWith(expect.any(Object), expect.any(String), 'gemini');
    await scanner.handle({ kind: 'reconcile-run', projectId: project.id, runId: run.id });
    expect(enqueued.mock.calls.at(-1)![0][0].provider).toBe('gemini');
  });
});
