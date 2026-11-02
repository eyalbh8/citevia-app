/** Read decoded response bytes incrementally; Content-Length alone is not a trusted limit. */
export class ResponseBodyLimitError extends Error {}
export async function boundedResponseBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Response byte limit must be positive.');
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError('Provider response exceeded the application limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError('Provider response exceeded the application limit.');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
