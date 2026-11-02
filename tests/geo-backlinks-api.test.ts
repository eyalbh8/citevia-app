import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEO_BACKLINK_SETTINGS, type Project } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';
const now='2026-11-02T10:00:00.000Z';
async function fixture(enabled=true) {
  const repository=new MemoryRepository(),queue=new MemoryQueue(),artifacts=new MemoryArtifacts();
  const admin=await repository.syncUser(testIdentity('geo-admin'));await repository.bootstrapAdmin(admin.id);
  for(const user of ['geo-owner','geo-viewer','geo-outsider']) await repository.syncUser(testIdentity(user));
  const project:Project={...newProject({id:randomUUID(),now:new Date('2026-09-01T00:00:00Z')}),geoBacklinks:{...DEFAULT_GEO_BACKLINK_SETTINGS,enabled}};
  await repository.saveProject(project,null);
  await repository.putMembership({projectId:project.id,userId:'geo-owner',role:'owner'});
  await repository.putMembership({projectId:project.id,userId:'geo-viewer',role:'viewer'});
  const runtime={repository,queue,artifacts},api=createApi(runtime,{mode:'live',now:()=>new Date(now)});
  const call=(suffix='/geo-backlinks/reports',method='GET',data?:unknown,user:string|null='geo-admin',projectId=project.id)=>api(new Request(`https://citevia.test/v1/projects/${projectId}${suffix}`,{
    method,headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),
  }),user?testIdentity(user):undefined);
  return {repository,queue,project,runtime,call};
}
const historical=(overrides:Record<string,unknown>={})=>({domain:'www.publisher.co.uk',articleUrl:'https://news.publisher.co.uk/guide',recommendedAt:'2026-10-15T12:00:00.000Z',priority:'P2',status:'recommended',...overrides});
async function imported(f:Awaited<ReturnType<typeof fixture>>,overrides:Record<string,unknown>={}) {
  expect((await f.call('/geo-backlinks/history/import','POST',{items:[historical(overrides)]})).status).toBe(200);
  return (await f.repository.listGeoBacklinkRecommendations(f.project.id)).items[0];
}

describe('GEO backlink system administrator API',()=>{
  it('requires authentication and system administrator access across read and write endpoints',async()=>{
    const f=await fixture();
    const endpoints:[string,string,unknown?][]=[['/geo-backlinks/reports','GET'],['/geo-backlinks/reports','POST',{month:'2026-11'}],
      ['/geo-backlinks/reports/2026-11','GET'],['/geo-backlinks/recommendations','GET'],['/geo-backlinks/candidates','GET'],
      ['/geo-backlinks/progress','GET'],['/geo-backlinks/progress/refresh','POST',{}],['/geo-backlinks/history/import','POST',{items:[historical()]}]];
    for(const [path,method,data] of endpoints) {
      expect((await f.call(path,method,data,'geo-owner')).status,`${method} ${path}`).toBe(403);
      expect((await f.call(path,method,data,'geo-viewer')).status).toBe(403);
      expect((await f.call(path,method,data,'geo-outsider')).status).toBe(404);
      expect((await f.call(path,method,data,null)).status).toBe(401);
    }
    expect(f.queue.messages).toEqual([]);
  });
  it('defaults to disabled and only the administrator can opt in from settings',async()=>{
    const f=await fixture(false),settings={...DEFAULT_GEO_BACKLINK_SETTINGS,enabled:true};
    expect((await f.call()).status).toBe(403);
    expect((await f.call('/geo-backlinks/reports','POST',{month:'2026-11'})).status).toBe(403);
    expect((await f.call('/settings','PATCH',{version:1,geoBacklinks:settings},'geo-owner')).status).toBe(403);
    expect((await f.repository.getProject(f.project.id))?.geoBacklinks?.enabled).toBe(false);
    const saved=await f.call('/settings','PATCH',{version:1,geoBacklinks:settings});expect(saved.status).toBe(200);
    const project=(await f.repository.getProject(f.project.id))!;
    expect(project.geoBacklinks?.enabled).toBe(true);expect(project.geoBacklinks?.enabledAt).toBe(now);
    expect(project.enabled).toBe(f.project.enabled);expect(project.scheduleExpression).toBe(f.project.scheduleExpression);
    expect((await f.call()).status).toBe(200);
    expect((await f.call('/settings','PATCH',{version:project.version,geoBacklinks:{...settings,exclusionDays:179}})).status).toBe(400);
    expect((await f.call('/settings','PATCH',{version:project.version,geoBacklinks:{...settings,target:0}})).status).toBe(400);
  });
  it('uses the independent feature toggle while AI scanning is paused',async()=>{
    const f=await fixture();
    await f.repository.saveProject({...f.project,enabled:false,version:2},1);
    expect((await f.call('/geo-backlinks/reports','POST',{month:'2026-11'})).status).toBe(202);
    expect((await f.repository.listGeoBacklinkProjects(0,100)).items.map(p=>p.id)).toContain(f.project.id);
    expect(f.queue.messages.every(message=>message.kind==='geo-backlinks')).toBe(true);
  });
  it('queues one monthly identity, returns original completed cohort, and rejects invalid months',async()=>{
    const f=await fixture();
    const first=await f.call('/geo-backlinks/reports','POST',{month:'2026-11'});expect(first.status).toBe(202);
    const {report}=await first.json();
    expect(new Intl.DateTimeFormat('en-GB',{timeZone:f.project.timezone,month:'2-digit'}).format(new Date(report.analysisStart))).toBe('10');expect(report.month).toBe('2026-11');
    expect((await (await f.call('/geo-backlinks/reports','POST',{month:'2026-11'})).json()).report.id).toBe(report.id);
    const claimed=(await f.repository.claimGeoBacklinkReport(f.project.id,'2026-11','private-worker-token',now,'2026-11-02T10:06:00.000Z'))!;
    const running=await (await f.call('/geo-backlinks/reports/2026-11')).json();expect(running.report).not.toHaveProperty('leaseToken');expect(running.report).not.toHaveProperty('leaseUntil');
    await f.repository.commitGeoBacklinkReport({report:{...claimed,status:'insufficient_data'},leaseToken:'private-worker-token',candidates:[],recommendations:[],exclusionDays:180,now});
    const queued=f.queue.messages.length;
    const retry=await f.call('/geo-backlinks/reports','POST',{month:'2026-11'});expect(retry.status).toBe(200);
    expect((await retry.json()).report).toMatchObject({id:report.id,status:'insufficient_data',selectedRecommendationIds:[]});
    expect(f.queue.messages).toHaveLength(queued);
    expect((await f.repository.listGeoBacklinkReports(f.project.id,0,25)).total).toBe(1);
    for(const month of ['2026-12','2026-13','2026-00','bad']) expect((await f.call('/geo-backlinks/reports','POST',{month})).status).toBe(400);
    expect((await f.call('/geo-backlinks/reports','POST',{month:'2026-11',replace:true})).status).toBe(400);
    expect(f.queue.messages.every(message=>message.kind==='geo-backlinks')).toBe(true);
  });
  it('imports canonical domains with actual dates once, rejects unsafe or mismatched history',async()=>{
    const f=await fixture(),item=await imported(f);
    expect(item.domain).toBe('publisher.co.uk');expect(item.recommendedAt).toBe('2026-10-15T12:00:00.000Z');
    expect((await (await f.call('/geo-backlinks/history/import','POST',{items:[historical()]})).json()).imported).toBe(0);
    expect((await f.repository.listGeoBacklinkLedger(f.project.id))[0].eligibleAgainAt).toBe('2027-04-13T12:00:00.000Z');
    for(const changes of [{domain:'different.com'},{recommendedAt:'2026-12-01T00:00:00Z'},{articleUrl:'http://127.0.0.1/private'},{articleUrl:'https://user:password@publisher.co.uk/'},{recommendedAt:'not-a-date'}])
      expect((await f.call('/geo-backlinks/history/import','POST',{items:[historical(changes)]})).status).toBe(400);
    expect((await f.repository.listGeoBacklinkRecommendations(f.project.id)).total).toBe(1);
  });
  it('isolates recommendations and validates audited publication/status changes with CAS',async()=>{
    const f=await fixture(),item=await imported(f),path=`/geo-backlinks/recommendations/${item.id}`;
    const other={...newProject({id:randomUUID()}),geoBacklinks:{...DEFAULT_GEO_BACKLINK_SETTINGS,enabled:true}};await f.repository.saveProject(other,null);
    expect((await f.call(path,'GET',undefined,'geo-admin',other.id)).status).toBe(404);
    expect((await f.call(path,'PATCH',{version:1,status:'approved'},'geo-owner')).status).toBe(403);
    expect((await f.call(path,'PATCH',{version:1,status:'published'})).status).toBe(400);
    expect((await f.call(path,'PATCH',{version:1,publishedAt:'2026-12-01T00:00:00Z'})).status).toBe(400);
    expect((await f.call(path,'PATCH',{version:1,cost:100})).status).toBe(400);
    expect((await f.call(path,'PATCH',{version:1,ownerId:'nonexistent-user'})).status).toBe(400);
    const published=await f.call(path,'PATCH',{version:1,status:'published',publishedAt:'2026-11-01T09:00:00Z',publishedUrl:'https://publisher.co.uk/updated-guide',landingPage:'https://northstar.com/',linkType:'sponsored',cost:100,currency:'USD',notes:'Disclosed placement approved.',ownerId:'geo-owner'});
    expect(published.status).toBe(200);expect((await published.json()).recommendation).toMatchObject({version:2,status:'published',finalDomain:'publisher.co.uk',notes:'Disclosed placement approved.'});
    expect((await f.call(path,'PATCH',{version:1,notes:'Stale overwrite'})).status).toBe(409);
    const detail=await (await f.call(path)).json();expect(detail.activityTotal).toBe(2);
    expect(detail.activities.find((activity:{action:string})=>activity.action==='updated')).toMatchObject({actorId:'geo-admin',action:'updated',toStatus:'published',changes:{status:{from:'recommended',to:'published'},finalDomain:{from:null,to:'publisher.co.uk'}}});
    expect(detail.recommendation.recommendedAt).toBe(item.recommendedAt);expect(detail.recommendation.eligibleAgainAt).toBe(item.eligibleAgainAt);
    expect(f.queue.messages).toEqual(Array.from({length:2},()=>({kind:'geo-backlinks-progress',projectId:f.project.id,date:'2026-11-02'})));
  });
  it('serves persisted progress without aggregating scans in the API and marks explicit refresh pending',async()=>{
    const f=await fixture(),path=`geo-backlinks/${f.project.id}/progress-summary`;
    const readScans=vi.spyOn(f.repository,'listPromptHistory');
    const empty=await f.call('/geo-backlinks/progress');expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({months:[],placements:[],pending:true,evaluatedAt:null});
    expect(f.queue.messages).toEqual([{kind:'geo-backlinks-progress',projectId:f.project.id,date:'2026-11-02'}]);
    expect(readScans).not.toHaveBeenCalled();
    const cached={evaluatedAt:'2026-11-02T09:00:00.000Z',pending:false,months:[{month:'2026-10',recommendationCount:3}],placements:[],comparablePromptCount:5,caveat:'Observed correlation only.'};
    await f.runtime.artifacts.put(path,cached);
    await f.runtime.artifacts.put('geo-backlinks/another-account/progress-summary',{...cached,comparablePromptCount:999});
    expect(await (await f.call('/geo-backlinks/progress')).json()).toEqual(cached);
    expect(f.queue.messages).toHaveLength(1);expect(readScans).not.toHaveBeenCalled();
    const refreshed=await f.call('/geo-backlinks/progress/refresh','POST',{});expect(refreshed.status).toBe(202);expect(await refreshed.json()).toEqual({queued:true});
    expect(await f.runtime.artifacts.get(path)).toEqual({...cached,pending:true});
    expect(await (await f.call('/geo-backlinks/progress')).json()).toEqual({...cached,pending:true});
    expect(f.queue.messages).toEqual(Array.from({length:2},()=>({kind:'geo-backlinks-progress',projectId:f.project.id,date:'2026-11-02'})));
    expect(readScans).not.toHaveBeenCalled();
  });
  it('audits automatically populated contact dates and refreshes saved progress after lifecycle edits',async()=>{
    const f=await fixture(),item=await imported(f),path=`/geo-backlinks/recommendations/${item.id}`;
    const progressKey=`geo-backlinks/${f.project.id}/progress-summary`;
    await f.runtime.artifacts.put(progressKey,{pending:false,months:[],placements:[]});
    const response=await f.call(path,'PATCH',{version:1,status:'outreach_sent'});expect(response.status).toBe(200);
    expect((await response.json()).recommendation.contactedAt).toBe(now);
    const detail=await (await f.call(path)).json();
    expect(detail.activities.find((activity:{action:string})=>activity.action==='updated')).toMatchObject({changes:{status:{from:'recommended',to:'outreach_sent'},contactedAt:{from:null,to:now}}});
    expect(await f.runtime.artifacts.get(progressKey)).toMatchObject({pending:true});
    expect((await f.call(path,'PATCH',{version:2,notes:'Waiting for the editor.'})).status).toBe(200);
    expect(f.queue.messages).toHaveLength(3);
    expect(f.queue.messages.every(message=>message.kind==='geo-backlinks-progress')).toBe(true);
  });
  it('provides bounded paginated history, search and deterministic filtering',async()=>{
    const f=await fixture();
    await f.call('/geo-backlinks/history/import','POST',{items:[historical(),historical({domain:'second.com',articleUrl:'https://second.com/article',priority:'P4',status:'rejected'}),historical({domain:'third.com',articleUrl:'https://third.com/article',priority:'P1',recommendedAt:'2026-10-16T00:00:00Z'})]});
    const first=await (await f.call('/geo-backlinks/recommendations?limit=1&sort=domain&direction=asc')).json();expect(first.total).toBe(3);expect(first.items[0].domain).toBe('publisher.co.uk');
    const second=await (await f.call('/geo-backlinks/recommendations?limit=1&offset=1&sort=domain&direction=asc')).json();expect(second.items[0].domain).toBe('second.com');
    const filtered=await (await f.call('/geo-backlinks/recommendations?priority=P4&status=rejected&q=second&month=2026-10')).json();expect(filtered.total).toBe(1);
    for(const query of ['limit=101','offset=-1','provider=other','priority=P5','sort=untrusted']) expect((await f.call(`/geo-backlinks/recommendations?${query}`)).status).toBe(400);
    expect(await (await f.call('/geo-backlinks/progress')).json()).toMatchObject({months:[],placements:[],pending:true,evaluatedAt:null});
  });
});
