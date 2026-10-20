import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { createAwsRuntime, type Runtime } from '@citevia/storage';
import { createApi, type ApiOptions } from './app.js';
import { syncProjectSchedule } from './scheduler.js';
import {
  authenticationFailure,
  createDescopeIdentityProvider,
  type IdentityProvider,
} from './descope.js';

export function createAuthenticatedApi(
  runtime: Runtime,
  identity: IdentityProvider,
  options: ApiOptions,
) {
  const app = createApi(runtime, {
    ...options,
    lookupUser: (email) => identity.lookup(email),
  });
  return async (request: Request): Promise<Response> => {
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
  app ||= createAuthenticatedApi(
    createAwsRuntime(),
    createDescopeIdentityProvider(),
    { mode: 'live', syncSchedule: syncProjectSchedule },
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
  const result = await app(request);
  return {
    statusCode: result.status,
    headers: Object.fromEntries(result.headers),
    body: await result.text(),
  };
}
