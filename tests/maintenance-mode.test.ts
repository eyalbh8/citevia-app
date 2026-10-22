import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, SQSEvent } from 'aws-lambda';

const cloud = vi.hoisted(() => ({
  runtime: vi.fn(), identity: vi.fn(), database: vi.fn(() => ({})), migrate: vi.fn(),
}));
vi.mock('@citevia/storage', async (load) => ({
  ...await load<typeof import('@citevia/storage')>(),
  createAwsRuntime: cloud.runtime,
  productionDatabase: cloud.database,
  migrateDatabase: cloud.migrate,
}));
vi.mock('../apps/api/src/descope.js', async (load) => ({
  ...await load<typeof import('../apps/api/src/descope.js')>(),
  createDescopeIdentityProvider: cloud.identity,
}));

import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAuthenticatedApi, handler as apiHandler } from '../apps/api/src/handler.js';
import { createHandler, handler as scannerHandler } from '../apps/scanner/src/handler.js';
import type { Scanner } from '../apps/scanner/src/engine.js';

const origin = 'https://app.example';
function apiEvent(path: string, method = 'GET', requestOrigin = origin): APIGatewayProxyEventV2 {
  return {
    version:'2.0',routeKey:'ANY /{proxy+}',rawPath:path,rawQueryString:'',
    headers:{Origin:requestOrigin},isBase64Encoded:false,
    requestContext:{
      accountId:'test-account',apiId:'test-api',domainName:'api.example',domainPrefix:'api',requestId:'request-1',
      routeKey:'ANY /{proxy+}',stage:'$default',time:'22/Oct/2026:12:00:00 +0000',timeEpoch:1792670400000,
      http:{method,path,protocol:'HTTP/1.1',sourceIp:'127.0.0.1',userAgent:'test'},
    },
    body:method==='POST'?'deliberately invalid JSON':undefined,
  };
}
const queued = {
  Records:[
    {messageId:'source-job',body:'invalid JSON',eventSourceARN:'source-arn'},
    {messageId:'dead-letter-job',body:'{}',eventSourceARN:'dlq-arn'},
  ],
} as SQSEvent;
const failures = {batchItemFailures:[{itemIdentifier:'source-job'},{itemIdentifier:'dead-letter-job'}]};
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('production database maintenance freeze', () => {
  it('returns honest API503 responses before initializing runtime/auth, including health and public writers', async () => {
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','true');
    vi.stubEnv('ALLOWED_ORIGIN',origin);
    for (const [path,method] of [
      ['/health','GET'],['/v1/traffic/collect','POST'],['/mcp/token','POST'],
      ['/v1/projects/example','POST'],['/v1/me','OPTIONS'],
    ]) {
      const response=await apiHandler(apiEvent(path,method));
      expect(response).toMatchObject({statusCode:503,headers:{
        'retry-after':'60','cache-control':'no-store','access-control-allow-origin':origin,
        'access-control-expose-headers':'Retry-After',
      }});
      expect(JSON.parse(response.body!)).toMatchObject({maintenance:true,error:{code:'MAINTENANCE_MODE'}});
    }
    const blocked=await apiHandler(apiEvent('/health','GET','https://untrusted.example'));
    expect(blocked.headers).not.toHaveProperty('access-control-allow-origin');
    expect(cloud.runtime).not.toHaveBeenCalled();
    expect(cloud.identity).not.toHaveBeenCalled();
    expect(cloud.database).not.toHaveBeenCalled();
  });
  it('checks maintenance on a cached API and resumes the same application after it is disabled', async () => {
    const repository=new MemoryRepository();
    const sync=vi.spyOn(repository,'syncUser');
    const traffic=vi.spyOn(repository,'recordTrafficInstallation');
    const authenticate=vi.fn();
    cloud.runtime.mockReturnValue({repository,artifacts:new MemoryArtifacts(),queue:new MemoryQueue()});
    cloud.identity.mockReturnValue({authenticate,lookup:vi.fn()});
    vi.stubEnv('ALLOWED_ORIGIN',origin);
    vi.stubEnv('MCP_PUBLIC_URL','https://api.example');
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','false');
    expect((await apiHandler(apiEvent('/health'))).statusCode).toBe(200);
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','true');
    expect((await apiHandler(apiEvent('/v1/traffic/collect','POST'))).statusCode).toBe(503);
    expect((await apiHandler(apiEvent('/health'))).statusCode).toBe(503);
    expect(cloud.runtime).toHaveBeenCalledOnce();
    expect(authenticate).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(traffic).not.toHaveBeenCalled();
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','false');
    expect((await apiHandler(apiEvent('/health'))).statusCode).toBe(200);
    expect(cloud.runtime).toHaveBeenCalledOnce();
  });
  it('guards a previously constructed authenticated API before traffic, authentication or MCP grants can write', async () => {
    const repository=new MemoryRepository();
    const sync=vi.spyOn(repository,'syncUser');
    const traffic=vi.spyOn(repository,'recordTrafficInstallation');
    const limits=vi.spyOn(repository,'limitMcpRequests');
    const authenticate=vi.fn();
    const app=createAuthenticatedApi(
      {repository,artifacts:new MemoryArtifacts(),queue:new MemoryQueue()},
      {authenticate,lookup:vi.fn()},
      {mode:'live',mcp:{publicUrl:'https://api.example',frontendUrl:origin}},
    );
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','true');
    for (const path of ['/v1/traffic/collect','/mcp/token','/v1/me']) {
      const response=await app(new Request(`https://api.example${path}`,{method:'POST',headers:{origin},body:'bad JSON'}));
      expect(response.status).toBe(503);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    expect(sync).not.toHaveBeenCalled();
    expect(traffic).not.toHaveBeenCalled();
    expect(limits).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('preserves every queued job and blocks all direct scanner writer paths before runtime/database initialization', async () => {
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','true');
    expect(await scannerHandler(queued)).toEqual(failures);
    for (const event of [
      {kind:'reconcile'},
      {kind:'kickoff',projectId:'p',scheduledAt:'2026-10-22T12:00:00Z'},
      {kind:'database:migrate'},
      {kind:'prompts:refresh',projectId:'p',requestId:'refresh-1'},
      {kind:'scan:reanalyze',projectId:'p',runId:'r',requestId:'reanalyze-1'},
      {kind:'users:bootstrap-admin',userId:'00000000-0000-4000-8000-000000000000'},
    ] as const) expect(await scannerHandler(event)).toEqual({maintenance:true});
    expect(cloud.runtime).not.toHaveBeenCalled();
    expect(cloud.database).not.toHaveBeenCalled();
    expect(cloud.migrate).not.toHaveBeenCalled();
  });
  it('pauses an existing scanner adapter without acknowledging SQS work, then resumes when maintenance is off', async () => {
    const engine={handle:vi.fn(),handleDeadLetter:vi.fn()} as unknown as Scanner;
    const handle=createHandler(engine,'dlq-arn');
    expect(await handle({kind:'reconcile'})).toEqual({ok:true});
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','true');
    expect(await handle(queued)).toEqual(failures);
    expect(await handle({kind:'reconcile'})).toEqual({maintenance:true});
    expect(engine.handle).toHaveBeenCalledOnce();
    expect(engine.handleDeadLetter).not.toHaveBeenCalled();
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','false');
    expect(await handle({kind:'reconcile'})).toEqual({ok:true});
    expect(engine.handle).toHaveBeenCalledTimes(2);
  });
  it('keeps the direct IAM migration interface available only after the source freeze has been lifted', async () => {
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE','false');
    expect(await scannerHandler({kind:'database:migrate'})).toEqual({migrated:true});
    expect(cloud.database).toHaveBeenCalledOnce();
    expect(cloud.migrate).toHaveBeenCalledOnce();
  });
});
