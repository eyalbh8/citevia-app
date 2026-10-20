import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PERPLEXITY_PRESET,
  projectProviders,
  sameMethod,
  snapshotProvider,
  type ScanMessage,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import {
  normalizePerplexity,
  PerplexityCollector,
  perplexityBody,
} from '../src/perplexity.js';
import {
  byteSpan,
  geminiBody,
  GeminiCollector,
  normalizeGemini,
} from '../src/gemini.js';
import { providerAvailability, providerPost } from '../src/provider-http.js';
import { Scanner } from '../src/engine.js';
import { createScanProviderFromEnv } from '../src/providers.js';
import { ProviderError } from '../src/provider.js';
import { analysis, captured, instant, project, snapshot } from './fixtures.js';

const receipt = (response: any) => ({
  response,
  requestId: 'native-request',
  receivedAt: instant,
});
const agent = () =>
  receipt({
    id: 'pplx-response',
    status: 'completed',
    preset: DEFAULT_PERPLEXITY_PRESET,
    model: 'native-model',
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    output: [
      {
        type: 'search_results',
        results: [
          { id: 7, url: 'https://source.example/review', title: 'Review' },
          { id: 2, url: 'https://other.example/retrieved', title: 'Not cited' },
        ],
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Acme is useful.[7] Another claim.[7] Unknown.[1]',
            annotations: [],
          },
        ],
      },
    ],
  });
const gemini = () =>
  receipt({
    responseId: 'gemini-response',
    modelVersion: DEFAULT_GEMINI_MODEL,
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { thought: true, text: 'Private reasoning' },
            { text: '😀 Acmé works.' },
          ],
        },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://source.example/review', title: 'Review' } },
            { web: { uri: 'https://other.example/review', title: 'Other' } },
          ],
          groundingSupports: [
            {
              segment: {
                partIndex: 1,
                startIndex: 5,
                endIndex: 17,
                text: 'Acmé works.',
              },
              groundingChunkIndices: [0, 1],
            },
          ],
          webSearchQueries: ['query one'],
          searchEntryPoint: {
            renderedContent: '<div>Google suggestions</div>',
          },
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 5,
      totalTokenCount: 35,
    },
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('native provider collection', () => {
  it('maps Perplexity source IDs, repeated references and retrieved-only sources without invented citations', () => {
    const raw = agent(),
      answer = normalizePerplexity(raw, 'fallback');
    expect(answer.provider).toBe('perplexity');
    expect(answer.status).toBe('completed');
    expect(answer.citations).toHaveLength(2);
    expect(
      answer.citations.every((c) => c.url === 'https://source.example/review'),
    ).toBe(true);
    expect(answer.sources).toHaveLength(2);
    expect(
      answer.text.slice(answer.citations[0].start!, answer.citations[0].end!),
    ).toBe('[7]');
    expect(answer.raw).toBe(raw);
    expect(answer.model).toContain(DEFAULT_PERPLEXITY_PRESET);
  });
  it('preserves Perplexity preset instructions and supports explicit typed source IDs', () => {
    const body = perplexityBody('Question?', {
      ...snapshot,
      language: 'en-GB',
    });
    expect(body).toMatchObject({ language_preference: 'en', store: false });
    expect(body).not.toHaveProperty('instructions');
    const raw = agent();
    raw.response.output = [
      {
        type: 'search_results',
        results: [
          {
            id: 'web:0',
            url: 'https://native.example/source',
            title: 'Native',
          },
        ],
      },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'A claim.[web:0]', annotations: [] },
        ],
      },
    ];
    raw.response.usage.tool_calls_details = { search_web: { invocation: 1 } };
    const answer = normalizePerplexity(raw, 'fallback');
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0].url).toBe('https://native.example/source');
    expect(answer.usage.searchCalls).toBe(1);
  });
  it('retains native URL annotations and rejects ambiguous source IDs and unsafe source URLs', () => {
    const raw = agent();
    raw.response.output.push({
      type: 'search_results',
      results: [
        { id: 7, url: 'https://different.example/' },
        { id: 8, url: 'javascript:alert(1)' },
      ],
    });
    expect(normalizePerplexity(raw, 'fallback').citations).toHaveLength(0);
    raw.response.output.push({
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Native citation',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://native.example/',
              title: 'Native',
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
    });
    expect(normalizePerplexity(raw, 'fallback').citations).toHaveLength(1);
    expect(normalizePerplexity(raw, 'fallback').sources).toHaveLength(3);
  });
  it('converts Gemini UTF-8 support ranges and preserves native suggestions, model and raw receipt', () => {
    const raw = gemini(),
      answer = normalizeGemini(raw, 'fallback');
    expect(answer.provider).toBe('gemini');
    expect(answer.status).toBe('completed');
    expect(answer.text).toBe('😀 Acmé works.');
    expect(answer.blocks).toHaveLength(1);
    expect(answer.citations).toHaveLength(2);
    expect(answer.sources).toHaveLength(2);
    expect(
      answer.text.slice(answer.citations[0].start!, answer.citations[0].end!),
    ).toBe('Acmé works.');
    expect(answer.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 25,
      totalTokens: 35,
    });
    expect(answer.searchSuggestions).toEqual(['<div>Google suggestions</div>']);
    expect(answer.raw).toBe(raw);
  });
  it('never invents a text range when byte offsets split Unicode or disagree with the quoted support', () => {
    expect(byteSpan('😀 Acmé works.', 1, 4)).toEqual({
      start: null,
      end: null,
    });
    expect(byteSpan('😀 Acmé works.', 5, 17, 'different text')).toEqual({
      start: null,
      end: null,
    });
    expect(byteSpan('short', -1, 9)).toEqual({ start: null, end: null });
    const raw = gemini();
    raw.response.candidates[0].groundingMetadata.groundingSupports[0].segment.text =
      'Wrong';
    expect(normalizeGemini(raw, 'fallback').citations[0]).toMatchObject({
      start: null,
      end: null,
      url: 'https://source.example/review',
    });
  });
  it('records no-search, safety and truncated Gemini results as actually returned', () => {
    const raw = receipt({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'No search used.' }] },
        },
      ],
    });
    expect(normalizeGemini(raw, 'fallback')).toMatchObject({
      status: 'completed',
      citations: [],
      sources: [],
    });
    expect(
      normalizeGemini(
        receipt({ promptFeedback: { blockReason: 'SAFETY' } }),
        'fallback',
      ).status,
    ).toBe('refused');
    expect(
      normalizeGemini(
        receipt({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
        'fallback',
      ).status,
    ).toBe('incomplete');
    expect(
      normalizePerplexity(receipt({ status: 'incomplete' }), 'fallback').status,
    ).toBe('incomplete');
  });
  it('sends neutral prompts to the actual native endpoints with server-side auth', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(agent().response), {
          headers: { 'x-request-id': 'native' },
        }),
    );
    await new PerplexityCollector({
      apiKey: 'private',
      fetch: fetcher,
    }).collect('Question?', {
      ...snapshot,
      provider: 'perplexity',
      generationModel: DEFAULT_PERPLEXITY_PRESET,
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.perplexity.ai/v1/agent');
    const init = fetcher.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer private',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      preset: DEFAULT_PERPLEXITY_PRESET,
      input: 'Question?',
      tools: [{ type: 'web_search', user_location: { country: 'US' } }],
    });
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify(gemini().response)),
    );
    await new GeminiCollector({ apiKey: 'private', fetch: fetcher }).collect(
      'Question?',
      {
        ...snapshot,
        provider: 'gemini',
        generationModel: DEFAULT_GEMINI_MODEL,
      },
    );
    expect(fetcher.mock.calls[1][0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    expect(String(fetcher.mock.calls[1][0])).not.toContain('private');
    expect(
      new Headers(fetcher.mock.calls[1][1]!.headers).get('x-goog-api-key'),
    ).toBe('private');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).tools).toEqual([
      { googleSearch: {} },
    ]);
    expect(JSON.stringify(perplexityBody('Question?', snapshot))).not.toContain(
      project.brand.name,
    );
    expect(JSON.stringify(geminiBody('Question?', snapshot))).not.toContain(
      project.brand.name,
    );
  });
  it.each([
    ['perplexity', 429, true],
    ['gemini', 503, true],
    ['gemini', 401, false],
  ] as const)(
    'classifies %s HTTP %s without exposing a response body',
    async (provider, status, retryable) => {
      await expect(
        providerPost(
          provider,
          'https://example.invalid',
          {},
          {
            apiKey: 'private',
            fetch: async () => new Response('secret customer data', { status }),
          },
        ),
      ).rejects.toMatchObject({
        code: `${provider}_http_${status}`,
        retryable,
      });
    },
  );
  it('rejects malformed responses and classifies network failures', async () => {
    await expect(
      providerPost(
        'gemini',
        'https://example.invalid',
        {},
        { apiKey: 'private', fetch: async () => new Response('[]') },
      ),
    ).rejects.toMatchObject({ code: 'gemini_invalid_response' });
    await expect(
      providerPost(
        'perplexity',
        'https://example.invalid',
        {},
        {
          apiKey: 'private',
          fetch: async () => {
            throw Error('private');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'perplexity_network', retryable: true });
  });
  it('reports configuration availability without loading or exposing keys', () => {
    vi.stubEnv('OPENAI_API_KEY', 'private');
    vi.stubEnv('PERPLEXITY_API_KEY', '');
    vi.stubEnv('PERPLEXITY_SECRET_ARN', 'arn:configured');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GEMINI_SECRET_ARN', '');
    expect(providerAvailability()).toEqual({
      openai: true,
      perplexity: true,
      gemini: false,
    });
  });
  it('routes collection through the configured native provider without cross-provider fallback', async () => {
    for (const name of ['OPENAI', 'PERPLEXITY', 'GEMINI'])
      vi.stubEnv(`${name}_API_KEY`, 'isolated-test');
    const endpoints: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        endpoints.push(url);
        return new Response(
          JSON.stringify(
            url.includes('perplexity')
              ? agent().response
              : url.includes('googleapis')
                ? gemini().response
                : { status: 'completed', output: [] },
          ),
        );
      }),
    );
    const provider = createScanProviderFromEnv();
    for (const name of ['openai', 'perplexity', 'gemini'] as const) {
      const answer = await provider.collect('Question?', {
        ...snapshot,
        provider: name,
      });
      expect(answer.provider).toBe(name);
    }
    expect(endpoints).toHaveLength(3);
    expect(endpoints[0]).toContain('api.openai.com');
    expect(endpoints[1]).toContain('api.perplexity.ai');
    expect(endpoints[2]).toContain('generativelanguage.googleapis.com');
  });
});

describe('provider-isolated weekly workloads', () => {
  const kickoff = {
    kind: 'kickoff' as const,
    projectId: project.id,
    scheduledAt: instant,
  };
  async function setup() {
    const repository = new MemoryRepository(),
      queue = new MemoryQueue(),
      artifacts = new MemoryArtifacts();
    const portfolio = {
      ...structuredClone(project),
      scanProviders: [
        { provider: 'openai' as const, model: 'answer-snapshot' },
        { provider: 'perplexity' as const, model: DEFAULT_PERPLEXITY_PRESET },
        { provider: 'gemini' as const, model: DEFAULT_GEMINI_MODEL },
      ],
    };
    const provider = {
      collect: vi.fn(async (_prompt: string, config: typeof snapshot) => ({
        ...captured(),
        provider: snapshotProvider(config),
      })),
      extract: vi.fn(async (answer: ReturnType<typeof captured>) =>
        analysis(answer),
      ),
    };
    await repository.saveProject(portfolio, null);
    return {
      repository,
      queue,
      artifacts,
      provider,
      scanner: new Scanner({
        repository,
        queue,
        artifacts,
        provider,
        now: () => new Date(instant),
      }),
    };
  }
  it('creates three immutable manifests, keeps result identities distinct and deduplicates paid work', async () => {
    const env = await setup();
    await env.scanner.handle(kickoff);
    await env.scanner.handle(kickoff);
    const runs = await env.repository.listRuns(project.id);
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((run) => snapshotProvider(run.snapshot)))).toEqual(
      new Set(['openai', 'perplexity', 'gemini']),
    );
    expect(runs.every((run) => run.totalCount === project.prompts.length)).toBe(
      true,
    );
    const ids = (
      await Promise.all(
        runs.map((run) => env.repository.listResults(project.id, run.id)),
      )
    )
      .flat()
      .map((result) => result.responseId);
    expect(new Set(ids).size).toBe(6);
    for (const message of env.queue.messages) await env.scanner.handle(message);
    expect(env.provider.collect).toHaveBeenCalledTimes(6);
    expect(env.provider.extract).toHaveBeenCalledTimes(6);
    expect(
      (await env.repository.listRuns(project.id)).every(
        (run) => run.status === 'completed',
      ),
    ).toBe(true);
  });
  it('repairs interrupted fan-out using the frozen portfolio even after provider settings change', async () => {
    const env = await setup(),
      original = env.queue.send.bind(env.queue);
    let fail = true;
    vi.spyOn(env.queue, 'send').mockImplementation(async (jobs) => {
      if (fail) {
        fail = false;
        throw Error('queue unavailable');
      }
      return original(jobs);
    });
    await expect(env.scanner.handle(kickoff)).rejects.toThrow(
      'queue unavailable',
    );
    const saved = (await env.repository.getProject(project.id))!;
    await env.repository.saveProject(
      {
        ...saved,
        version: 2,
        prompts: [],
        scanProviders: [{ provider: 'gemini', model: 'changed' }],
      },
      1,
    );
    await env.scanner.handle(kickoff);
    const runs = await env.repository.listRuns(project.id);
    expect(runs).toHaveLength(3);
    expect(
      runs.every(
        (run) =>
          run.totalCount === 2 && run.snapshot.generationModel !== 'changed',
      ),
    ).toBe(true);
  });
  it('isolates a provider outage and retries only that provider’s failed jobs', async () => {
    const env = await setup();
    let outage = true;
    env.provider.collect.mockImplementation(async (_prompt, config) => {
      if (snapshotProvider(config) === 'perplexity' && outage)
        throw new ProviderError(
          'perplexity_http_401',
          'Perplexity request failed (401).',
          false,
        );
      return { ...captured(), provider: snapshotProvider(config) };
    });
    await env.scanner.handle(kickoff);
    for (const job of [...env.queue.messages]) await env.scanner.handle(job);
    const runs = await env.repository.listRuns(project.id);
    expect(runs.filter((run) => run.status === 'completed')).toHaveLength(2);
    const failed = runs.find(
      (run) => snapshotProvider(run.snapshot) === 'perplexity',
    )!;
    expect(failed.status).toBe('failed');
    expect(failed.succeededCount).toBe(0);
    const priorCalls = env.provider.collect.mock.calls.length;
    outage = false;
    env.queue.messages.length = 0;
    await env.scanner.handle({
      kind: 'retry',
      projectId: project.id,
      runId: failed.id,
      requestId: 'perplexity-retry',
    });
    for (const job of [...env.queue.messages]) await env.scanner.handle(job);
    expect(env.provider.collect.mock.calls.length - priorCalls).toBe(2);
    expect((await env.repository.getRun(project.id, failed.id))!.status).toBe(
      'completed',
    );
  });
  it('keeps legacy accounts and historical runs OpenAI-only until explicitly configured', () => {
    const { scanProviders: _configs, ...legacy } = project;
    expect(projectProviders(legacy)).toEqual([
      { provider: 'openai', model: project.generationModel },
    ]);
    expect(snapshotProvider(snapshot)).toBe('openai');
    expect(sameMethod(snapshot, { ...snapshot, provider: 'gemini' })).toBe(
      false,
    );
    expect(sameMethod(snapshot, { ...snapshot, provider: 'openai' })).toBe(
      true,
    );
  });
});
