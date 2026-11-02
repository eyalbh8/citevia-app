import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { auditRoute, enforceApiLimit, secureResponse } from '../apps/api/src/api-security.js';
import { readRequestJson, readRequestText } from '../apps/api/src/request-body.js';
import { createApi } from '../apps/api/src/app.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { AuthenticationError } from '../apps/api/src/descope.js';
import { testIdentity } from './fixtures/users.js';
import { newProject } from './fixtures/scanner.js';

afterEach(() => vi.unstubAllEnvs());
const now = new Date('2026-11-02T12:00:00Z');
const runtime = () => ({ repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() });

describe('bounded audit routes', () => {
  it('retains known route categories without recording user-controlled resource names', () => {
    expect(auditRoute('/v1/projects/account/settings')).toBe('/v1/projects/:projectId/settings');
    expect(auditRoute('/v1/projects/account/prompts/private-customer-name')).toBe('/v1/projects/:projectId/prompts/:resource');
    expect(auditRoute('/v1/projects/account/private-customer-name')).toBe('/v1/projects/:projectId/:resource');
    expect(auditRoute('/v1/projects/account/social/' + 'private/'.repeat(1000))).toBe('/v1/projects/:projectId/social/:resource');
  });
});

describe('bounded untrusted request bodies', () => {
  it('cancels an oversized chunked stream even when the declared length is forged', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8));
    }, cancel });
    const request = new Request('https://api.test', { method: 'POST', headers: { 'content-length': '1' }, body, duplex: 'half' } as RequestInit);
    await expect(readRequestText(request, 10)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects oversized declarations without consuming the body', async () => {
    const request = new Request('https://api.test', { method: 'POST', headers: { 'content-length': '9999999' }, body: '{}' });
    await expect(readRequestJson(request)).rejects.toMatchObject({ status: 413 });
    expect(request.bodyUsed).toBe(false);
  });
  it('preserves the existing character limit for multilingual content', async () => {
    const data = { description: '漢'.repeat(100000) };
    await expect(readRequestJson(new Request('https://api.test', { method: 'POST', body: JSON.stringify(data) }))).resolves.toEqual(data);
  });
  it('rejects deeply nested and excessive collections before schema validation', async () => {
    for (const body of ['['.repeat(1000) + '0' + ']'.repeat(1000), JSON.stringify({ rows: Array(1001).fill({ bad: true }) })]) {
      await expect(readRequestJson(new Request('https://api.test', { method: 'POST', body }))).rejects.toMatchObject({ code: 'BODY_TOO_COMPLEX', status: 413 });
    }
  });
});

describe('distributed API request admission', () => {
  it('enforces the shared counter across concurrent calls and keeps users independent', async () => {
    vi.stubEnv('API_USER_READS_PER_MINUTE', '2');
    const { repository } = runtime();
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => enforceApiLimit(repository, 'user-a', 'GET', now)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    await expect(enforceApiLimit(repository, 'user-b', 'GET', now)).resolves.toBeUndefined();
    await expect(enforceApiLimit(repository, 'user-a', 'GET', new Date(now.getTime() + 60000))).resolves.toBeUndefined();
    await expect(enforceApiLimit(repository, 'user-a', 'POST', now)).resolves.toBeUndefined();
  });
  it('shares an account limit across different members without consuming another account allowance', async () => {
    vi.stubEnv('API_ACCOUNT_READS_PER_MINUTE', '1');
    const { repository } = runtime();
    await enforceApiLimit(repository, 'a', 'GET', now, 'account-a');
    await expect(enforceApiLimit(repository, 'b', 'GET', now, 'account-a')).rejects.toMatchObject({ status: 429 });
    await expect(enforceApiLimit(repository, 'b', 'GET', now, 'account-b')).resolves.toBeUndefined();
  });
  it('returns Retry-After and preserves access denial for another tenant', async () => {
    vi.stubEnv('API_USER_READS_PER_MINUTE', '2');
    const r = runtime();
    await r.repository.saveProject(newProject({ id: 'a' }), null);
    const api = createApi(r, { mode: 'live', now: () => now });
    const call = () => api(new Request('https://api.test/v1/projects/a/settings'), testIdentity('outsider'));
    expect((await call()).status).toBe(404);
    expect((await call()).status).toBe(404);
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });
});

describe('response hardening', () => {
  it('adds security policy to authentication failures without losing the error contract', async () => {
    const authenticate = vi.fn().mockRejectedValue(new AuthenticationError(401, 'INVALID_SESSION', 'Sign in again.'));
    const api = createAuthenticatedApi(runtime(), { authenticate, lookup: vi.fn() }, { mode: 'live',
      mcp: { publicUrl: 'https://api.test', frontendUrl: 'https://app.test' } });
    const response = await api(new Request('https://api.test/v1/me'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_SESSION' } });
  });
  it('preserves tracker cross-origin access and avoids HSTS on plain local HTTP', () => {
    const response = secureResponse(new Response('', { headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' } }), new Request('http://localhost/tracker.js'));
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });
});
