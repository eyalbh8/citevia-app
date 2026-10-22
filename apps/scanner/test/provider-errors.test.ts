import { describe, expect, it, vi } from 'vitest';
import { classifyProviderHttpError, providerRetryAfterMs } from '../src/provider-errors.js';
import { OpenAIProvider, ProviderError } from '../src/provider.js';
import { providerPost } from '../src/provider-http.js';

const now = new Date('2026-10-22T20:00:00.000Z');
const request = { model: 'analysis-model', instructions: 'Analyze.', input: {}, schema: {} };
const transports = [
  {
    name: 'OpenAI Responses', provider: 'openai',
    call: (fetcher: typeof fetch) => new OpenAIProvider({ apiKey: 'private-api-key', fetch: fetcher, now: () => now }).extract(request),
  },
  {
    name: 'shared provider HTTP', provider: 'perplexity',
    call: (fetcher: typeof fetch) => providerPost('perplexity', 'https://provider.example/generate', { model: request.model }, {
      apiKey: 'private-api-key', fetch: fetcher, now: () => now,
    }),
  },
];

describe.each(transports)('$name rejection handling', ({ provider, call }) => {
  it('distinguishes rate throttling and keeps the server minimum delay', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'rate_limit_exceeded', type: 'tokens', message: 'PRIVATE PROMPT' } }, {
      status: 429, headers: { 'x-request-id': 'rejection-1', 'retry-after': '90', 'x-ratelimit-reset-tokens': '2m1s', 'x-ratelimit-remaining-tokens': '0' },
    }));
    let failure: unknown;
    try { await call(fetcher); } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      code: `${provider}_http_429`, retryable: true, safeToRetry: true,
      kind: 'rate_limit', retryAfterMs: 121_000, provider, model: request.model,
      httpStatus: 429, providerCode: 'rate_limit_exceeded', providerType: 'tokens', requestId: 'rejection-1',
    });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE PROMPT|private-api-key/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'usage_limit_reached', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'])('never retries %s', async code => {
    const fetcher = vi.fn(async () => Response.json({ error: { code, message: 'account private details' } }, { status: 429, headers: { 'retry-after': '5' } }));
    await expect(call(fetcher)).rejects.toMatchObject({
      kind: 'quota', retryable: false, safeToRetry: false, providerCode: code,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('recognizes a quota error supplied as the allowlisted error type', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { type: 'insufficient_quota', code: null } }, { status: 429 }));
    await expect(call(fetcher)).rejects.toMatchObject({ kind: 'quota', retryable: false, providerType: 'insufficient_quota' });
  });

  it.each([400, 401, 403, 404])('does not retry permanent HTTP %i', async status => {
    const fetcher = vi.fn(async () => Response.json({ error: { type: 'invalid_request_error' } }, { status }));
    await expect(call(fetcher)).rejects.toMatchObject({ kind: 'permanent', retryable: false, safeToRetry: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('allows a definite service rejection to be retried by the worker, without a hidden retry', async () => {
    const fetcher = vi.fn(async () => new Response('<html>private proxy details</html>', { status: 503, headers: { 'retry-after': '7' } }));
    await expect(call(fetcher)).rejects.toMatchObject({ kind: 'transient', retryable: true, safeToRetry: true, retryAfterMs: 7000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('drops unknown codes/types rather than copying arbitrary provider content', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'PRIVATE PROMPT', type: 'Bearer private-api-key', message: 'PRIVATE MESSAGE' } }, { status: 429 }));
    let failure: unknown;
    try { await call(fetcher); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind: 'rate_limit', providerCode: undefined, providerType: undefined });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|private-api-key/);
  });

  it.each(['not-json', '[]', 'null'])('does not replay a paid response with a malformed envelope: %s', async content => {
    const fetcher = vi.fn(async () => new Response(content, { status: 200 }));
    await expect(call(fetcher)).rejects.toMatchObject({ kind: 'uncertain', retryable: false, safeToRetry: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not replay a request whose outcome was lost on the network', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network failed with secret private-api-key'); });
    await expect(call(fetcher)).rejects.toMatchObject({ kind: 'uncertain', retryable: false, safeToRetry: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('provider minimum retry delay', () => {
  it('reads delta seconds, fractional seconds, and HTTP dates', () => {
    expect(providerRetryAfterMs(new Headers({ 'retry-after': '3' }), now.getTime())).toBe(3000);
    expect(providerRetryAfterMs(new Headers({ 'retry-after': '0.25' }), now.getTime())).toBe(250);
    expect(providerRetryAfterMs(new Headers({ 'retry-after': 'Thu, 22 Oct 2026 20:02:00 GMT' }), now.getTime())).toBe(120_000);
    expect(providerRetryAfterMs(new Headers({ 'retry-after': 'Thu, 22 Oct 2026 19:00:00 GMT' }), now.getTime())).toBe(0);
  });

  it('uses the longest exhausted reset and ignores a non-exhausted dimension', () => {
    expect(providerRetryAfterMs(new Headers({
      'retry-after': '1', 'x-ratelimit-reset-requests': '1h2m3.5s', 'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-tokens': '2h', 'x-ratelimit-remaining-tokens': '500',
    }))).toBe(3_723_500);
    expect(providerRetryAfterMs(new Headers({ 'x-ratelimit-reset-requests': '250ms' }))).toBe(250);
    expect(providerRetryAfterMs(new Headers({ 'x-ratelimit-reset-project-tokens': '3m', 'x-ratelimit-remaining-project-tokens': '0' }))).toBe(180_000);
  });

  it.each(['-1', 'Infinity', 'invalid', '1e20', '99999999999999999999999999'])('ignores invalid retry delay %s', value => {
    expect(providerRetryAfterMs(new Headers({ 'retry-after': value }), now.getTime())).toBeUndefined();
  });

  it('ignores malformed reset headers', () => {
    expect(providerRetryAfterMs(new Headers({ 'x-ratelimit-reset-tokens': '120 seconds', 'x-ratelimit-reset-requests': '1m evil' }))).toBeUndefined();
  });

  it('limits rejected response body reads without losing the HTTP rejection', async () => {
    const result = await classifyProviderHttpError(new Response(JSON.stringify({ error: { message: 'x'.repeat(20_000), code: 'rate_limit_exceeded' } }), { status: 429 }), { provider: 'openai' });
    expect(result).toMatchObject({ kind: 'rate_limit', safeToRetry: true });
    expect(result.providerCode).toBeUndefined();
    expect(result.providerType).toBeUndefined();
  });
});
