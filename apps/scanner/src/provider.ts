/** The native API response is deliberately retained, including fields we do not interpret. */
export interface NativeResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: unknown[];
  usage?: unknown;
  incomplete_details?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface ProviderReceipt {
  response: NativeResponse;
  requestId: string | null;
  receivedAt: string;
}

export interface AnswerRequest {
  prompt: string;
  instructions?: string;
  model: string;
  language: string;
  country: string;
  timezone: string;
  maxOutputTokens?: number;
}

export interface ExtractionRequest {
  schemaName?: string;
  maxOutputTokens?: number;
  model: string;
  instructions: string;
  input: unknown;
  schema: Record<string, unknown>;
}

export interface ResponseProvider {
  answer(input: AnswerRequest): Promise<ProviderReceipt>;
  extract(input: ExtractionRequest): Promise<ProviderReceipt>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function answerBody(input: AnswerRequest): Record<string, unknown> {
  return {
    model: input.model,
    store: false,
    // Scan observations use the neutral default. Company research has its own developer instructions.
    instructions: input.instructions ?? `Answer the user's question in ${input.language}.`,
    input: input.prompt,
    tools: [{
      type: 'web_search',
      search_context_size: 'medium',
      user_location: { type: 'approximate', country: input.country, timezone: input.timezone },
    }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    max_output_tokens: input.maxOutputTokens ?? 8000,
  };
}

export function extractionBody(input: ExtractionRequest): Record<string, unknown> {
  return {
    model: input.model,
    store: false,
    instructions: input.instructions,
    input: JSON.stringify(input.input),
    // No web tools: analysis is constrained to the captured answer.
    text: { format: { type: 'json_schema', name: input.schemaName ?? 'brand_observations', strict: true, schema: input.schema } },
    max_output_tokens: input.maxOutputTokens ?? 12000,
  };
}

export class OpenAIProvider implements ResponseProvider {
  constructor(private readonly options: {
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    answerTimeoutMs?: number;
    extractionTimeoutMs?: number;
    now?: () => Date;
  }) {
    if (!options.apiKey) throw new Error('OpenAI API key is missing.');
    const answerTimeout = options.timeoutMs ?? options.answerTimeoutMs ?? 180_000;
    const extractionTimeout = options.timeoutMs ?? options.extractionTimeoutMs ?? 60_000;
    if (answerTimeout <= 0 || extractionTimeout <= 0 || answerTimeout + extractionTimeout > 240_000) throw new Error('Provider timeouts must be positive and total at most 240 seconds.');
  }

  answer(input: AnswerRequest): Promise<ProviderReceipt> { return this.request(answerBody(input), this.options.timeoutMs ?? this.options.answerTimeoutMs ?? 180_000); }
  extract(input: ExtractionRequest): Promise<ProviderReceipt> { return this.request(extractionBody(input), this.options.timeoutMs ?? this.options.extractionTimeoutMs ?? 60_000); }

  private async request(body: Record<string, unknown>, timeoutMs: number): Promise<ProviderReceipt> {
    // One request only. SQS owns retries so they are visible, bounded and checkpoint aware.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const requestId = response.headers.get('x-request-id');
      if (!response.ok) {
        // Never log API error bodies: they may echo customer prompts or authentication data.
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw new ProviderError(`openai_http_${response.status}`, `OpenAI request failed (${response.status}).`, retryable, requestId);
      }
      let data: unknown;
      try { data = await response.json(); } catch {
        throw new ProviderError('openai_invalid_json', 'OpenAI returned invalid JSON.', true, requestId);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ProviderError('openai_invalid_response', 'OpenAI returned an invalid response envelope.', true, requestId);
      }
      return {
        response: data as NativeResponse,
        requestId,
        receivedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(controller.signal.aborted ? 'openai_timeout' : 'openai_network',
        controller.signal.aborted ? 'OpenAI request timed out.' : 'OpenAI could not be reached.', true);
    } finally { clearTimeout(timeout); }
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function responseText(response: NativeResponse): string {
  return (response.output ?? []).flatMap(item => {
    const value = object(item);
    return value?.type === 'message' && Array.isArray(value.content)
      ? value.content.flatMap(content => {
        const block = object(content);
        return block?.type === 'output_text' && typeof block.text === 'string' ? [block.text] : [];
      }) : [];
  }).join('\n');
}

export function responseFailure(response: NativeResponse, requireSearch = false): ProviderError | undefined {
  const output = response.output ?? [];
  const refusal = output.some(item => {
    const value = object(item);
    return Array.isArray(value?.content) && value.content.some(content => object(content)?.type === 'refusal');
  });
  if (refusal) return new ProviderError('response_refused', 'The model refused this response.', false);
  if (response.status !== 'completed') return new ProviderError('response_incomplete', 'The model did not complete its response.', false);
  if (!responseText(response).trim()) return new ProviderError('response_empty', 'The model returned no answer text.', false);
  if (requireSearch && !output.some(item => {
    const value = object(item);
    return value?.type === 'web_search_call' && value.status === 'completed';
  })) return new ProviderError('search_not_performed', 'The answer did not complete the required web search.', false);
  return undefined;
}
