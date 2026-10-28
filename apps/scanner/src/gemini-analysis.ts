import { object, ProviderError, type ExtractionRequest, type ProviderReceipt } from './provider.js';
import { providerPost, type HttpOptions } from './provider-http.js';

function geminiAnalysisSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = object(schema.properties);
  const companies = object(properties?.companies);
  if (companies?.type !== 'array' || typeof companies.maxItems !== 'number') return schema;
  // Gemini rejects the full scored schema with this company-object array upper
  // bound (100). Keep the provider schema compatible with the live endpoint.
  // The parser still enforces the company limit. Preserve all other constraints,
  // including exact evidence-ID bounds, nullable references and evidence limits.
  const { maxItems: _maxItems, ...companySchema } = companies;
  return { ...schema, properties: { ...properties, companies: companySchema } };
}

/** Analyze captured text only. Search tools and local execution metadata never enter this body. */
export function geminiAnalysisBody(input: ExtractionRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: input.instructions }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input.input) }] }],
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: input.maxOutputTokens ?? 12000,
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: geminiAnalysisSchema(input.schema) } },
    },
  };
}

export class GeminiAnalysisProvider {
  constructor(private readonly options: HttpOptions) {
    if (!options.apiKey.trim()) throw new Error('Gemini API key is missing.');
    if (options.timeoutMs !== undefined) validateTimeout(options.timeoutMs);
  }

  async extract(input: ExtractionRequest): Promise<ProviderReceipt> {
    if (input.requestTimeoutMs !== undefined) validateTimeout(input.requestTimeoutMs);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
    try {
      // One paid request only. Durable scanner attempts own every retry.
      return await providerPost('gemini', url, geminiAnalysisBody(input), {
        ...this.options,
        timeoutMs: this.options.timeoutMs ?? input.requestTimeoutMs ?? 110_000,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        // Unlike OpenAI, Gemini identifies its model in the URL rather than the body.
        throw new ProviderError(error.code, error.message, error.retryable, error.requestId, {
          ...error, provider: 'gemini', model: input.model,
        });
      }
      throw error;
    }
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000)
    throw new Error('Content request timeout must be positive and at most 180 seconds.');
}
