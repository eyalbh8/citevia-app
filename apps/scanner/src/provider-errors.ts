import type { ProviderErrorOptions } from './provider.js';

// Keep only documented machine identifiers. Error messages can contain a prompt,
// an API key, or account information and must never enter scan state or logs.
const QUOTA_CODES = new Set([
  'insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached',
  'billing_limit_reached', 'billing_not_active', 'billing_error',
  'usage_limit_reached', 'monthly_budget_exceeded', 'credits_exhausted',
  'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);
const SAFE_CODES = new Set([
  ...QUOTA_CODES, 'rate_limit_exceeded', 'rate_limit_error', 'slow_down',
  'server_error', 'internal_error', 'internal_server_error', 'overloaded_error',
  'temporarily_unavailable', 'service_unavailable', 'server_is_overloaded', 'timeout',
  'invalid_api_key', 'authentication_error', 'permission_denied',
  'permission_error', 'invalid_request_error', 'invalid_request',
  'model_not_found', 'not_found_error', 'requests', 'tokens',
]);
const MAX_ERROR_BYTES = 16_384;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODES.has(value) ? value : undefined;
}

async function rejectionCodes(response: Response): Promise<{providerCode?: string; providerType?: string}> {
  // A bounded read also handles HTML/proxy errors without retaining their body.
  const reader = response.body?.getReader();
  if (!reader) return {};
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return {};
      chunks.push(item.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const error = record(record(JSON.parse(new TextDecoder().decode(body)))?.error);
    return { providerCode: safeCode(error?.code), providerType: safeCode(error?.type) };
  } catch {
    // We still received a definite HTTP rejection even if its body is unreadable.
    return {};
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** OpenAI reset durations use values such as `1m30s` or `250ms`. */
function durationMs(value: string | null): number | undefined {
  if (!value || value.length > 128 || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) return undefined;
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const item of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(item[1]) * units[item[2] as keyof typeof units];
  }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? Math.ceil(total) : undefined;
}

/** Returns a minimum delay, never an earlier/clipped retry than the server asks for. */
export function providerRetryAfterMs(headers: Headers, nowMs = Date.now()): number | undefined {
  const delays: number[] = [];
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter && retryAfter.length <= 128) {
    const delay = /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(retryAfter)
        ? Math.max(0, Date.parse(retryAfter) - nowMs) : NaN;
    if (Number.isFinite(delay) && delay <= Number.MAX_SAFE_INTEGER) delays.push(Math.ceil(delay));
  }
  for (const dimension of ['requests', 'tokens', 'project-tokens']) {
    const remaining = headers.get(`x-ratelimit-remaining-${dimension}`);
    // A non-exhausted dimension must not defer an unrelated quota. When the
    // remaining header is absent, conservatively respect the supplied reset.
    if (remaining !== null && Number.isFinite(Number(remaining)) && Number(remaining) > 0) continue;
    const delay = durationMs(headers.get(`x-ratelimit-reset-${dimension}`));
    if (delay !== undefined) delays.push(delay);
  }
  return delays.length ? Math.max(...delays) : undefined;
}

export interface ProviderHttpFailure extends ProviderErrorOptions { retryable: boolean }

export function providerFailureMessage(provider: string, status: number, kind: ProviderErrorOptions['kind']): string {
  const label = provider === 'openai' ? 'OpenAI' : provider;
  if (kind === 'quota') return `${label} usage is paused: credits, billing, or quota requires attention.`;
  if (kind === 'rate_limit') return `${label} is temporarily rate-limited. Requests must wait for provider capacity.`;
  return `${label} request failed (${status}).`;
}

/** Classifies a received rejection; never retries or starts another paid call. */
export async function classifyProviderHttpError(
  response: Response,
  context: { provider: string; model?: string; nowMs?: number },
): Promise<ProviderHttpFailure> {
  const codes = await rejectionCodes(response);
  const common = {
    ...codes, provider: context.provider, model: context.model,
    httpStatus: response.status,
    retryAfterMs: providerRetryAfterMs(response.headers, context.nowMs),
  };
  if ([codes.providerCode, codes.providerType].some(code => code !== undefined && QUOTA_CODES.has(code))) {
    return { ...common, kind: 'quota', retryable: false, safeToRetry: false };
  }
  // Authentication/authorization errors always need configuration changes, even
  // when a provider happens to attach a rate-limit code or reset header.
  if (response.status === 401 || response.status === 403) {
    return { ...common, kind: 'permanent', retryable: false, safeToRetry: false };
  }
  if (response.status === 429) {
    return { ...common, kind: 'rate_limit', retryable: true, safeToRetry: true };
  }
  if (response.status === 408 || response.status === 409 || response.status >= 500) {
    return { ...common, kind: 'transient', retryable: true, safeToRetry: true };
  }
  return { ...common, kind: 'permanent', retryable: false, safeToRetry: false };
}
