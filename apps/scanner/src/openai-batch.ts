import { object, ProviderError, type NativeResponse, type ProviderErrorOptions } from './provider.js';
import { classifyProviderHttpError } from './provider-errors.js';

export interface NativeBatch {
  id: string;
  status: 'validating' | 'failed' | 'in_progress' | 'finalizing' | 'completed' | 'expired' | 'cancelling' | 'cancelled';
  input_file_id: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  metadata?: Record<string, string> | null;
  [key: string]: unknown;
}
export interface BatchResultLine {
  custom_id: string;
  response?: { status_code: number; request_id?: string | null; body: NativeResponse } | null;
  error?: { code?: string; message?: string } | null;
}
export interface BatchClient {
  upload(jsonl: string): Promise<string>;
  create(inputFileId: string, correlationId: string): Promise<NativeBatch>;
  retrieve(batchId: string): Promise<NativeBatch>;
  find(correlationId: string, inputFileId: string): Promise<NativeBatch | null>;
  download(fileId: string): Promise<string>;
}
const statuses = new Set(['validating', 'failed', 'in_progress', 'finalizing', 'completed', 'expired', 'cancelling', 'cancelled']);
function nativeBatch(value: unknown): NativeBatch {
  const data = object(value);
  if (!data || typeof data.id !== 'string' || typeof data.input_file_id !== 'string' || !statuses.has(String(data.status)))
    throw new ProviderError('analysis_batch_invalid_response', 'Batch API returned an invalid batch.', false);
  return data as unknown as NativeBatch;
}
/** Transport failures after create are ambiguous: callers must persist intent and reconcile, never retry POST. */
export class BatchSubmissionError extends ProviderError {
  constructor(public readonly uncertain: boolean, code: string, requestId: string | null = null, options: ProviderErrorOptions = {}) {
    super(code, uncertain ? 'Batch submission could not be confirmed. It will be reconciled without resubmission.' : 'Batch submission was rejected.',
      !uncertain && options.safeToRetry === true, requestId,
      uncertain ? { ...options, kind: 'uncertain', safeToRetry: false } : options);
  }
}
export class OpenAIBatchClient implements BatchClient {
  constructor(private readonly options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => Date }) {
    if (!options.apiKey) throw new Error('OpenAI API key is missing.');
  }
  private async request(path: string, init: RequestInit = {}, creating = false): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const response = await (this.options.fetch ?? fetch)(`https://api.openai.com/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) {
        const requestId = response.headers.get('x-request-id');
        const failure = await classifyProviderHttpError(response, { provider: 'openai', nowMs: this.options.now?.().getTime() });
        if (creating)
          throw new BatchSubmissionError(response.status >= 500 || [408, 409].includes(response.status), `analysis_batch_http_${response.status}`, requestId, failure);
        throw new ProviderError(`analysis_batch_http_${response.status}`, 'Batch API request failed.', failure.retryable, requestId, failure);
      }
      // Keep the timeout active while consuming the body, including output-file downloads.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 32 * 1024 * 1024)
        throw new ProviderError('analysis_batch_file_too_large', 'Batch response exceeded the application limit.', false);
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (creating) throw new BatchSubmissionError(true, 'analysis_batch_submission_uncertain');
      // Retrying a read or file upload never purchases inference.
      throw new ProviderError('analysis_batch_network', 'Batch API could not be reached.', true, null, { provider: 'openai', kind: 'transient', safeToRetry: true });
    } finally {
      clearTimeout(timer);
    }
  }
  async upload(jsonl: string): Promise<string> {
    const form = new FormData();
    form.set('purpose', 'batch');
    form.set('file', new Blob([jsonl], { type: 'application/jsonl' }), 'citevia-analysis.jsonl');
    const response = await this.request('/files', { method: 'POST', body: form });
    let file: Record<string, unknown> | undefined;
    try { file = object(await response.json()); } catch { /* Retry file upload only, never inference. */ }
    if (typeof file?.id !== 'string') throw new ProviderError('analysis_batch_invalid_file', 'Batch file upload returned no ID.', true, null, { provider: 'openai', kind: 'transient', safeToRetry: true });
    return file.id;
  }
  async create(inputFileId: string, correlationId: string): Promise<NativeBatch> {
    const response = await this.request('/batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_file_id: inputFileId, endpoint: '/v1/responses', completion_window: '24h', metadata: { citevia_batch: correlationId } }),
    }, true);
    try { return nativeBatch(await response.json()); }
    catch (error) {
      if (error instanceof BatchSubmissionError) throw error;
      throw new BatchSubmissionError(true, 'analysis_batch_submission_uncertain');
    }
  }
  async retrieve(batchId: string): Promise<NativeBatch> {
    const response = await this.request(`/batches/${encodeURIComponent(batchId)}`);
    try { return nativeBatch(await response.json()); }
    catch { throw new ProviderError('analysis_batch_invalid_response', 'Batch API returned an invalid batch.', true, null, { provider: 'openai', kind: 'transient', safeToRetry: true }); }
  }
  async find(correlationId: string, inputFileId: string): Promise<NativeBatch | null> {
    let after: string | undefined;
    // Bounded discovery. A missing match is never permission to create another paid batch.
    for (let page = 0; page < 10; page++) {
      const response = await this.request(`/batches?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      let list: Record<string, unknown> | undefined;
      try { list = object(await response.json()); } catch { /* Bounded coordinator retries a read only. */ }
      if (!list || !Array.isArray(list.data)) throw new ProviderError('analysis_batch_invalid_list', 'Batch API returned an invalid list.', true, null, { provider: 'openai', kind: 'transient', safeToRetry: true });
      const batches = list.data.map(nativeBatch);
      const found = batches.filter((batch) => batch.metadata?.citevia_batch === correlationId && batch.input_file_id === inputFileId);
      if (found.length > 1) throw new ProviderError('analysis_batch_duplicate_submission', 'Multiple matching batches require operator review.', false);
      if (found[0]) return found[0];
      if (!list.has_more) return null;
      const next = typeof list.last_id === 'string' ? list.last_id : batches.at(-1)?.id;
      if (!next || next === after) throw new ProviderError('analysis_batch_invalid_cursor', 'Batch list pagination could not progress.', true);
      after = next;
    }
    return null;
  }
  async download(fileId: string): Promise<string> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}/content`);
    return response.text();
  }
}

/** Outputs may arrive in any order. Never associate them with inputs by line number. */
export function parseBatchResultLines(contents: string, expectedIds: Set<string>): Map<string, BatchResultLine> {
  const rows = new Map<string, BatchResultLine>();
  for (const line of contents.split('\n').filter((value) => value.trim())) {
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { throw new ProviderError('analysis_batch_invalid_output', 'Batch output contained malformed JSON.', false); }
    const row = object(raw);
    if (!row || typeof row.custom_id !== 'string' || !expectedIds.has(row.custom_id) || rows.has(row.custom_id))
      throw new ProviderError('analysis_batch_invalid_output', 'Batch output contained an unknown or duplicate request ID.', false);
    const response = object(row.response);
    if (response && (typeof response.status_code !== 'number' || !object(response.body)))
      throw new ProviderError('analysis_batch_invalid_output', 'Batch output contained an invalid response envelope.', false);
    rows.set(row.custom_id, row as unknown as BatchResultLine);
  }
  return rows;
}
