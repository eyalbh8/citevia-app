import { describe, expect, it, vi } from 'vitest';
import { answerBody, extractionBody, OpenAIProvider, ProviderError, responseFailure, responseText } from '../src/provider.js';

const answer = { prompt: 'Which analytics products should I compare?', model: 'answer-snapshot', language: 'en', country: 'US', timezone: 'America/New_York' };

describe('OpenAI REST contract', () => {
  it('makes one fresh search answer request with no extraction hints', () => {
    const body = answerBody(answer);
    expect(body.input).toBe(answer.prompt);
    expect(body.tool_choice).toBe('required');
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('text');
    expect(body.store).toBe(false);
  });
  it('uses strict structured output without tools for analysis', () => {
    const body = extractionBody({ model: 'analysis-snapshot', instructions: 'Analyze.', input: { blocks: [] }, schema: { type: 'object' } });
    expect(body).not.toHaveProperty('tools');
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'brand_observations', strict: true, schema: { type: 'object' } } });
  });
  it('preserves native metadata and every output block', async () => {
    const native = { id: 'resp_1', status: 'completed', output: [{ type: 'reasoning', id: 'reason' }, { type: 'message', content: [{ type: 'output_text', text: 'One' }, { type: 'output_text', text: 'Two' }] }], usage: { total_tokens: 150 }, future_field: true };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(native), { headers: { 'x-request-id': 'request-1' } }));
    const provider = new OpenAIProvider({ apiKey: 'test-only', fetch: fetcher, now: () => new Date('2026-10-19T00:00:00Z') });
    const receipt = await provider.answer(answer);
    expect(receipt.response).toEqual(native);
    expect(receipt.requestId).toBe('request-1');
    expect(receipt.receivedAt).toBe('2026-10-19T00:00:00.000Z');
    expect(responseText(receipt.response)).toBe('One\nTwo');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([[429, true], [500, true], [408, true], [401, false], [400, false]])('classifies HTTP %i and makes no hidden retries', async (status, retryable) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"secret":"never echoed"}', { status }));
    const provider = new OpenAIProvider({ apiKey: 'test-only', fetch: fetcher });
    try { await provider.answer(answer); throw new Error('should fail'); } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(retryable);
      expect((error as Error).message).not.toContain('secret');
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('aborts a bounded network request', async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const provider = new OpenAIProvider({ apiKey: 'test-only', fetch: fetcher, timeoutMs: 5 });
    await expect(provider.answer(answer)).rejects.toMatchObject({ code: 'openai_timeout', retryable: true });
  });
  it('keeps refusal, incomplete and missing search out of metrics', () => {
    expect(responseFailure({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })?.code).toBe('response_refused');
    expect(responseFailure({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })?.code).toBe('response_incomplete');
    expect(responseFailure({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }] }, true)?.code).toBe('search_not_performed');
  });
});
