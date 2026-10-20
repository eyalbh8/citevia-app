import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { SCAN_PROVIDERS, type ScanProvider } from '@citevia/core';
import { object, ProviderError, type ProviderReceipt } from './provider.js';

export interface HttpOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}
export async function providerPost(
  provider: ScanProvider,
  url: string,
  body: unknown,
  options: HttpOptions,
): Promise<ProviderReceipt> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 110_000,
  );
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider === 'gemini'
          ? { 'x-goog-api-key': options.apiKey }
          : { Authorization: `Bearer ${options.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const requestId =
      response.headers.get('x-request-id') ||
      response.headers.get('x-goog-request-id');
    if (!response.ok)
      throw new ProviderError(
        `${provider}_http_${response.status}`,
        `${provider} request failed (${response.status}).`,
        [408, 409, 429].includes(response.status) || response.status >= 500,
        requestId,
      );
    let native: unknown;
    try {
      native = await response.json();
    } catch {
      throw new ProviderError(
        `${provider}_invalid_json`,
        `${provider} returned invalid JSON.`,
        true,
        requestId,
      );
    }
    const data = object(native);
    if (!data)
      throw new ProviderError(
        `${provider}_invalid_response`,
        `${provider} returned an invalid response envelope.`,
        true,
        requestId,
      );
    return {
      response: data,
      requestId,
      receivedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${provider}_${controller.signal.aborted ? 'timeout' : 'network'}`,
      `${provider} request ${controller.signal.aborted ? 'timed out' : 'could not be completed'}.`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}
export function providerAvailability(): Record<ScanProvider, boolean> {
  return Object.fromEntries(
    SCAN_PROVIDERS.map((provider) => {
      const prefix = provider.toUpperCase();
      return [
        provider,
        !!(
          process.env[`${prefix}_API_KEY`]?.trim() ||
          process.env[`${prefix}_SECRET_ARN`]?.trim()
        ),
      ];
    }),
  ) as Record<ScanProvider, boolean>;
}
export async function providerApiKey(provider: ScanProvider): Promise<string> {
  const prefix = provider.toUpperCase(),
    field = `${prefix}_API_KEY`;
  let key = process.env[field]?.trim();
  const arn = process.env[`${prefix}_SECRET_ARN`];
  if (!key && arn) {
    const value = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (value.SecretString) {
      try {
        const parsed = object(JSON.parse(value.SecretString));
        key =
          typeof parsed?.[field] === 'string'
            ? String(parsed[field]).trim()
            : undefined;
      } catch {
        key = value.SecretString.trim();
      }
    }
  }
  if (!key)
    throw new ProviderError(
      `${provider}_not_configured`,
      `Configure ${field} or ${prefix}_SECRET_ARN.`,
      false,
    );
  return key;
}
