import { AccessError } from '@citevia/storage';

/** Enforce the byte limit while consuming the stream, before JSON validation can allocate issues. */
export async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes)
    throw new AccessError(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw new AccessError(413, 'BODY_TOO_LARGE', 'Request is too large.');
      }
      chunks.push(value);
    }
  } finally { request.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** Iterative traversal bounds nested hostile input without risking recursive stack exhaustion. */
export function validateJsonComplexity(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 20000 || current.depth > 32)
      throw new AccessError(413, 'BODY_TOO_COMPLEX', 'Request contains too many or too deeply nested fields.');
    if (current.value === null || typeof current.value !== 'object') continue;
    const values = Object.values(current.value);
    if (values.length > 1000)
      throw new AccessError(413, 'BODY_TOO_COMPLEX', 'Request contains too many fields or items.');
    for (const child of values) pending.push({ value: child, depth: current.depth + 1 });
  }
}

export async function readRequestJson(request: Request, maxBytes = 600000, maxCharacters = 150000): Promise<unknown> {
  const raw = await readRequestText(request, maxBytes);
  // Preserve the existing character limit, including non-ASCII account content.
  if (raw.length > maxCharacters) throw new AccessError(413, 'BODY_TOO_LARGE', 'Request is too large.');
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new AccessError(400, 'INVALID_JSON', 'Expected a JSON request body.'); }
  validateJsonComplexity(value);
  return value;
}
