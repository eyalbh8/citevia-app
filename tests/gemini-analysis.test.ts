import { describe, expect, it, vi } from 'vitest';
import { GeminiAnalysisProvider, geminiAnalysisBody } from '../apps/scanner/src/gemini-analysis.js';
import { analysisRequest } from '../apps/scanner/src/analysis-request.js';
import { parseExtraction } from '../apps/scanner/src/extraction.js';
import { usage } from '../apps/scanner/src/normalize.js';
import { OpenAIAnswerProvider } from '../apps/scanner/src/openai.js';
import { responseFailure, responseText, type NativeResponse, type ProviderReceipt } from '../apps/scanner/src/provider.js';
import { parseScoredExtraction, SCORED_PARSER_VERSION } from '../apps/scanner/src/scoring-extraction.js';
import { captured, instant, snapshot, target } from '../apps/scanner/test/fixtures.js';

const saved = { ...snapshot, competitors: [], extractionModel: 'gemini-3.8-flash', parserVersion: SCORED_PARSER_VERSION };
const answer = captured('Acme is useful.');
const scored = {
  companies: [{ name: 'Acme', evidenceId: 0, sentiment: 'positive', sentimentEvidenceId: 0 }],
  brands: { [target.id]: { mentioned: true, sentiment: 'positive', evidenceIds: [0], sentimentEvidenceId: 0, explicitRank: null, rankEvidenceId: null } },
};
function native(text = JSON.stringify(scored)): NativeResponse {
  return {
    responseId: 'gemini-response', modelVersion: 'gemini-3.8-flash-001',
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 20, cachedContentTokenCount: 40, totalTokenCount: 150 },
  };
}
function receipt(response = native()): ProviderReceipt {
  return { response, requestId: 'gemini-request', receivedAt: instant };
}

describe('Gemini analysis transport', () => {
  it('sends JSON schema analysis without search or local metadata and retains the native receipt', async () => {
    const response = native();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { headers: { 'x-goog-request-id': 'gemini-request' } }));
    const provider = new GeminiAnalysisProvider({ apiKey: 'gemini-key', fetch: fetcher, now: () => new Date(instant) });
    const request = { ...analysisRequest(answer, saved), requestTimeoutMs: 50_000 };
    const result = await provider.extract(request);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'x-goog-api-key': 'gemini-key' });
    const body = JSON.parse(String(options?.body));
    const properties = request.schema.properties as Record<string, Record<string, unknown>>;
    const { maxItems: _maxItems, ...companies } = properties.companies;
    const expectedSchema = { ...request.schema, properties: { ...properties, companies } };
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: request.instructions }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(request.input) }] }],
      generationConfig: { candidateCount: 1, maxOutputTokens: 12000, responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: expectedSchema } } },
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('costContext');
    expect(body).not.toHaveProperty('requestTimeoutMs');
    expect(result).toEqual(receipt(response));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(geminiAnalysisBody({ ...request, maxOutputTokens: 456 })).toHaveProperty('generationConfig.maxOutputTokens', 456);
  });

  it('adapts only the costly company-array bound while preserving the canonical validation schema', () => {
    const request = analysisRequest(answer, saved);
    const original = structuredClone(request.schema);
    const body = JSON.parse(JSON.stringify(geminiAnalysisBody(request)));
    const schema = body.generationConfig.responseFormat.text.schema;
    expect(schema.properties.companies).not.toHaveProperty('maxItems');
    expect(schema.properties.companies.items.properties.evidenceId).toEqual({ $ref: '#/$defs/evidenceId' });
    expect(schema.$defs.evidenceId).toEqual({ type: 'integer', minimum: 0, maximum: 0 });
    expect(schema.properties.brands.properties[target.id].properties.evidenceIds.maxItems).toBe(3);
    expect(schema.properties.brands.properties[target.id].properties.sentimentEvidenceId).toEqual({ anyOf: [{ $ref: '#/$defs/evidenceId' }, { type: 'null' }] });
    expect(request.schema).toEqual(original);
    expect(request.schema).toHaveProperty('properties.companies.maxItems', 100);
    const tooManyCompanies = Array.from({ length: 101 }, () => scored.companies[0]);
    expect(() => parseScoredExtraction(receipt(native(JSON.stringify({ ...scored, companies: tooManyCompanies }))), answer, saved)).toThrow('evidence reference schema');
  });

  it('uses the existing visible rate-limit classification without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '12', 'x-goog-request-id': 'rejected' } }));
    const provider = new GeminiAnalysisProvider({ apiKey: 'key', fetch: fetcher });
    await expect(provider.extract(analysisRequest(answer, saved))).rejects.toMatchObject({
      code: 'gemini_http_429', provider: 'gemini', model: saved.extractionModel,
      kind: 'rate_limit', safeToRetry: true, retryable: true, retryAfterMs: 12000, requestId: 'rejected',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains an uncertain invalid HTTP JSON failure without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{', { headers: { 'x-goog-request-id': 'invalid' } }));
    const provider = new GeminiAnalysisProvider({ apiKey: 'key', fetch: fetcher });
    await expect(provider.extract(analysisRequest(answer, saved))).rejects.toMatchObject({
      code: 'gemini_invalid_json', provider: 'gemini', model: saved.extractionModel,
      kind: 'uncertain', safeToRetry: false, retryable: false, requestId: 'invalid',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('native Gemini analysis receipts', () => {
  it('parses the same evidence scores, actual model, and complete usage without altering native data', () => {
    const response = native();
    const text = JSON.stringify(scored);
    response.candidates = [{ content: { parts: [
      { text: 'Private reasoning is not model output.', thought: true },
      { text: text.slice(0, 13) }, { text: text.slice(13) },
    ] }, finishReason: 'STOP' }];
    const original = structuredClone(response);
    const savedReceipt = receipt(response);
    const result = parseScoredExtraction(savedReceipt, answer, saved);
    expect(responseText(response)).toBe(text);
    expect(result.brands[0]).toMatchObject({ brandId: target.id, mentioned: true, appearanceRank: 1, sentimentScore: 100 });
    expect(result.model).toBe('gemini-3.8-flash-001');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 40, reasoningTokens: 20 });
    expect(result.raw).toBe(savedReceipt);
    expect(response).toEqual(original);
  });

  it('keeps legacy exact-span analyses readable with native Gemini receipts', () => {
    const span = { blockId: answer.blocks[0].id, quote: answer.text, start: 0, end: answer.text.length };
    const result = parseExtraction(receipt(native(JSON.stringify({ brands: [{
      brandId: target.id, mentioned: true, explicitRank: null, sentiment: 'positive', evidence: [span], rankEvidence: null, sentimentEvidence: span,
    }] }))), answer, { ...saved, parserVersion: 'legacy' });
    expect(result.model).toBe('gemini-3.8-flash-001');
    expect(result.brands[0].evidence).toEqual([span]);
    expect(result.usage.reasoningTokens).toBe(20);
  });

  it.each([
    ['prompt block', { promptFeedback: { blockReason: 'SAFETY' } }, 'response_refused'],
    ['candidate block', { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }, 'response_refused'],
    ['truncated output', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }, 'response_incomplete'],
    ['missing candidate', { candidates: [] }, 'response_incomplete'],
    ['thought-only output', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}', thought: true }] } }] }, 'response_empty'],
  ] as const)('rejects %s as a completed analysis', (_name, response, code) => {
    expect(responseFailure(response)).toMatchObject({ code, retryable: false, safeToRetry: false });
  });

  it.each([
    ['blocked', { promptFeedback: { blockReason: 'SAFETY' } }, 'response_refused'],
    ['truncated', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(scored) }] } }] }, 'response_incomplete'],
    ['malformed', native('{'), 'invalid_extraction'],
    ['schema invalid', native('{}'), 'invalid_extraction'],
  ] as const)('preserves %s evidence and performs no hidden replacement call', async (_name, response, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    const transport = new GeminiAnalysisProvider({ apiKey: 'key', fetch: fetcher });
    const provider = new OpenAIAnswerProvider({ answer: vi.fn(), extract: request => transport.extract(request) });
    await expect(provider.extract(answer, { ...saved, execution: { runId: 'run', promptId: 'prompt', attempt: 1 }, extractionFallbackModel: 'gemini-fallback' })).rejects.toMatchObject({
      code, retryable: false, receipt: { response },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('ignores invalid native token counts without losing valid partial usage', () => {
    expect(usage({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: -1, thoughtsTokenCount: Number.NaN, cachedContentTokenCount: '10' } })).toEqual({
      inputTokens: 12, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0,
    });
  });
});
