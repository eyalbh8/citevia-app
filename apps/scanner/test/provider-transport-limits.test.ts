import { describe, expect, it, vi } from 'vitest';
import { providerPost } from '../src/provider-http.js';
import { OpenAIProvider } from '../src/provider.js';
import { OpenAIBatchClient } from '../src/openai-batch.js';

describe('bounded provider transports', () => {
  it('stops an untrusted streaming body at the byte limit and refuses redirects', async () => {
    const cancel = vi.fn(); let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(32)); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(providerPost('openai', 'https://api.openai.com/v1/responses', { model: 'gpt-6-astra' },
      { apiKey: 'test', fetch: fetcher, maxResponseBytes: 64 })).rejects.toMatchObject({ code: 'openai_response_too_large', kind: 'uncertain', safeToRetry: false });
    expect(reads).toBeLessThanOrEqual(4); expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('keeps cancellation active while consuming a stalled response', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(providerPost('gemini', 'https://generativelanguage.googleapis.com/test', {},
      { apiKey: 'test', fetch: fetcher, timeoutMs: 10 })).rejects.toMatchObject({ code: 'gemini_timeout', safeToRetry: false });
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds stalled HTTP rejection bodies without losing the known rejection status', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 429 }));
    await expect(providerPost('openai', 'https://api.openai.com/v1/responses', {},
      { apiKey: 'test', fetch: fetcher, timeoutMs: 10 })).rejects.toMatchObject({ kind: 'rate_limit', httpStatus: 429, safeToRetry: true });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds the direct OpenAI transport before consuming an oversized envelope', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': String(5 * 1024 * 1024) } }));
    const provider = new OpenAIProvider({ apiKey: 'test', fetch: fetcher });
    await expect(provider.extract({ model: 'gpt-6-astra', instructions: 'Test', input: {}, schema: {} }))
      .rejects.toMatchObject({ code: 'openai_response_too_large', kind: 'uncertain' });
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('keeps oversized batch submission responses uncertain, while safely bounding batch downloads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream(),
      { headers: { 'Content-Length': String(33 * 1024 * 1024) } }));
    const client = new OpenAIBatchClient({ apiKey: 'test', fetch: fetcher });
    await expect(client.create('file-test', 'batch-test')).rejects.toMatchObject({ uncertain: true, safeToRetry: false });
    await expect(client.download('file-test')).rejects.toMatchObject({ code: 'analysis_batch_file_too_large' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
  });
});
