import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { readRequestText } from '../apps/api/src/request-body.js';
import { createApi } from '../apps/api/src/app.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const fixed = new Date('2026-11-02T12:00:00Z');
const runtime = () => ({ repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() });

describe('API hardening integration review', () => {
  it('preserves the oversize rejection if stream cancellation itself rejects', async () => {
    const cancel = vi.fn(async () => { throw new Error('Cancellation failed'); });
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel });
    const request = new Request('https://api.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(readRequestText(request, 10)).rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not wait forever for cancellation after rejecting a body', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { return new Promise(() => {}); } });
    const request = new Request('https://api.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(readRequestText(request, 10)).rejects.toMatchObject({ status: 413 });
  });
  it('stops reading a stalled body when the caller cancels', async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const request = new Request('https://api.test', { method: 'POST', signal: controller.signal,
      body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
    const pending = readRequestText(request, 100);
    const check = expect(pending).rejects.toBeDefined();
    controller.abort(); await check; expect(cancel).toHaveBeenCalledOnce();
  });
  it('allows a normal dashboard polling envelope without weakening tenant checks', async () => {
    const r = runtime(), owner = testIdentity('owner');
    await r.repository.syncUser(owner);
    const project = newProject({ id: 'dashboard-account' });
    await r.repository.saveProject(project, null);
    await r.repository.putMembership({ projectId: project.id, userId: owner.subject, role: 'owner' });
    const api = createApi(r, { mode: 'live', now: () => fixed });
    // Twelve full account refreshes/minute plus active-view updates is below the default user limit.
    const paths = ['/v1/me', '/v1/runtime', '/v1/projects', `/v1/projects/${project.id}/settings`, `/v1/projects/${project.id}/runs`, `/v1/projects/${project.id}/prompts`];
    const statuses = await Promise.all(Array.from({ length: 180 }, (_, index) => api(new Request(`https://api.test${paths[index % paths.length]}`), owner).then(r => r.status)));
    expect(statuses.every(status => status === 200)).toBe(true);
    expect((await api(new Request(`https://api.test/v1/projects/${project.id}/settings`), testIdentity('outsider'))).status).toBe(404);
  });
  it('does not consume another tenant account limit for denied access and still rejects viewer writes', async () => {
    const r = runtime(), project = newProject({ id: 'private-account' });
    await r.repository.saveProject(project, null);
    await r.repository.syncUser(testIdentity('viewer'));
    await r.repository.putMembership({ projectId: project.id, userId: 'viewer', role: 'viewer' });
    const limit = vi.spyOn(r.repository, 'limitMcpRequests');
    const api = createApi(r, { mode: 'live', now: () => fixed });
    expect((await api(new Request(`https://api.test/v1/projects/${project.id}/settings`), testIdentity('outsider'))).status).toBe(404);
    expect((await api(new Request(`https://api.test/v1/projects/${project.id}/settings`, { method: 'PATCH', body: '{}' }), testIdentity('viewer'))).status).toBe(403);
    expect(limit.mock.calls.every(call => call[0].startsWith('api:user:'))).toBe(true);
  });
  it('keeps tracker delivery public and hardened without authenticating a public script', async () => {
    const authenticate = vi.fn();
    const api = createAuthenticatedApi(runtime(), { authenticate, lookup: vi.fn() }, { mode: 'live', now: () => fixed,
      mcp: { publicUrl: 'https://api.test', frontendUrl: 'https://app.test' } });
    const response = await api(new Request('https://api.test/v1/traffic/tracker.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(authenticate).not.toHaveBeenCalled();
  });
});
