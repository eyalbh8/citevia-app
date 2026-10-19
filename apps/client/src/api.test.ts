import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getAccessToken: async () => 'test-token' }));
import { idempotentPost } from './api';

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
}
const ok = () => new Response(JSON.stringify({ runId: 'run-1' }), { status: 202 });

describe('scan request idempotency', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('repairs an ambiguous server failure with the same key, then gives a new intent a fresh key', async () => {
    storage();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Queue unavailable' } }), { status: 503 })).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    await expect(idempotentPost('/projects/key-recovery/runs')).rejects.toThrow('Queue unavailable');
    await idempotentPost('/projects/key-recovery/runs');
    await idempotentPost('/projects/key-recovery/runs');
    const keys = fetcher.mock.calls.map(call => (call[1].headers as Headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });
  it('coalesces double-clicks into one request and preserves the retry key after a lost response', async () => {
    storage();
    let reject!: (error: Error) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((_, rejectResponse) => { reject = rejectResponse; })).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const first = idempotentPost('/projects/double-click/runs/run-1/retry-failed');
    const second = idempotentPost('/projects/double-click/runs/run-1/retry-failed');
    expect(first).toBe(second);
    await Promise.resolve();
    reject(new TypeError('Network connection lost'));
    await expect(first).rejects.toThrow('Network connection lost');
    await idempotentPost('/projects/double-click/runs/run-1/retry-failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[0][1].headers as Headers).get('Idempotency-Key')).toBe((fetcher.mock.calls[1][1].headers as Headers).get('Idempotency-Key'));
  });
});
