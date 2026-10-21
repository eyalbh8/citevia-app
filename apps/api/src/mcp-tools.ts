import { z } from 'zod';
import { identifier, JOURNEY_STAGES, PROMPT_INTENTS, SCAN_PROVIDERS, type VerifiedIdentity } from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
import type { McpPrincipal } from './mcp.js';

type Tool = {
  name: string; description: string; method: 'GET' | 'POST' | 'PATCH';
  path: string; id?: string; body?: boolean; idempotent?: boolean; system?: boolean;
};
const definitions: Tool[] = [
  { name: 'dashboard', description: 'Read visibility, sentiment, rank and changes from the account dashboard. Optional query: providers (comma-separated), days (1/7/14/30/90/custom), start and end (YYYY-MM-DD for custom), topic, region, tag, branded, intent, stage.', method: 'GET', path: 'dashboard/overview' },
  { name: 'prompts', description: 'List tracked prompts, including archived prompts and version metadata.', method: 'GET', path: 'prompts' },
  { name: 'prompt_metrics', description: 'Read prompt visibility, sentiment and rank over a period. Optional query: provider, days (1/7/14/30/90/custom), start and end (YYYY-MM-DD for custom), or runId for a single scan.', method: 'GET', path: 'prompt-metrics' },
  { name: 'prompt_responses', description: 'Read paginated original answers for a prompt. Optional query: provider, days, sort, direction, limit, cursor.', method: 'GET', path: 'prompts/{promptId}/responses', id: 'promptId' },
  { name: 'mentions', description: 'Read account mentions. Optional query: providers (comma-separated), days (1/7/14/30/90/custom), start, end, page (zero-based), pageSize (25/50/100), sort, direction.', method: 'GET', path: 'mentions' },
  { name: 'sources', description: 'Read citation sources for a scan. Optional query: runId, provider, groupBy (domain/url), kind (cited/consulted), domain, limit, cursor.', method: 'GET', path: 'sources' },
  { name: 'source_responses', description: 'Read answers citing a source. Use a sourceId from sources. Optional query: runId, provider, limit, cursor.', method: 'GET', path: 'sources/{sourceId}/responses', id: 'sourceId' },
  { name: 'responses', description: 'Read paginated results for a scan. Optional query: runId, provider, mentioned, limit, cursor.', method: 'GET', path: 'responses' },
  { name: 'response', description: 'Read the complete original answer and analysis using a responseId from responses.', method: 'GET', path: 'responses/{responseId}', id: 'responseId' },
  { name: 'runs', description: 'List scan runs and their completion status. Optional query: provider, limit, cursor.', method: 'GET', path: 'runs' },
  { name: 'run', description: 'Read one scan run.', method: 'GET', path: 'runs/{runId}', id: 'runId' },
  { name: 'brandbook', description: 'Read the brand identity, audience, voice and research evidence. Includes current version for edits.', method: 'GET', path: 'brandbook' },
  { name: 'settings', description: 'Read account settings and version, including competitors and scan providers.', method: 'GET', path: 'settings' },
  { name: 'competitor_suggestions', description: 'Find competitor suggestions in already saved answers. Makes no provider calls.', method: 'GET', path: 'competitors/suggestions' },
  { name: 'tracked_urls', description: 'List tracked content URLs with citation measurements. Optional query: providers (comma-separated), days (1/7/14/30/90/custom), start, end, page (zero-based), pageSize (25/50/100), q, status, sort.', method: 'GET', path: 'tracked-urls' },
  { name: 'tracking_summary', description: 'Read tracked-content coverage and trends.', method: 'GET', path: 'tracked-urls/summary' },
  { name: 'tracked_url_answers', description: 'Read answers citing a tracked URL.', method: 'GET', path: 'tracked-urls/{trackedUrlId}/answers', id: 'trackedUrlId' },
  { name: 'onboarding_status', description: 'Read account setup progress.', method: 'GET', path: 'onboarding' },
  { name: 'create_prompt', description: 'Create a tracked prompt. body: text or texts (required), topic, stage (understand/prefer/trust/convert), intent, seoKeyword, tags. Branded classification is computed automatically. Existing prompt quotas apply.', method: 'POST', path: 'prompts', body: true },
  { name: 'update_prompt', description: 'Edit or archive a prompt. body: version (current prompt version), text, active, topic, stage (understand/prefer/trust/convert), intent, seoKeyword, tags. Set active=false to archive and preserve historical answers.', method: 'PATCH', path: 'prompts/{promptId}', id: 'promptId', body: true },
  { name: 'update_brandbook', description: 'Update brand identity. Read brandbook first; body must include its current account version and permitted brandbook fields.', method: 'PATCH', path: 'brandbook', body: true },
  { name: 'update_settings', description: 'Update account settings, competitors or scanning schedule. Read settings first; body must include current version. Existing schema and permission checks apply.', method: 'PATCH', path: 'settings', body: true },
  { name: 'track_url', description: 'Register a content URL for citation tracking. body: url (required). Title and publication timestamp are initialized by the server.', method: 'POST', path: 'tracked-urls', body: true },
  { name: 'update_tracked_url', description: 'Update tracked content metadata or archive it. Read tracked_urls first; body includes version (required), title and active.', method: 'PATCH', path: 'tracked-urls/{trackedUrlId}', id: 'trackedUrlId', body: true },
  { name: 'run_scan', description: 'Start a scan across enabled providers. This makes billable provider calls. Only run when explicitly requested. Reuse idempotencyKey when retrying the same request.', method: 'POST', path: 'runs', idempotent: true },
  { name: 'onboard_accounts', description: 'Create new accounts and start research, prompts and scans (billable provider calls). System connection only; use when explicitly requested. body: accounts array of name, region (two-letter uppercase country), language and website (public URL). Reuse idempotencyKey on retry.', method: 'POST', path: '/v1/onboarding/accounts', body: true, idempotent: true, system: true },
];
export const mcpRoutes = ['/v1/projects', ...definitions.filter(d => d.method === 'GET').map(d => `/v1/projects/{accountId}/${d.path}`)];
const querySchema = z.record(z.union([z.string().max(2000), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 30);
const queryJson = { type: 'object', description: 'Optional REST query parameters. Most lists use limit and cursor/nextCursor. Monitoring lists (mentions, tracked_urls) use page (zero-based), pageSize (25/50/100), and total.', additionalProperties: { type: ['string', 'number', 'boolean'] } };
const idJson = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', minLength: 1, maxLength: 100 };
const responseId = z.string().regex(/^[A-Za-z0-9_-]{1,100}~[A-Za-z0-9_-]{1,100}$/);
const responseIdJson = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}~[A-Za-z0-9_-]{1,100}$', maxLength: 201 };
const textField = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringList = (maxItems = 30, maxLength = 1000) => ({ type: 'array', items: textField(maxLength, 1), maxItems });
const positiveVersion = { type: 'integer', minimum: 1 };
const promptFields = {
  text: textField(2000, 3), topic: textField(120),
  stage: { type: 'string', enum: JOURNEY_STAGES }, intent: { type: 'string', enum: PROMPT_INTENTS },
  seoKeyword: textField(160), tags: stringList(10, 60),
};
const brand = objectSchema({ id: idJson, name: textField(120, 1), aliases: stringList(20, 120), domains: stringList(10, 253) }, ['id', 'name', 'aliases', 'domains']);
const publicUrl = { ...textField(2048), format: 'uri', description: 'Public HTTP(S) website URL without credentials or a custom port.' };
const brandbookFields = {
  version: positiveVersion, about: textField(10000, 20), industryCategory: textField(300), subIndustryCategory: textField(300),
  names: stringList(20, 120), keyFeatures: stringList(), toneOfVoice: stringList(), values: stringList(), personality: stringList(),
  targetAudience: stringList(), knowledgeSources: { type: 'array', items: publicUrl, maxItems: 30 },
  sitemapUrl: { anyOf: [publicUrl, { type: 'null' }] }, caseStudiesSourceUrl: { anyOf: [publicUrl, { type: 'null' }] },
  postGuidelines: objectSchema({ dos: stringList(), donts: stringList() }, ['dos', 'donts']),
  evidence: { type: 'array', maxItems: 50, items: objectSchema({ field: textField(100), quote: textField(2000, 1), url: publicUrl }, ['field', 'quote', 'url']) },
  unknowns: stringList(),
};
const writeBodies: Record<string, unknown> = {
  create_prompt: { ...objectSchema({ ...promptFields, texts: { type: 'array', items: textField(2000, 3), minItems: 1, maxItems: 50 } }), oneOf: [{ required: ['text'] }, { required: ['texts'] }] },
  update_prompt: objectSchema({ ...promptFields, version: positiveVersion, active: { type: 'boolean' } }),
  update_brandbook: objectSchema(brandbookFields, Object.keys(brandbookFields)),
  update_settings: objectSchema({
    version: positiveVersion, name: textField(120, 1), brand, competitors: { type: 'array', items: brand, maxItems: 5 },
    country: { type: 'string', pattern: '^[A-Z]{2}$' }, language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' },
    timezone: { ...textField(100), description: 'IANA time zone, for example Asia/Nicosia.' }, enabled: { type: 'boolean' },
    scanProviders: { type: 'array', minItems: 1, maxItems: 3, items: objectSchema({
      provider: { type: 'string', enum: SCAN_PROVIDERS }, model: { ...textField(160, 1), pattern: '^[A-Za-z0-9_.:@/-]+$' },
    }, ['provider', 'model']) },
  }, ['version']),
  track_url: objectSchema({ url: textField(2048, 1) }, ['url']),
  update_tracked_url: objectSchema({ version: positiveVersion, title: textField(200, 1), active: { type: 'boolean' } }, ['version']),
  onboard_accounts: objectSchema({ accounts: { type: 'array', minItems: 1, maxItems: 25, items: objectSchema({
    name: textField(100, 1), website: publicUrl, region: { type: 'string', pattern: '^[A-Z]{2}$' },
    language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' },
  }, ['name', 'website', 'region', 'language']) } }, ['accounts']),
};
const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: write });

export function mcpTools(principal: McpPrincipal) {
  const system = principal.connection.projectId === null;
  const account = { ...idJson, description: system ? 'Account ID returned by list_accounts.' : 'Optional. Must match the connected account.' };
  const tools = definitions.filter(d => (!d.system || system) && (d.method === 'GET' || principal.role === 'owner')).map(d => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (!d.system) { properties.accountId = account; if (system) required.push('accountId'); }
    if (d.id) { properties[d.id] = d.id === 'responseId' ? responseIdJson : idJson; required.push(d.id); }
    if (d.method === 'GET') properties.query = queryJson;
    if (d.body) { properties.body = writeBodies[d.name]; required.push('body'); }
    if (d.idempotent) { properties.idempotencyKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$', description: 'Unique request identifier. Keep the same value when retrying.' }; required.push('idempotencyKey'); }
    return { name: d.name, description: d.description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: annotations(d.method !== 'GET') };
  });
  return [
    { name: 'list_accounts', description: system ? 'List all accounts accessible through this system administrator connection. Follow nextCursor for more accounts.' : 'Show the single account bound to this connection.', inputSchema: { type: 'object', properties: { query: queryJson }, additionalProperties: false }, annotations: annotations(false) },
    { name: 'allowed_routes', description: 'Discover the explicit read API routes allowed through this connection.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: annotations(false) },
    { name: 'api_get', description: 'Read an allowlisted API path from allowed_routes. Pass a full /v1/projects/accountId/... path. Only the connected account is accessible for account connections. No external URLs or administrative APIs.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: queryJson }, required: ['path'], additionalProperties: false }, annotations: annotations(false) },
    ...tools,
  ];
}

export async function callMcpTool(
  name: string, raw: unknown, principal: McpPrincipal, runtime: Runtime,
  api: (request: Request, identity?: VerifiedIdentity) => Promise<Response>,
) {
  const content = (data: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });
  const scoped = (accountId: string) => {
    identifier.parse(accountId);
    if (principal.connection.projectId !== null && accountId !== principal.connection.projectId)
      throw new AccessError(403, 'ACCOUNT_MISMATCH', 'This connection cannot access another account.');
    return accountId;
  };
  let path: string, method = 'GET', body: unknown, query: z.infer<typeof querySchema> | undefined, idempotencyKey: string | undefined;
  if (name === 'allowed_routes') { z.object({}).strict().parse(raw); return content({ routes: mcpRoutes }); }
  if (name === 'list_accounts') {
    ({ query } = z.object({ query: querySchema.optional() }).strict().parse(raw));
    if (principal.connection.projectId !== null) {
      const project = await runtime.repository.getProject(principal.connection.projectId);
      return content({ items: project ? [{ id: project.id, name: project.name, brand: project.brand, role: principal.role }] : [], total: project ? 1 : 0, nextCursor: null });
    }
    path = '/v1/projects';
  } else if (name === 'api_get') {
    ({ path, query } = z.object({ path: z.string().max(500), query: querySchema.optional() }).strict().parse(raw));
    // Reject encoded separators, normalization tricks and absolute URLs before dispatch.
    const parts = path.split('/');
    if (parts[0] !== '' || parts[1] !== 'v1' || parts[2] !== 'projects' || parts.some(p => p === '.' || p === '..') || /[%?#\\]/.test(path))
      throw new AccessError(403, 'ROUTE_DENIED', 'Use a route returned by allowed_routes.');
    if (path === '/v1/projects') {
      if (principal.connection.projectId !== null) return callMcpTool('list_accounts', { query }, principal, runtime, api);
    } else {
      scoped(parts[3]);
      const tail = parts.slice(4).join('/');
      const allowed = definitions.some(d => d.method === 'GET' && new RegExp(`^${d.path.replace(/\{(\w+)\}/g, (_, field: string) => field === 'responseId' ? '[A-Za-z0-9_-]{1,100}~[A-Za-z0-9_-]{1,100}' : '[A-Za-z0-9_-]{1,100}')}$`).test(tail));
      if (!allowed) throw new AccessError(403, 'ROUTE_DENIED', 'This API route is not exposed through MCP.');
    }
  } else {
    const definition = definitions.find(d => d.name === name);
    if (!definition || (definition.system && principal.connection.projectId !== null))
      throw new AccessError(403, 'TOOL_DENIED', 'This tool is unavailable.');
    if (definition.method !== 'GET' && principal.role !== 'owner')
      throw new AccessError(403, 'FORBIDDEN', 'Account owner access is required.');
    const shape: z.ZodRawShape = {};
    if (!definition.system) shape.accountId = principal.connection.projectId === null ? identifier : identifier.optional();
    if (definition.id) shape[definition.id] = definition.id === 'responseId' ? responseId : identifier;
    if (definition.method === 'GET') shape.query = querySchema.optional();
    if (definition.body) shape.body = z.record(z.unknown());
    if (definition.idempotent) shape.idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
    const args = z.object(shape).strict().parse(raw);
    path = definition.system ? definition.path : `/v1/projects/${scoped(String(args.accountId ?? principal.connection.projectId))}/${definition.path}`;
    if (definition.id) path = path.replace(`{${definition.id}}`, encodeURIComponent(String(args[definition.id])));
    method = definition.method; body = args.body; query = args.query as typeof query; idempotencyKey = args.idempotencyKey as string | undefined;
  }
  const url = new URL(path, 'https://citevia.internal');
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const user = principal.user;
  const result = await api(new Request(url, { method, headers: {
    'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {
    provider: 'descope', subject: user.subject, externalUserId: user.descopeUserId,
    email: user.email, emailVerified: true, name: user.name, lastName: user.lastName,
  });
  const text = await result.text();
  if (Buffer.byteLength(text) > 2_000_000)
    throw new AccessError(413, 'RESULT_TOO_LARGE', 'Result is too large. Use a smaller limit, narrower date range or a detail tool.');
  return { content: [{ type: 'text', text: text || '{}' }], ...(result.ok ? {} : { isError: true }) };
}
