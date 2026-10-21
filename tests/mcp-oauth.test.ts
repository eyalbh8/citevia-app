import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createMcpOAuth } from '../apps/api/src/mcp-oauth.js';
import { AuthenticationError } from '../apps/api/src/descope.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const BASE = 'https://api.citevia.test';
const FRONTEND = 'https://app.citevia.test';
const REDIRECT = 'https://client.example/oauth/callback';
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function setup() {
  let timestamp = Date.parse('2026-10-21T12:00:00Z');
  const repository = new MemoryRepository();
  const admin = await repository.syncUser(testIdentity('admin'));
  await repository.bootstrapAdmin(admin.id);
  const owner = await repository.syncUser(testIdentity('owner'));
  const viewer = await repository.syncUser(testIdentity('viewer'));
  const outsider = await repository.syncUser(testIdentity('outsider'));
  await repository.saveProject(newProject({ id: 'alpha', name: 'Alpha' }), null);
  await repository.saveProject(newProject({ id: 'beta', name: 'Beta' }), null);
  await repository.putMembership({ userId: owner.subject, projectId: 'alpha', role: 'owner' });
  await repository.putMembership({ userId: viewer.subject, projectId: 'alpha', role: 'viewer' });
  const oauth = createMcpOAuth({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, {
    authenticate: async request => {
      const subject = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (!subject || !['admin', 'owner', 'viewer', 'outsider'].includes(subject))
        throw new AuthenticationError(401, 'INVALID_SESSION', 'Invalid session');
      return testIdentity(subject);
    },
    lookup: async () => { throw new Error('Unexpected lookup'); },
  }, { publicUrl: BASE, frontendUrl: FRONTEND, now: () => new Date(timestamp) });
  async function call(path: string, method = 'GET', body?: unknown, subject?: string, headers: Record<string, string> = {}) {
    const response = await oauth(new Request(`${BASE}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(subject ? { Authorization: `Bearer ${subject}`, Origin: FRONTEND } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!response) throw new Error('Expected OAuth route');
    return response;
  }
  async function register(body: Record<string, unknown> = {}) {
    const response = await call('/oauth/register', 'POST', {
      client_name: 'Test assistant', redirect_uris: [REDIRECT], ...body,
    });
    expect(response.status).toBe(201);
    return await response.json() as { client_id: string; client_secret?: string };
  }
  async function start(clientId: string, resource = `${BASE}/mcp`, params: Record<string, string> = {}) {
    return call(`/oauth/authorize?${new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: CHALLENGE, code_challenge_method: 'S256', resource,
      state: 'client-state', ...params,
    })}`);
  }
  async function pending(clientId: string, resource = `${BASE}/mcp`) {
    const response = await start(clientId, resource);
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.origin).toBe(FRONTEND);
    return url.searchParams.get('mcp_authorize')!;
  }
  async function approve(requestId: string, subject = 'owner', projectId?: string) {
    return call('/v1/mcp/oauth/consent', 'POST', { requestId, approve: true,
      ...(projectId ? { projectId } : {}) }, subject);
  }
  async function authorize(clientId: string, subject = 'owner', resource = `${BASE}/mcp/accounts/alpha`, projectId?: string) {
    const requestId = await pending(clientId, resource);
    const response = await approve(requestId, subject, projectId);
    expect(response.status).toBe(200);
    const redirect = new URL((await response.json()).redirectUrl);
    expect(redirect.origin).toBe(new URL(REDIRECT).origin);
    expect(redirect.searchParams.get('state')).toBe('client-state');
    return redirect.searchParams.get('code')!;
  }
  const exchange = (clientId: string, code: string, resource = `${BASE}/mcp/accounts/alpha`, extra: Record<string, unknown> = {}) =>
    call('/oauth/token', 'POST', { grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: VERIFIER, redirect_uri: REDIRECT, resource, ...extra });
  const refresh = (clientId: string, token: string, resource = `${BASE}/mcp/accounts/alpha`, extra: Record<string, unknown> = {}) =>
    call('/oauth/token', 'POST', { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: token, resource, ...extra });
  return { repository, admin, owner, viewer, outsider, oauth, call, register, start,
    pending, approve, authorize, exchange, refresh, advance: (ms: number) => { timestamp += ms; } };
}

describe('MCP OAuth', () => {
  it('publishes resource-specific metadata and PKCE / refresh discovery', async () => {
    const f = await setup();
    expect(await (await f.call('/.well-known/oauth-protected-resource/mcp/accounts/alpha')).json())
      .toMatchObject({ resource: `${BASE}/mcp/accounts/alpha`, authorization_servers: [BASE], bearer_methods_supported: ['header'] });
    expect(await (await f.call('/.well-known/oauth-authorization-server')).json()).toMatchObject({
      issuer: BASE, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
      registration_endpoint: `${BASE}/oauth/register`,
    });
    expect((await f.call('/.well-known/oauth-protected-resource/mcp/accounts/alpha/extra')).status).toBe(400);
    expect(await f.oauth(new Request(`${BASE}/v1/projects`))).toBeNull();
  });

  it.each(['javascript:alert(1)', 'http://remote.example/callback', 'https://a.test/cb#fragment', 'https://user:pass@a.test/cb'])
    ('refuses unsafe client redirects %s', async redirect => {
      const f = await setup();
      const response = await f.call('/oauth/register', 'POST', { redirect_uris: [redirect] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_client_metadata' });
    });

  it('permits loopback clients, bounds registration and rejects unsupported client metadata', async () => {
    const f = await setup();
    await f.register({ redirect_uris: ['http://127.0.0.1:49152/callback'], token_endpoint_auth_method: 'none' });
    expect((await f.call('/oauth/register', 'POST', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'unknown' })).status).toBe(400);
    expect((await f.call('/oauth/register', 'POST', { redirect_uris: [REDIRECT], scope: 'admin' })).status).toBe(400);
    for (let i = 0; i < 27; i++) await f.register();
    const response = await f.call('/oauth/register', 'POST', { redirect_uris: [REDIRECT] });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('persists only hashed secrets and issues account-bound access and rotating refresh tokens', async () => {
    const f = await setup(), client = await f.register();
    const code = await f.authorize(client.client_id);
    expect(await f.repository.getMcpRecord('code', code)).toBeNull();
    const tokenResponse = await f.exchange(client.client_id, code);
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('cache-control')).toBe('no-store');
    const tokens = await tokenResponse.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    const access = await f.repository.getMcpRecord('access', hash(tokens.access_token));
    expect(access?.data).toMatchObject({ clientId: client.client_id, resource: `${BASE}/mcp/accounts/alpha` });
    const connection = await f.repository.getMcpConnection(String(access!.data.connectionId));
    expect(connection).toMatchObject({ userId: 'owner', projectId: 'alpha', kind: 'oauth', revokedAt: null });
    expect(await f.repository.getMcpRecord('access', tokens.access_token)).toBeNull();
    expect(await f.repository.getMcpRecord('refresh', tokens.refresh_token)).toBeNull();
    expect(JSON.stringify(access)).not.toContain(tokens.access_token);
    const rotated = await (await f.refresh(client.client_id, tokens.refresh_token)).json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await f.repository.getMcpRecord('refresh', hash(tokens.refresh_token)))?.data.consumed).toBe(true);
    expect((await f.refresh(client.client_id, tokens.refresh_token)).status).toBe(400);
    expect((await f.refresh(client.client_id, rotated.refresh_token)).status).toBe(400);
    expect((await f.repository.getMcpConnection(connection!.id))?.revokedAt).toBeTruthy();
  });

  it('provides one global administrator grant and refuses new explicit account grants for admins', async () => {
    const f = await setup(), client = await f.register();
    const requestId = await f.pending(client.client_id);
    const view = await f.call(`/v1/mcp/oauth/consent?requestId=${requestId}`, 'GET', undefined, 'admin');
    expect(await view.json()).toMatchObject({ scope: 'system', projectId: null, projects: [] });
    const result = await f.approve(requestId, 'admin');
    const code = new URL((await result.json()).redirectUrl).searchParams.get('code')!;
    const token = await (await f.exchange(client.client_id, code, `${BASE}/mcp`)).json();
    const access = await f.repository.getMcpRecord('access', hash(token.access_token));
    expect(await f.repository.getMcpConnection(String(access!.data.connectionId))).toMatchObject({ projectId: null, userId: 'admin' });
    const accountRequest = await f.pending(client.client_id, `${BASE}/mcp/accounts/alpha`);
    const accountView = await f.call(`/v1/mcp/oauth/consent?requestId=${accountRequest}`, 'GET', undefined, 'admin');
    expect(accountView.status).toBe(403);
    expect((await accountView.json()).error.message).toContain(`${BASE}/mcp`);
    expect((await f.approve(accountRequest, 'admin')).status).toBe(403);
  });

  it('requires non-admin account selection from current memberships for the generic endpoint', async () => {
    const f = await setup(), client = await f.register();
    const requestId = await f.pending(client.client_id);
    const consent = await f.call(`/v1/mcp/oauth/consent?requestId=${requestId}`, 'GET', undefined, 'viewer');
    expect(await consent.json()).toMatchObject({ scope: 'account', projectId: null,
      projects: [{ id: 'alpha', name: 'Alpha', role: 'viewer' }] });
    expect((await f.approve(requestId, 'viewer')).status).toBe(400);
    expect((await f.approve(requestId, 'viewer', 'beta')).status).toBe(403);
    const approved = await f.approve(requestId, 'viewer', 'alpha');
    const code = new URL((await approved.json()).redirectUrl).searchParams.get('code')!;
    const tokens = await (await f.exchange(client.client_id, code, `${BASE}/mcp`)).json();
    const access = await f.repository.getMcpRecord('access', hash(tokens.access_token));
    expect(await f.repository.getMcpConnection(String(access!.data.connectionId))).toMatchObject({ userId: 'viewer', projectId: 'alpha' });
  });

  it('requires real session authentication, trusted consent origin and matching bound account', async () => {
    const f = await setup(), client = await f.register(), requestId = await f.pending(client.client_id, `${BASE}/mcp/accounts/alpha`);
    expect((await f.call(`/v1/mcp/oauth/consent?requestId=${requestId}`)).status).toBe(401);
    expect((await f.call(`/v1/mcp/oauth/consent?requestId=${requestId}`, 'GET', undefined, 'owner', { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await f.approve(requestId, 'outsider')).status).toBe(403);
    expect((await f.approve(requestId, 'owner', 'beta')).status).toBe(403);
    expect((await f.approve(requestId, 'owner')).status).toBe(200);
    expect((await f.approve(requestId, 'owner')).status).toBe(400);
  });

  it('denies consent without issuing a grant and preserves OAuth state', async () => {
    const f = await setup(), client = await f.register(), requestId = await f.pending(client.client_id);
    const denied = await f.call('/v1/mcp/oauth/consent', 'POST', { requestId, approve: false }, 'owner');
    const redirect = new URL((await denied.json()).redirectUrl);
    expect(redirect.searchParams.get('state')).toBe('client-state');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.has('code')).toBe(false);
    expect((await f.approve(requestId, 'owner', 'alpha')).status).toBe(400);
  });

  it('enforces S256 and exact registered redirects before creating consent requests', async () => {
    const f = await setup(), client = await f.register();
    const invalid: Record<string, string>[] = [
      { code_challenge_method: 'plain' }, { code_challenge: 'short' },
      { redirect_uri: 'https://evil.test/cb' }, { resource: 'https://evil.test/mcp' },
      { response_type: 'token' }, { scope: 'admin' },
    ];
    for (const params of invalid) expect((await f.start(client.client_id, `${BASE}/mcp`, params)).status).toBe(400);
  });

  it('binds authorization codes to client, approved redirect, PKCE and exact resource', async () => {
    const f = await setup(), client = await f.register({ redirect_uris: [REDIRECT, 'https://client.example/alternate'] });
    const other = await f.register(), code = await f.authorize(client.client_id);
    for (const response of [
      await f.exchange(other.client_id, code),
      await f.exchange(client.client_id, code, `${BASE}/mcp`),
      await f.exchange(client.client_id, code, `${BASE}/mcp/accounts/beta`),
      await f.exchange(client.client_id, code, `${BASE}/mcp/accounts/alpha`, { code_verifier: 'b'.repeat(64) }),
      await f.exchange(client.client_id, code, `${BASE}/mcp/accounts/alpha`, { redirect_uri: 'https://client.example/alternate' }),
    ]) expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect((await f.exchange(client.client_id, code)).status).toBe(200);
    expect((await f.exchange(client.client_id, code)).status).toBe(400);
  });

  it('allows only one successful code redemption and refresh rotation under concurrent requests', async () => {
    const f = await setup(), client = await f.register(), code = await f.authorize(client.client_id);
    const responses = await Promise.all([f.exchange(client.client_id, code), f.exchange(client.client_id, code)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const token = await responses.find(response => response.status === 200)!.json();
    const refreshed = await Promise.all([f.refresh(client.client_id, token.refresh_token), f.refresh(client.client_id, token.refresh_token)]);
    expect(refreshed.map(response => response.status).sort()).toEqual([200, 400]);
    const access = await f.repository.getMcpRecord('access', hash(token.access_token));
    expect((await f.repository.getMcpConnection(String(access!.data.connectionId)))?.revokedAt).toBeTruthy();
  });

  it('rejects another client or resource before consuming or revoking the valid refresh grant', async () => {
    const f = await setup(), client = await f.register(), other = await f.register();
    const code = await f.authorize(client.client_id);
    const tokens = await (await f.exchange(client.client_id, code)).json();
    expect((await f.refresh(other.client_id, tokens.refresh_token)).status).toBe(400);
    expect((await f.refresh(client.client_id, tokens.refresh_token, `${BASE}/mcp/accounts/beta`)).status).toBe(400);
    expect((await f.refresh(client.client_id, tokens.refresh_token)).status).toBe(200);
    const access = await f.repository.getMcpRecord('access', hash(tokens.access_token));
    expect((await f.repository.getMcpConnection(String(access!.data.connectionId)))?.revokedAt).toBeNull();
  });

  it('expires pending consent, authorization codes and refresh tokens', async () => {
    const f = await setup(), client = await f.register(), requestId = await f.pending(client.client_id);
    f.advance(10 * 60_000);
    expect((await f.approve(requestId, 'admin')).status).toBe(400);
    const expiredCode = await f.authorize(client.client_id);
    f.advance(5 * 60_000);
    expect((await f.exchange(client.client_id, expiredCode)).status).toBe(400);
    const code = await f.authorize(client.client_id), token = await (await f.exchange(client.client_id, code)).json();
    f.advance(30 * 24 * 60 * 60_000);
    expect((await f.refresh(client.client_id, token.refresh_token)).status).toBe(400);
  });

  it.each(['disabled', 'membership removed', 'revoked'])(
    'refuses refresh when access is %s', async condition => {
      const f = await setup(), client = await f.register(), code = await f.authorize(client.client_id);
      const tokens = await (await f.exchange(client.client_id, code)).json();
      if (condition === 'disabled') {
        const owner = (await f.repository.getUser('owner'))!;
        await f.repository.updateUserAccess('admin', owner.id, owner.version, { disabled: true });
      } else if (condition === 'membership removed') {
        const owner = (await f.repository.getUser('owner'))!;
        await f.repository.setUserAccount('admin', owner.id, 'alpha', null, owner.version);
      } else {
        const access = await f.repository.getMcpRecord('access', hash(tokens.access_token));
        await f.repository.revokeMcpConnection(String(access!.data.connectionId), 'owner', '2026-10-21T12:01:00Z');
      }
      expect(await (await f.refresh(client.client_id, tokens.refresh_token)).json()).toEqual({ error: 'invalid_grant' });
    },
  );

  it('rechecks account membership at code redemption and refuses global refresh after admin demotion', async () => {
    const f = await setup(), client = await f.register(), ownerCode = await f.authorize(client.client_id);
    const owner = (await f.repository.getUser('owner'))!;
    await f.repository.setUserAccount('admin', owner.id, 'alpha', null, owner.version);
    expect((await f.exchange(client.client_id, ownerCode)).status).toBe(400);
    const adminCode = await f.authorize(client.client_id, 'admin', `${BASE}/mcp`);
    const tokens = await (await f.exchange(client.client_id, adminCode, `${BASE}/mcp`)).json();
    const other = await f.repository.syncUser(testIdentity('other-admin'));
    const promoted = await f.repository.updateUserAccess('admin', other.id, other.version, { isSystemAdmin: true });
    const admin = (await f.repository.getUser('admin'))!;
    await f.repository.updateUserAccess(promoted.subject, admin.id, admin.version, { isSystemAdmin: false });
    expect((await f.refresh(client.client_id, tokens.refresh_token, `${BASE}/mcp`)).status).toBe(400);
  });

  it('keeps issued account grants scoped after admin promotion and refuses pending account code issuance', async () => {
    const f = await setup(), client = await f.register();
    const issuedCode = await f.authorize(client.client_id), pendingCode = await f.authorize(client.client_id);
    const tokens = await (await f.exchange(client.client_id, issuedCode)).json();
    const owner = (await f.repository.getUser('owner'))!;
    await f.repository.updateUserAccess('admin', owner.id, owner.version, { isSystemAdmin: true });
    expect((await f.exchange(client.client_id, pendingCode)).status).toBe(400);
    const refreshed = await f.refresh(client.client_id, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const newTokens = await refreshed.json();
    const access = await f.repository.getMcpRecord('access', hash(newTokens.access_token));
    expect(await f.repository.getMcpConnection(String(access!.data.connectionId))).toMatchObject({ projectId: 'alpha' });
    expect((await f.refresh(client.client_id, newTokens.refresh_token, `${BASE}/mcp/accounts/beta`)).status).toBe(400);
  });

  it('hashes confidential client secrets and authenticates their configured method', async () => {
    const f = await setup(), client = await f.register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(client.client_secret).toBeTruthy();
    const saved = await f.repository.getMcpRecord('client', client.client_id);
    expect(JSON.stringify(saved)).not.toContain(client.client_secret);
    const code = await f.authorize(client.client_id);
    expect((await f.exchange(client.client_id, code)).status).toBe(401);
    expect((await f.exchange(client.client_id, code, `${BASE}/mcp/accounts/alpha`, { client_secret: 'wrong' })).status).toBe(401);
    expect((await f.exchange(client.client_id, code, `${BASE}/mcp/accounts/alpha`, { client_secret: client.client_secret })).status).toBe(200);
  });

  it('supports form-encoded token requests with client_secret_basic', async () => {
    const f = await setup(), client = await f.register({ token_endpoint_auth_method: 'client_secret_basic' });
    const code = await f.authorize(client.client_id);
    const response = await f.oauth(new Request(`${BASE}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: VERIFIER,
        redirect_uri: REDIRECT, resource: `${BASE}/mcp/accounts/alpha` }),
    }));
    expect(response?.status).toBe(200);
  });

  it('rejects oversized bodies and duplicate form parameters without exposing submitted secrets', async () => {
    const f = await setup();
    const oversized = await f.call('/oauth/register', 'POST', { client_name: 'private'.repeat(6000) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'invalid_request' });
    const duplicated = await f.oauth(new Request(`${BASE}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=first&client_id=second&client_secret=private',
    }));
    expect(duplicated?.status).toBe(400);
    expect(await duplicated?.json()).toEqual({ error: 'invalid_request' });
  });
});
