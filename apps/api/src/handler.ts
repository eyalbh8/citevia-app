import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createAwsRuntime } from '@citevia/storage';
import { createApi } from './app.js';
import { syncProjectSchedule } from './scheduler.js';

let app: ReturnType<typeof createApi> | undefined;
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  app ||= createApi(createAwsRuntime(),{auth:'aws',mode:'live',syncSchedule:syncProjectSchedule});
  const headers=new Headers();Object.entries(event.headers||{}).forEach(([key,value])=>{if(value)headers.set(key,value);});
  const method=event.requestContext.http.method;
  const request=new Request(`https://citevia.internal${event.rawPath}${event.rawQueryString?`?${event.rawQueryString}`:''}`,{method,headers,...(!['GET','HEAD'].includes(method)&&event.body?{body:event.isBase64Encoded?Buffer.from(event.body,'base64').toString('utf8'):event.body}:{})});
  const sub=event.requestContext.authorizer?.jwt?.claims?.sub;
  const result=await app(request,typeof sub==='string'?{userId:sub}:undefined);
  return {statusCode:result.status,headers:Object.fromEntries(result.headers),body:await result.text()};
}
