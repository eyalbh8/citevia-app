import { publicTrafficRoute } from './traffic.js';
import { trafficCountry } from './traffic-geo.js';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { createAwsRuntime, type Runtime } from '@citevia/storage';
import { createApi, type ApiOptions } from './app.js';
import { createMcp, type McpConfig } from './mcp.js';
import { syncProjectSchedule } from './scheduler.js';
import { providerAvailability } from '../../scanner/src/provider-http.js';
import {
  authenticationFailure,
  createDescopeIdentityProvider,
  type IdentityProvider,
} from './descope.js';

/** Checked per request so a cached application cannot bypass a cutover freeze. */
function maintenanceResponse(origin: string | null, frontendOrigin = process.env.ALLOWED_ORIGIN): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '60',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin && frontendOrigin && origin === frontendOrigin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  return new Response(JSON.stringify({
    maintenance: true,
    error: { code: 'MAINTENANCE_MODE', message: 'Database maintenance is in progress. Please retry shortly.' },
  }), { status: 503, headers });
}

export function createAuthenticatedApi(
  runtime: Runtime,
  identity: IdentityProvider,
  options: ApiOptions & { mcp?: McpConfig },
) {
  const app = createApi(runtime, {
    ...options,
    lookupUser: (email) => identity.lookup(email),
  });
  if (!options.mcp && process.env.AWS_LAMBDA_FUNCTION_NAME && (!process.env.MCP_PUBLIC_URL || !process.env.ALLOWED_ORIGIN))
    throw new Error('Configure MCP_PUBLIC_URL and ALLOWED_ORIGIN for the public MCP endpoint.');
  const mcpConfig: McpConfig = options.mcp || {
    publicUrl: process.env.MCP_PUBLIC_URL || 'http://127.0.0.1:3001',
    frontendUrl: process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173',
    allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    now: options.now,
  };
  for (const name of ['publicUrl', 'frontendUrl'] as const) {
    const url = new URL(mcpConfig[name]);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
      throw new Error(`MCP ${name} must be an HTTPS origin (HTTP loopback is allowed locally).`);
    mcpConfig[name] = url.origin;
  }
  const mcp = createMcp(runtime, identity, mcpConfig, app);
  return async (request: Request, sourceIp?: string): Promise<Response> => {
    if (process.env.CITEVIA_MAINTENANCE_MODE === 'true')
      return maintenanceResponse(request.headers.get('origin'), mcpConfig.frontendUrl);
    const traffic = await publicTrafficRoute(runtime, request, (options.now || (() => new Date()))(), () => trafficCountry(sourceIp));
    if (traffic) return traffic;
    const mcpResponse = await mcp(request);
    if (mcpResponse) {
      mcpResponse.headers.set('Cache-Control', 'no-store');
      mcpResponse.headers.set('Referrer-Policy', 'no-referrer');
      const origin = request.headers.get('origin');
      if (origin && [mcpConfig.frontendUrl, mcpConfig.publicUrl, ...(mcpConfig.allowedOrigins || [])].includes(origin)) {
        mcpResponse.headers.set('Access-Control-Allow-Origin', origin);
        mcpResponse.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After');
        mcpResponse.headers.set('Vary', 'Origin');
      }
      return mcpResponse;
    }
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204 });
    if (new URL(request.url).pathname === '/health' && request.method === 'GET')
      return app(request);
    try {
      return await app(request, await identity.authenticate(request));
    } catch (error) {
      return authenticationFailure(error);
    }
  };
}
let app: ReturnType<typeof createAuthenticatedApi> | undefined;
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Stop before constructing runtime/auth clients, including health and public tracker writes.
  if (process.env.CITEVIA_MAINTENANCE_MODE === 'true') {
    const origin = Object.entries(event.headers || {}).find(([name]) => name.toLowerCase() === 'origin')?.[1] || null;
    const response = maintenanceResponse(origin);
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }
  app ||= createAuthenticatedApi(
    createAwsRuntime(),
    createDescopeIdentityProvider(),
    {
      mode: 'live',
      mcp: {
        // API Gateway supplies this context; never use client Host/Forwarded headers.
        // Referencing HttpApi in the function environment would create a SAM cycle.
        publicUrl: process.env.MCP_PUBLIC_URL || `https://${event.requestContext.domainName}`,
        frontendUrl: process.env.ALLOWED_ORIGIN || '',
        allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
      },
      syncSchedule: syncProjectSchedule,
      providerAvailability: providerAvailability(),
    },
  );
  const headers = new Headers();
  Object.entries(event.headers || {}).forEach(([key, value]) => {
    if (value) headers.set(key, value);
  });
  const method = event.requestContext.http.method;
  const request = new Request(
    `https://citevia.internal${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`,
    {
      method,
      headers,
      ...(!['GET', 'HEAD'].includes(method) && event.body
        ? {
            body: event.isBase64Encoded
              ? Buffer.from(event.body, 'base64').toString('utf8')
              : event.body,
          }
        : {}),
    },
  );
  const result = await app(request, event.requestContext.http.sourceIp);
  return {
    statusCode: result.status,
    headers: Object.fromEntries(result.headers),
    body: await result.text(),
  };
}
