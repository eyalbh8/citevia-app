import { describe, expect, it, vi } from 'vitest';
import { answerBody, extractionBody, OpenAIProvider, ProviderError, responseFailure, responseText } from '../src/provider.js';

const answer = { prompt: 'Which analytics products should I compare?', model: 'answer-snapshot', language: 'en', country: 'US', timezone: 'America/New_York' };

describe('OpenAI REST contract', () => {
  it('restricts domain-specific blog searches without narrowing ordinary scan searches', () => {
    const restricted = answerBody({...answer,allowedDomains:['northstar.example','northstar.co.uk']});
    expect(restricted.tools).toEqual([expect.objectContaining({type:'web_search',filters:{allowed_domains:['northstar.example','northstar.co.uk']}})]);
    expect(restricted.tool_choice).toBe('required');
    expect(answerBody(answer).tools).toEqual([expect.not.objectContaining({filters:expect.anything()})]);
  });
  it('serializes Astra reasoning for search and structured content without altering neutral requests',()=>{
    const input={model:'gpt-6-astra',instructions:'Write a useful caption.',input:{question:'A question'},schema:{type:'object'},reasoningEffort:'low' as const};
    expect(answerBody({...answer,model:'gpt-6-astra',reasoningEffort:'low'}).reasoning).toEqual({effort:'low'});
    expect(extractionBody(input).reasoning).toEqual({effort:'low'});
    expect(answerBody(answer)).not.toHaveProperty('reasoning');
    const {reasoningEffort,...legacy}=input;
    expect(extractionBody({...legacy,model:'gpt-4.1-2025-04-14'})).not.toHaveProperty('reasoning');
  });
  it('keeps the content timeout local and within the worker lease', async () => {
    const fetcher=vi.fn(async()=>Response.json({status:'completed',output:[]}));
    const provider=new OpenAIProvider({apiKey:'test-only',fetch:fetcher});
    const request={model:'gpt-6-astra',instructions:'Write.',input:{},schema:{type:'object'},requestTimeoutMs:180000};
    await provider.extract(request);
    const options=(fetcher.mock.calls[0] as unknown as [string,RequestInit])[1];
    expect(JSON.parse(options.body as string)).not.toHaveProperty('requestTimeoutMs');
    expect(()=>provider.extract({...request,requestTimeoutMs:180001})).toThrow('at most 180 seconds');
  });
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
    await expect(provider.answer(answer)).rejects.toMatchObject({ code: 'openai_timeout', retryable: false, kind: 'uncertain', safeToRetry: false });
  });
  it('keeps refusal, incomplete and missing search out of metrics', () => {
    expect(responseFailure({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })?.code).toBe('response_refused');
    expect(responseFailure({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })?.code).toBe('response_incomplete');
    expect(responseFailure({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }] }, true)?.code).toBe('search_not_performed');
  });
});
