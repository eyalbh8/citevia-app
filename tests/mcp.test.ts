import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { AuthenticationError, type IdentityProvider } from '../apps/api/src/descope.js';
import { mcpHash } from '../apps/api/src/mcp.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const START = new Date('2026-10-21T10:00:00.000Z');
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  const runtime = { repository, artifacts, queue };
  let current = new Date(START);
  const now = () => current;
  const subjects = ['admin', 'admin2', 'owner', 'viewer', 'outsider'];
  for (const subject of subjects) await repository.syncUser(testIdentity(subject));
  const admin = (await repository.getUser('admin'))!;
  await repository.bootstrapAdmin(admin.id);
  const admin2 = (await repository.getUser('admin2'))!;
  await repository.updateUserAccess('admin', admin2.id, admin2.version, { isSystemAdmin: true });
  for (const id of ['alpha', 'beta']) {
    await repository.saveProject(newProject({ id, name: id === 'alpha' ? 'Alpha' : 'Beta', prompts: ['Which analytics platform should a small team use?'], now: START }), null);
    await repository.putMembership({ projectId: id, userId: 'owner', role: 'owner' });
  }
  await repository.putMembership({ projectId: 'alpha', userId: 'viewer', role: 'viewer' });
  const identity: IdentityProvider = {
    authenticate: async request => {
      const subject = request.headers.get('authorization')?.match(/^Bearer session:(\w+)$/)?.[1];
      if (!subject || !subjects.includes(subject)) throw new AuthenticationError(401, 'INVALID_SESSION', 'A Descope user session is required.');
      return testIdentity(subject);
    },
    lookup: async email => testIdentity(email.split('@')[0]),
  };
  const app = createAuthenticatedApi(runtime, identity, {
    mode: 'live', now, mcp: { publicUrl: 'https://api.test', frontendUrl: 'https://app.test', now },
  });
  const request = (path: string, token: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app(new Request(`https://api.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  async function mint(subject: string, projectId?: string, expiresInDays: 30 | 60 | 90 | null = 90) {
    const response = await request('/v1/mcp/connections', `session:${subject}`, 'POST', { name: 'Test client', ...(projectId ? { projectId } : {}), expiresInDays });
    expect(response.status).toBe(201);
    return await response.json();
  }
  async function rpc(token: string, method: string, params: Record<string, unknown> = {}, options: { path?: string; headers?: Record<string, string> } = {}) {
    const response = await request(options.path || '/mcp', token, 'POST', { jsonrpc: '2.0', id: 1, method, params }, {
      Accept: 'application/json, text/event-stream', ...options.headers,
    });
    return { response, body: await response.json() };
  }
  const tool = (token: string, name: string, args: Record<string, unknown> = {}) => rpc(token, 'tools/call', { name, arguments: args });
  return { repository, runtime, now, setNow: (value: Date) => { current = value; }, app, request, mint, rpc, tool };
}
const toolData = (value: { body: { result: { content: { text: string }[] } } }) => JSON.parse(value.body.result.content[0].text);

describe('MCP management and scope', () => {
  it('issues a global admin connection and per-account member connections, with secrets returned only once', async () => {
    const f = await setup();
    const global = await f.mint('admin');
    const account = await f.mint('owner', 'alpha');
    expect(global).toMatchObject({ scope: 'system', projectId: null, serverUrl: 'https://api.test/mcp' });
    expect(account).toMatchObject({ scope: 'account', projectId: 'alpha', serverUrl: 'https://api.test/mcp/accounts/alpha' });
    expect(account.token).toMatch(/^citevia_live_/);
    const stored = await f.repository.getMcpConnection(account.connection.id);
    expect(stored?.tokenHash).toBe(mcpHash(account.token));
    expect(account.connection.tokenHash).toBeUndefined();
    const listed = await f.request('/v1/mcp/connections?projectId=alpha', 'session:owner');
    const text = await listed.text();
    expect(text).not.toContain(account.token);
    expect(text).not.toContain(stored!.tokenHash);
    expect(JSON.parse(text).connections[0]).toMatchObject({ id: account.connection.id });
    expect((await f.request('/v1/mcp/connections', 'session:admin', 'POST', { name: 'Scoped admin', projectId: 'alpha' })).status).toBe(400);
    expect((await f.request('/v1/mcp/connections', 'session:owner', 'POST', { name: 'Global request' })).status).toBe(400);
    expect((await f.request('/v1/mcp/connections', 'session:outsider', 'POST', { name: 'Other account', projectId: 'alpha' })).status).toBe(404);
  });

  it('lists all accounts for administrators and only the bound account for members with other memberships', async () => {
    const f = await setup(), global = await f.mint('admin'), account = await f.mint('owner', 'alpha');
    expect(toolData(await f.tool(global.token, 'list_accounts')).items.map((item: { id: string }) => item.id).sort()).toEqual(['alpha', 'beta']);
    expect(toolData(await f.tool(account.token, 'list_accounts')).items.map((item: { id: string }) => item.id)).toEqual(['alpha']);
    expect(toolData(await f.tool(global.token, 'settings', { accountId: 'beta' })).id).toBe('beta');
    expect(toolData(await f.tool(account.token, 'settings')).id).toBe('alpha');
    expect((await f.tool(global.token, 'settings')).body.error.code).toBe(-32602);
    expect((await f.tool(account.token, 'settings', { accountId: 'beta' })).body.result.isError).toBe(true);
    expect(toolData(await f.tool(account.token, 'api_get', { path: '/v1/projects' })).items.map((item: { id: string }) => item.id)).toEqual(['alpha']);
  });

  it('blocks account overrides in endpoint, headers, and the read API allowlist', async () => {
    const f = await setup(), account = await f.mint('owner', 'alpha');
    expect((await f.rpc(account.token, 'ping', {}, { path: '/mcp/accounts/beta' })).response.status).toBe(403);
    expect((await f.rpc(account.token, 'ping', {}, { headers: { 'X-Workspace-Id': 'beta' } })).response.status).toBe(403);
    expect((await f.rpc(account.token, 'ping', {}, { path: '/mcp/accounts/alpha' })).response.status).toBe(200);
    for (const path of [
      '/v1/admin/users', '/v1/mcp/connections', 'https://evil.test/v1/projects/alpha/settings',
      '//evil.test/v1/projects/alpha/settings', '/v1/projects/alpha/../beta/settings',
      '/v1/projects/alpha/%2e%2e/beta/settings', '/v1/projects/alpha/settings?projectId=beta',
      '/v1/projects/alpha/settings#ignored', '/v1/projects/alpha\\..\\beta/settings',
      '/v1/projects/beta/settings', '/v1/projects/alpha/onboarding/stop',
    ]) {
      const result = await f.tool(account.token, 'api_get', { path });
      expect(result.body.result?.isError || !!result.body.error, path).toBe(true);
    }
    expect(toolData(await f.tool(account.token, 'api_get', { path: '/v1/projects/alpha/settings', query: { accountId: 'beta', projectId: 'beta' } })).id).toBe('alpha');
  });

  it('keeps MCP credentials outside the Descope session and administrative APIs', async () => {
    const f = await setup(), key = await f.mint('admin');
    for (const path of ['/v1/me', '/v1/admin/users', '/v1/mcp/connections'])
      expect((await f.request(path, key.token)).status).toBe(401);
    expect((await f.rpc('session:admin', 'ping')).response.status).toBe(401);
    const missing = await f.rpc('unknown-token', 'ping', {}, { path: '/mcp/accounts/alpha' });
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get('www-authenticate')).toContain('https://api.test/.well-known/oauth-protected-resource/mcp/accounts/alpha');
    const discovery = await f.app(new Request('https://api.test/.well-known/oauth-protected-resource/mcp/accounts/alpha'));
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ resource: 'https://api.test/mcp/accounts/alpha', authorization_servers: ['https://api.test'] });
  });
});

describe('MCP live permissions and credential lifetime', () => {
  it('limits viewer tools and applies existing API schemas and ownership checks to writes', async () => {
    const f = await setup(), viewer = await f.mint('viewer', 'alpha'), owner = await f.mint('owner', 'alpha');
    const tools = (await f.rpc(viewer.token, 'tools/list')).body.result.tools;
    expect(tools.some((tool: { name: string }) => tool.name === 'create_prompt')).toBe(false);
    expect((await f.tool(viewer.token, 'create_prompt', { body: { text: 'Which tool is ideal?' } })).body.error.code).toBe(-32602);
    const added = await f.tool(owner.token, 'create_prompt', { body: { text: 'How should a business evaluate campaign reports?', stage: 'understand', seoKeyword: 'campaign reporting', tags: ['MCP'] } });
    const prompt = toolData(added).items[0];
    expect(prompt).toMatchObject({ stage: 'understand', seoKeyword: 'campaign reporting', tags: ['MCP'] });
    const changed = await f.tool(owner.token, 'update_prompt', { promptId: prompt.id, body: { version: prompt.version, active: false } });
    expect(toolData(changed)).toMatchObject({ active: false, version: 2 });
    const bad = await f.tool(owner.token, 'create_prompt', { body: { text: 'Wrong field?', journeyStage: 'Understand' } });
    expect(bad.body.result.isError).toBe(true);
    const tracked = toolData(await f.tool(owner.token, 'track_url', { body: { url: 'https://northstar.example/article' } }));
    expect(tracked.id).toBeTruthy();
    expect(toolData(await f.tool(owner.token, 'update_tracked_url', { trackedUrlId: tracked.id, body: { version: tracked.version, title: 'Article updated', active: false } }))).toMatchObject({ title: 'Article updated', active: false });
  });

  it('rechecks owner downgrades, membership removal, disablement and administrator demotion on every request', async () => {
    const f = await setup(), owner = await f.mint('owner', 'alpha'), viewer = await f.mint('viewer', 'alpha'), global = await f.mint('admin');
    const ownerUser = (await f.repository.getUser('owner'))!;
    await f.repository.setUserAccount('admin', ownerUser.id, 'alpha', 'viewer', ownerUser.version);
    expect((await f.tool(owner.token, 'create_prompt', { body: { text: 'Unauthorized write?' } })).body.error.code).toBe(-32602);
    expect((await f.tool(owner.token, 'settings')).response.status).toBe(200);
    const downgraded = (await f.repository.getUser('owner'))!;
    await f.repository.setUserAccount('admin', downgraded.id, 'alpha', null, downgraded.version);
    expect((await f.rpc(owner.token, 'ping')).response.status).toBe(403);
    const viewerUser = (await f.repository.getUser('viewer'))!;
    await f.repository.updateUserAccess('admin', viewerUser.id, viewerUser.version, { disabled: true });
    expect((await f.rpc(viewer.token, 'ping')).response.status).toBe(401);
    const admin = (await f.repository.getUser('admin'))!;
    await f.repository.updateUserAccess('admin2', admin.id, admin.version, { isSystemAdmin: false });
    expect((await f.rpc(global.token, 'ping')).response.status).toBe(403);
  });

  it('allows normal token reuse and immediately rejects expired or revoked tokens', async () => {
    const f = await setup(), key = await f.mint('owner', 'alpha', 30), other = await f.mint('viewer', 'alpha', null);
    expect((await f.rpc(key.token, 'ping')).response.status).toBe(200);
    expect((await f.rpc(key.token, 'ping')).response.status).toBe(200);
    expect((await f.request(`/v1/mcp/connections/${key.connection.id}`, 'session:viewer', 'DELETE')).status).toBe(404);
    expect((await f.rpc(key.token, 'ping')).response.status).toBe(200);
    f.setNow(new Date(START.getTime() + 30 * 86400000));
    expect((await f.rpc(key.token, 'ping')).response.status).toBe(401);
    expect((await f.rpc(other.token, 'ping')).response.status).toBe(200);
    expect((await f.request(`/v1/mcp/connections/${other.connection.id}`, 'session:viewer', 'DELETE')).status).toBe(204);
    expect((await f.request(`/v1/mcp/connections/${other.connection.id}`, 'session:viewer', 'DELETE')).status).toBe(204);
    expect((await f.request(`/v1/mcp/connections/${other.connection.id}`, 'session:owner', 'DELETE')).status).toBe(404);
    expect((await f.rpc(other.token, 'ping')).response.status).toBe(401);
  });

  it('shares the account request budget across the same user’s connections', async () => {
    const f = await setup(), first = await f.mint('owner', 'alpha'), second = await f.mint('owner', 'alpha');
    const responses = await Promise.all(Array.from({ length: 121 }, (_, n) => f.rpc(n % 2 ? first.token : second.token, 'ping')));
    expect(responses.filter(result => result.response.status === 200)).toHaveLength(120);
    const limited = responses.find(result => result.response.status === 429)!;
    expect(limited.response.headers.get('retry-after')).toBe('60');
    f.setNow(new Date(START.getTime() + 60000));
    expect((await f.rpc(first.token, 'ping')).response.status).toBe(200);
  });
});

describe('MCP protocol and API contracts', () => {
  it('negotiates initialization, notifications, tools and resources without exposing credential metadata', async () => {
    const f = await setup(), key = await f.mint('owner', 'alpha');
    const initialized = await f.rpc(key.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    expect(initialized.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} } });
    const notification = await f.request('/mcp', key.token, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, { Accept: 'application/json, text/event-stream' });
    expect(notification.status).toBe(202);
    const listed = await f.rpc(key.token, 'tools/list');
    const create = listed.body.result.tools.find((tool: { name: string }) => tool.name === 'create_prompt');
    expect(create.inputSchema.properties.body.properties.stage.enum).toEqual(['understand', 'prefer', 'trust', 'convert']);
    expect(create.inputSchema.properties.body.properties.journeyStage).toBeUndefined();
    expect(listed.body.result.tools.find((tool: { name: string }) => tool.name === 'response').inputSchema.properties.responseId.pattern).toContain('~');
    expect((await f.rpc(key.token, 'resources/read', { uri: 'citevia://mcp/routes' })).body.result.contents[0].text).toContain('/v1/projects/{accountId}/settings');
    expect(JSON.stringify(listed.body)).not.toContain(key.token);
    expect((await f.rpc(key.token, 'unknown/method')).body.error.code).toBe(-32601);
  });

  it('rejects invalid origins, protocol versions, media, malformed JSON and invalid initialization', async () => {
    const f = await setup(), key = await f.mint('owner', 'alpha');
    expect((await f.rpc(key.token, 'ping', {}, { headers: { Origin: 'https://evil.test' } })).response.status).toBe(403);
    const allowed = await f.rpc(key.token, 'ping', {}, { headers: { Origin: 'https://app.test' } });
    expect(allowed.response.headers.get('access-control-allow-origin')).toBe('https://app.test');
    expect((await f.rpc(key.token, 'ping', {}, { headers: { 'MCP-Protocol-Version': 'invalid' } })).response.status).toBe(400);
    expect((await f.rpc(key.token, 'ping', {}, { headers: { Accept: 'application/json' } })).response.status).toBe(406);
    expect((await f.rpc(key.token, 'ping', {}, { headers: { 'Content-Type': 'text/plain' } })).response.status).toBe(415);
    expect((await f.request('/mcp', key.token)).status).toBe(405);
    const malformed = await f.app(new Request('https://api.test/mcp', { method: 'POST', headers: { Authorization: `Bearer ${key.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: '{bad' }));
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
    const batch = await f.request('/mcp', key.token, 'POST', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { Accept: 'application/json, text/event-stream' });
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    expect((await f.rpc(key.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: true, clientInfo: true })).body.error.code).toBe(-32602);
    expect((await f.rpc(key.token, 'ping', { oversized: 'a'.repeat(150001) })).response.status).toBe(413);
  });

  it('reads saved response IDs containing the API separator through both the typed tool and allowlisted paths', async () => {
    const f = await setup(), key = await f.mint('owner', 'alpha');
    const scanner = new Scanner({ ...f.runtime, provider: new FixtureProvider(f.now), now: f.now });
    await scanner.handle({ kind: 'kickoff', projectId: 'alpha', scheduledAt: START.toISOString(), trigger: 'manual' });
    while (f.runtime.queue.messages.length) await scanner.handle(f.runtime.queue.messages.shift()!);
    const responseId = (await f.repository.listResults('alpha', (await f.repository.listRuns('alpha'))[0].id))[0].responseId;
    expect(responseId).toContain('~');
    const typed = await f.tool(key.token, 'response', { responseId });
    expect(toolData(typed)).toMatchObject({ result: { responseId }, answer: { model: 'demo-fixture' } });
    const generic = await f.tool(key.token, 'api_get', { path: `/v1/projects/alpha/responses/${responseId}` });
    expect(toolData(generic)).toMatchObject({ result: { responseId } });
    expect((await f.tool(key.token, 'response', { responseId: '../beta' })).body.error.code).toBe(-32602);
  });
});

describe('MCP URL-only connections', () => {
  async function queryRpc(f: Awaited<ReturnType<typeof setup>>, token: string, options: {
    path?: string; workspace?: string; method?: string; params?: Record<string, unknown>;
    headers?: Record<string, string>; extraQuery?: [string, string][];
  } = {}) {
    const url = new URL(options.path || '/mcp', 'https://api.test');
    url.searchParams.set('mcp_token', token);
    if (options.workspace !== undefined) url.searchParams.set('workspace_id', options.workspace);
    for (const [name, value] of options.extraQuery || []) url.searchParams.append(name, value);
    const response = await f.app(new Request(url, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: options.method || 'tools/call', params: options.params || { name: 'list_accounts', arguments: {} } }),
    }));
    return { response, body: await response.json() };
  }

  it('initializes and calls tools using only a generated URL, with one global or account scope', async () => {
    const f = await setup(), global = await f.mint('admin'), account = await f.mint('owner', 'alpha');
    const initialized = await queryRpc(f, global.token, { method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'url-only-client', version: '1' } } });
    expect(initialized.body.result.serverInfo.name).toBe('citevia');
    expect((await queryRpc(f, global.token, { method: 'tools/list' })).body.result.tools.some((tool: { name: string }) => tool.name === 'list_accounts')).toBe(true);
    expect(toolData(await queryRpc(f, global.token)).items.map((item: { id: string }) => item.id).sort()).toEqual(['alpha', 'beta']);
    expect(toolData(await queryRpc(f, account.token, { path: '/mcp/accounts/alpha', workspace: 'alpha' })).items.map((item: { id: string }) => item.id)).toEqual(['alpha']);
    // Matches iGEO's generic endpoint + workspace query convention as well.
    expect(toolData(await queryRpc(f, account.token, { workspace: 'alpha' })).items.map((item: { id: string }) => item.id)).toEqual(['alpha']);
    expect(toolData(await queryRpc(f, global.token, { params: { name: 'settings', arguments: { accountId: 'beta' } } })).id).toBe('beta');
  });

  it('does not allow account URLs, query parameters or tool arguments to change credential scope', async () => {
    const f = await setup(), account = await f.mint('owner', 'alpha'), global = await f.mint('admin');
    for (const options of [
      { workspace: 'beta' }, { path: '/mcp/accounts/beta', workspace: 'alpha' },
      { workspace: 'beta', headers: { 'X-Workspace-Id': 'alpha' } },
      { workspace: 'alpha', headers: { 'X-Workspace-Id': 'beta' } }, { workspace: '' },
    ]) expect((await queryRpc(f, account.token, options)).response.status).toBe(403);
    expect((await queryRpc(f, global.token, { workspace: 'alpha' })).response.status).toBe(403);
    expect((await queryRpc(f, account.token, { params: { name: 'settings', arguments: { accountId: 'beta' } } })).body.result.isError).toBe(true);
    expect((await queryRpc(f, account.token, { extraQuery: [['workspace_id', 'alpha'], ['workspace_id', 'beta']] })).response.status).toBe(400);
  });

  it('prioritizes the Authorization header and rejects duplicate query credentials without fallback', async () => {
    const f = await setup(), alpha = await f.mint('owner', 'alpha'), beta = await f.mint('owner', 'beta');
    const header = await queryRpc(f, beta.token, { headers: { Authorization: `Bearer ${alpha.token}` } });
    expect(toolData(header).items[0].id).toBe('alpha');
    for (const Authorization of ['Bearer invalid', 'Basic invalid', ''])
      expect((await queryRpc(f, alpha.token, { headers: { Authorization } })).response.status).toBe(401);
    expect((await queryRpc(f, alpha.token, { extraQuery: [['mcp_token', beta.token]] })).response.status).toBe(400);
    expect((await queryRpc(f, 'x'.repeat(2001))).response.status).toBe(401);
  });

  it('keeps OAuth access and Descope session tokens out of URL authentication and credential management', async () => {
    const f = await setup(), key = await f.mint('admin');
    const connection = (await f.repository.getMcpConnection(key.connection.id))!;
    await f.repository.createMcpConnection({ ...connection, id: 'oauth-url-test', kind: 'oauth', tokenHash: mcpHash('unusable-oauth-backing-secret') });
    await f.repository.putMcpRecord({ kind: 'access', id: mcpHash('test-oauth-access'), expiresAt: new Date(START.getTime() + 3600000).toISOString(), data: { connectionId: 'oauth-url-test', resource: 'https://api.test/mcp' } });
    expect((await f.rpc('test-oauth-access', 'ping')).response.status).toBe(200);
    for (const token of ['test-oauth-access', 'unusable-oauth-backing-secret', 'session:admin'])
      expect((await queryRpc(f, token)).response.status).toBe(401);
    for (const path of ['/v1/mcp/connections', '/v1/admin/users', '/v1/me'])
      expect((await f.app(new Request(`https://api.test${path}?mcp_token=${key.token}`))).status).toBe(401);
  });

  it('applies viewer access, current membership, revocation and expiry to URL credentials', async () => {
    const f = await setup(), viewer = await f.mint('viewer', 'alpha'), account = await f.mint('owner', 'alpha'), global = await f.mint('admin', undefined, 30);
    const write = await queryRpc(f, viewer.token, { params: { name: 'create_prompt', arguments: { body: { text: 'No viewer writes' } } } });
    expect(write.body.error.code).toBe(-32602);
    expect((await f.request(`/v1/mcp/connections/${viewer.connection.id}`, 'session:viewer', 'DELETE')).status).toBe(204);
    expect((await queryRpc(f, viewer.token)).response.status).toBe(401);
    const owner = (await f.repository.getUser('owner'))!;
    await f.repository.setUserAccount('admin', owner.id, 'alpha', null, owner.version);
    expect((await queryRpc(f, account.token)).response.status).toBe(403);
    f.setNow(new Date(START.getTime() + 30 * 86400000));
    expect((await queryRpc(f, global.token)).response.status).toBe(401);
  });

  it('never returns query credentials in responses, discovery challenges or audit logs', async () => {
    const f = await setup(), key = await f.mint('admin');
    const success = await queryRpc(f, key.token, { method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'safe-client', version: '1' } } });
    expect(JSON.stringify(success.body)).not.toContain(key.token);
    expect(success.response.headers.get('cache-control')).toBe('no-store');
    expect(success.response.headers.get('referrer-policy')).toBe('no-referrer');
    const unknown = await queryRpc(f, 'citevia_live_unknown-secret');
    expect(unknown.response.status).toBe(401);
    expect(unknown.response.headers.get('www-authenticate')).not.toContain('mcp_token');
    expect((await queryRpc(f, key.token, { headers: { Origin: 'https://evil.test' } })).response.status).toBe(403);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).not.toContain(key.token);
    expect(logs).not.toContain('citevia_live_unknown-secret');
    expect(logs).not.toContain('mcp_token');
  });
});
