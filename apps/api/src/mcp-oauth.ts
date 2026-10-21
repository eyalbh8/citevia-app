import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { identifier, type User } from '@citevia/core';
import { AccessError, type McpConnection, type McpRecord, type Runtime } from '@citevia/storage';
import { authenticationFailure, AuthenticationError, type IdentityProvider } from './descope.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
class OAuthError extends Error {
  constructor(public code: string, public status = 400, public description?: string) { super(code); }
}
type Client = {
  clientId: string;
  name: string;
  redirectUris: string[];
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  secretHash?: string;
};
type Authorization = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  projectId: string | null;
  state?: string;
};

/** OAuth grants persist in the shared repository; no process-local sessions or token secrets. */
export function createMcpOAuth(
  runtime: Runtime,
  identityProvider: IdentityProvider,
  config: { publicUrl: string; frontendUrl: string; now?: () => Date },
) {
  const { repository } = runtime;
  const now = config.now ?? (() => new Date());
  const base = config.publicUrl.replace(/\/+$/, '');
  const frontend = new URL(config.frontendUrl);
  const expiry = (ms: number) => new Date(now().getTime() + ms).toISOString();
  const live = (record: McpRecord | null): record is McpRecord =>
    !!record && (!record.expiresAt || record.expiresAt > now().toISOString());
  const string = (value: unknown, max = 2048) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
  const required = (value: unknown, max = 2048) => {
    const found = string(value, max);
    if (!found) throw new OAuthError('invalid_request');
    return found;
  };
  const resourceProject = (resource: string): string | null => {
    if (resource === `${base}/mcp`) return null;
    const prefix = `${base}/mcp/accounts/`;
    if (resource.startsWith(prefix)) {
      const projectId = resource.slice(prefix.length);
      if (identifier.safeParse(projectId).success) return projectId;
    }
    throw new OAuthError('invalid_target');
  };
  const allowedRedirect = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return !url.hash && !url.username && !url.password && (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
      );
    } catch { return false; }
  };
  async function limit(bucket: string, count: number) {
    const window = new Date(Math.floor(now().getTime() / MINUTE) * MINUTE).toISOString();
    if (!await repository.limitMcpRequests(`oauth:${bucket}`, window, count))
      throw new OAuthError('temporarily_unavailable', 429);
  }
  async function readBody(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) throw new OAuthError('invalid_request');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 32768) {
        await reader.cancel();
        throw new OAuthError('invalid_request', 413);
      }
      chunks.push(chunk.value);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    const type = request.headers.get('content-type')?.split(';')[0].trim();
    if (type === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(content);
      for (const key of params.keys())
        if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
      return Object.fromEntries(params);
    }
    if (type !== 'application/json') throw new OAuthError('invalid_request');
    try {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new OAuthError('invalid_request'); }
  }
  async function clientFor(id: string): Promise<Client> {
    const record = await repository.getMcpRecord('client', id);
    if (!live(record)) throw new OAuthError('invalid_client');
    return record.data as Client;
  }
  async function pending(requestId: string): Promise<McpRecord & { data: Authorization }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(requestId)) throw new OAuthError('invalid_request');
    const record = await repository.getMcpRecord('consent', hash(requestId));
    if (!live(record)) throw new OAuthError('invalid_request');
    return record as McpRecord & { data: Authorization };
  }
  async function eligible(user: User, projectId: string | null) {
    if (user.disabled) throw new OAuthError('access_denied', 403);
    if (projectId === null) {
      if (!user.isSystemAdmin) throw new OAuthError('access_denied', 403);
      return null;
    }
    const project = await repository.getProject(projectId);
    if (!project || (!user.isSystemAdmin && !await repository.getMembership(projectId, user.subject)))
      throw new OAuthError('access_denied', 403);
    return project;
  }
  async function validConnection(id: string): Promise<McpConnection> {
    const connection = await repository.getMcpConnection(id);
    if (!connection || connection.kind !== 'oauth' || connection.revokedAt ||
      (connection.expiresAt && connection.expiresAt <= now().toISOString()))
      throw new OAuthError('invalid_grant');
    const user = await repository.getUser(connection.userId);
    if (!user || user.disabled) throw new OAuthError('invalid_grant');
    try { await eligible(user, connection.projectId); }
    catch { throw new OAuthError('invalid_grant'); }
    return connection;
  }
  function redirect(authorization: Authorization, result: Record<string, string>) {
    const url = new URL(authorization.redirectUri);
    for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
    if (authorization.state !== undefined) url.searchParams.set('state', authorization.state);
    return url.toString();
  }
  async function issueTokens(connection: McpConnection, clientId: string, resource: string) {
    const access = opaque(), refresh = opaque();
    const end = connection.expiresAt ? new Date(connection.expiresAt).getTime() : Infinity;
    const accessExpiresAt = new Date(Math.min(now().getTime() + 60 * MINUTE, end)).toISOString();
    const refreshExpiresAt = new Date(Math.min(now().getTime() + 30 * DAY, end)).toISOString();
    const data = { connectionId: connection.id, clientId, resource };
    await repository.putMcpRecord({ id: hash(access), kind: 'access', data, expiresAt: accessExpiresAt });
    await repository.putMcpRecord({ id: hash(refresh), kind: 'refresh', data, expiresAt: refreshExpiresAt });
    return json({
      access_token: access, token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((Date.parse(accessExpiresAt) - now().getTime()) / 1000)),
      refresh_token: refresh, scope: 'mcp',
    });
  }
  async function register(request: Request) {
    await limit('register', 30);
    const body = await readBody(request);
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 ||
      !redirects.every(allowedRedirect)) throw new OAuthError('invalid_client_metadata');
    const authMethod = body.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(String(authMethod)))
      throw new OAuthError('invalid_client_metadata');
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) ||
      body.grant_types.some(grant => !['authorization_code', 'refresh_token'].includes(grant))))
      throw new OAuthError('invalid_client_metadata');
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) ||
      body.response_types.length !== 1 || body.response_types[0] !== 'code'))
      throw new OAuthError('invalid_client_metadata');
    if (body.scope !== undefined && body.scope !== 'mcp') throw new OAuthError('invalid_scope');
    if (body.client_name !== undefined && !string(body.client_name, 128))
      throw new OAuthError('invalid_client_metadata');
    const clientId = `citevia_${opaque()}`;
    const secret = authMethod === 'none' ? undefined : opaque();
    const client: Client = {
      clientId, name: string(body.client_name, 128)?.trim() || 'MCP client',
      redirectUris: [...new Set(redirects)], authMethod: authMethod as Client['authMethod'],
      ...(secret ? { secretHash: hash(`${clientId}:${secret}`) } : {}),
    };
    await repository.putMcpRecord({ id: clientId, kind: 'client', data: { ...client }, expiresAt: null });
    return json({
      client_id: clientId, client_name: client.name, redirect_uris: client.redirectUris,
      token_endpoint_auth_method: authMethod, grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: 'mcp', client_id_issued_at: Math.floor(now().getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }, 201);
  }
  async function authorize(url: URL) {
    await limit('authorize', 120);
    const params = url.searchParams;
    for (const key of params.keys())
      if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
    if (params.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type');
    if (params.has('scope') && params.get('scope') !== 'mcp') throw new OAuthError('invalid_scope');
    const clientId = required(params.get('client_id'), 128);
    const client = await clientFor(clientId);
    const redirectUri = required(params.get('redirect_uri'));
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request');
    const challenge = required(params.get('code_challenge'), 128);
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new OAuthError('invalid_request');
    const resource = required(params.get('resource'));
    const projectId = resourceProject(resource);
    const state = params.has('state') ? params.get('state')! : undefined;
    if (state !== undefined && state.length > 2048) throw new OAuthError('invalid_request');
    const data: Authorization = { clientId, redirectUri, challenge, resource, projectId,
      ...(state !== undefined ? { state } : {}) };
    const requestId = opaque();
    await repository.putMcpRecord({ id: hash(requestId), kind: 'consent', data: { ...data }, expiresAt: expiry(10 * MINUTE) });
    const destination = new URL(frontend);
    destination.searchParams.set('mcp_authorize', requestId);
    return new Response(null, { status: 302, headers: {
      Location: destination.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    } });
  }
  async function consent(request: Request, url: URL) {
    const origin = request.headers.get('origin');
    if (origin && origin !== frontend.origin) throw new OAuthError('access_denied', 403);
    if (!request.headers.get('authorization')?.match(/^Bearer [^\s]+$/i))
      throw new AuthenticationError(401, 'UNAUTHENTICATED', 'Sign in to connect your MCP client.');
    const identity = await identityProvider.authenticate(request);
    const user = await repository.syncUser(identity, true);
    if (user.disabled) throw new OAuthError('access_denied', 403);
    await limit(`consent:${user.subject}`, 60);
    const body = request.method === 'POST' ? await readBody(request) : {};
    const requestId = required(request.method === 'POST' ? body.requestId : url.searchParams.get('requestId'), 128);
    const record = await pending(requestId);
    const authorization = record.data;
    const client = await clientFor(authorization.clientId);
    let projectId = authorization.projectId;
    if (user.isSystemAdmin && projectId !== null)
      throw new OAuthError('access_denied', 403,
        `System administrators connect all accounts. Restart the connection using ${base}/mcp.`);
    if (projectId !== null) await eligible(user, projectId);
    const projects = user.isSystemAdmin || projectId !== null ? [] :
      (await repository.listProjects(user.subject)).map(project => ({ id: project.id, name: project.name, role: project.role ?? 'viewer' }));
    if (!user.isSystemAdmin && projectId === null && projects.length === 0)
      throw new OAuthError('access_denied', 403);
    if (request.method === 'GET') {
      const project = projectId ? await repository.getProject(projectId) : null;
      return json({ clientName: client.name,
        scope: user.isSystemAdmin && projectId === null ? 'system' : 'account',
        projectId, projectName: project?.name ?? null, projects, expiresAt: record.expiresAt });
    }
    if (typeof body.approve !== 'boolean') throw new OAuthError('invalid_request');
    if (body.approve) {
      if (projectId === null && !user.isSystemAdmin)
        projectId = required(body.projectId, 100);
      if (body.projectId !== undefined && body.projectId !== projectId)
        throw new OAuthError('access_denied', 403);
      await eligible(user, projectId);
    }
    if (!await repository.consumeMcpRecord('consent', record.id, now().toISOString()))
      throw new OAuthError('invalid_request');
    if (!body.approve) return json({ redirectUrl: redirect(authorization, { error: 'access_denied' }) });
    const code = opaque();
    await repository.putMcpRecord({ id: hash(code), kind: 'code', expiresAt: expiry(5 * MINUTE),
      data: { ...authorization, projectId, userId: user.subject } });
    return json({ redirectUrl: redirect(authorization, { code }) });
  }
  async function authenticateClient(request: Request, body: Record<string, unknown>) {
    let clientId = string(body.client_id, 128), secret = string(body.client_secret, 128);
    const authorization = request.headers.get('authorization');
    let basic = false;
    if (authorization) {
      const encoded = authorization.match(/^Basic ([A-Za-z0-9+/]+=*)$/i)?.[1];
      if (!encoded || body.client_secret !== undefined) throw new OAuthError('invalid_client', 401);
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const split = decoded.indexOf(':');
        if (split < 1) throw new Error();
        const id = decodeURIComponent(decoded.slice(0, split));
        if (clientId && clientId !== id) throw new Error();
        clientId = id;
        secret = decodeURIComponent(decoded.slice(split + 1));
        basic = true;
      } catch { throw new OAuthError('invalid_client', 401); }
    }
    const client = await clientFor(required(clientId, 128));
    if (client.authMethod === 'none') {
      if (basic || secret) throw new OAuthError('invalid_client', 401);
    } else if (!secret || basic !== (client.authMethod === 'client_secret_basic') ||
      !client.secretHash || !equal(hash(`${client.clientId}:${secret}`), client.secretHash))
      throw new OAuthError('invalid_client', 401);
    return client;
  }
  async function rejectRefreshReuse(record: McpRecord) {
    if (record.data.consumed !== true) return;
    const connection = typeof record.data.connectionId === 'string' ?
      await repository.getMcpConnection(record.data.connectionId) : null;
    if (connection?.kind === 'oauth')
      await repository.revokeMcpConnection(connection.id, connection.userId, now().toISOString());
    throw new OAuthError('invalid_grant');
  }
  async function token(request: Request) {
    await limit('token', 240);
    const body = await readBody(request);
    const client = await authenticateClient(request, body);
    const resource = required(body.resource);
    resourceProject(resource);
    if (body.scope !== undefined && body.scope !== 'mcp') throw new OAuthError('invalid_scope');
    if (body.grant_type === 'refresh_token') {
      const refresh = required(body.refresh_token, 128);
      const record = await repository.getMcpRecord('refresh', hash(refresh));
      if (!live(record) || record.data.clientId !== client.clientId || record.data.resource !== resource)
        throw new OAuthError('invalid_grant');
      await rejectRefreshReuse(record);
      const connection = await validConnection(required(record.data.connectionId, 128));
      if (!await repository.consumeMcpRecord('refresh', record.id, now().toISOString())) {
        const consumed = await repository.getMcpRecord('refresh', record.id);
        if (consumed) await rejectRefreshReuse(consumed);
        throw new OAuthError('invalid_grant');
      }
      return issueTokens(connection, client.clientId, resource);
    }
    if (body.grant_type !== 'authorization_code') throw new OAuthError('unsupported_grant_type');
    const code = required(body.code, 128), verifier = required(body.code_verifier, 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant');
    const record = await repository.getMcpRecord('code', hash(code));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!live(record) || record.data.clientId !== client.clientId || record.data.resource !== resource ||
      record.data.redirectUri !== body.redirect_uri || typeof record.data.challenge !== 'string' ||
      !equal(challenge, record.data.challenge)) throw new OAuthError('invalid_grant');
    const user = await repository.getUser(required(record.data.userId, 500));
    const projectId = typeof record.data.projectId === 'string' ? record.data.projectId : null;
    if (!user || user.disabled) throw new OAuthError('invalid_grant');
    if (user.isSystemAdmin && projectId !== null) throw new OAuthError('invalid_grant');
    try { await eligible(user, projectId); }
    catch { throw new OAuthError('invalid_grant'); }
    if (!await repository.consumeMcpRecord('code', record.id, now().toISOString()))
      throw new OAuthError('invalid_grant');
    const connection: McpConnection = {
      id: randomUUID(), userId: user.subject, projectId,
      name: `${client.name} (OAuth)`.slice(0, 128), kind: 'oauth',
      tokenHash: hash(opaque()), keyPrefix: 'OAuth',
      createdAt: now().toISOString(), expiresAt: expiry(90 * DAY), lastUsedAt: null, revokedAt: null,
    };
    await repository.createMcpConnection(connection);
    return issueTokens(connection, client.clientId, resource);
  }
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url), path = url.pathname;
    const metadataPrefix = '/.well-known/oauth-protected-resource';
    const isProtectedMetadata = path === metadataPrefix || path === `${metadataPrefix}/mcp` ||
      path.startsWith(`${metadataPrefix}/mcp/accounts/`);
    const known = isProtectedMetadata || [
      '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize',
      '/oauth/token', '/v1/mcp/oauth/consent',
    ].includes(path);
    if (!known) return null;
    try {
      if (request.method === 'GET' && isProtectedMetadata) {
        const resource = `${base}${path === metadataPrefix ? '/mcp' : path.slice(metadataPrefix.length)}`;
        resourceProject(resource);
        return json({ resource, authorization_servers: [base], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] });
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server')
        return json({
          issuer: base, authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        });
      if (path === '/oauth/register' && request.method === 'POST') return await register(request);
      if (path === '/oauth/authorize' && request.method === 'GET') return await authorize(url);
      if (path === '/oauth/token' && request.method === 'POST') return await token(request);
      if (path === '/v1/mcp/oauth/consent' && ['GET', 'POST'].includes(request.method))
        return await consent(request, url);
      return json({ error: 'invalid_request' }, 405);
    } catch (error) {
      if (error instanceof AuthenticationError) return authenticationFailure(error);
      if (error instanceof AccessError) return json({ error: 'access_denied' }, error.status);
      if (error instanceof OAuthError) {
        const description = error.description ?? (error.code === 'invalid_request'
          ? 'This connection request is invalid or has expired. Restart the connection from your assistant.'
          : 'This connection cannot access the requested account with your current permissions.');
        const result = path === '/v1/mcp/oauth/consent'
          ? { error: { code: error.code, message: description } }
          : { error: error.code, ...(error.description ? { error_description: error.description } : {}) };
        return json(result, error.status, error.status === 429 ? { 'Retry-After': '60' } : {});
      }
      return json({ error: 'server_error' }, 500);
    }
  };
}
