import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEO_BACKLINK_SETTINGS, unknownGeoBacklinkArticle, type Analysis, type CapturedAnswer, type PromptResult, type ScanRun } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { GeoBacklinkEngine, importedGeoRecommendation, geoObservations } from '../apps/scanner/src/geo-backlinks.js';
import { parseScanMessage } from '../apps/scanner/src/handler.js';
import { newProject } from './fixtures/scanner.js';
const now = new Date('2026-11-02T06:00:00.000Z');
async function setup() {
  const project={...newProject({id:'geo-account',domain:'northstar.com',prompts:['Best analytics for companies in the United States'],now:new Date('2026-09-01T00:00:00Z')}),timezone:'UTC',geoBacklinks:{...DEFAULT_GEO_BACKLINK_SETTINGS,enabled:true}};
  project.prompts[0].topic='analytics';
  const repository=new MemoryRepository(),artifacts=new MemoryArtifacts(),queue=new MemoryQueue();
  await repository.saveProject(project,null);
  const runtime={repository,artifacts,queue};
  let clock=now;
  const verifier={verify:vi.fn(async (_project:typeof project,url:string)=>unknownGeoBacklinkArticle(url,'Unavailable in this test'))};
  const engine=new GeoBacklinkEngine(runtime,verifier,()=>clock);
  async function scan(id:string,at:string,provider:'openai'|'gemini'|'perplexity'='openai',url='https://publisher.com/analytics',status:ScanRun['status']='completed') {
    const run:ScanRun={projectId:project.id,id,groupId:id,status,createdAt:at,scheduledAt:at,startedAt:at,completedAt:at,trigger:'scheduled',
      snapshot:{...project,projectName:project.name,configVersion:1,provider},totalCount:1,terminalCount:1,succeededCount:1,capturedCount:1,resultVersion:1,deadlineAt:at,expiresAt:0};
    const result:PromptResult={projectId:project.id,runId:id,promptId:project.prompts[0].id,prompt:project.prompts[0],responseId:`response-${id}`,status:'succeeded',version:1,attempts:1,
      captureKey:`captures/${id}`,analysisKey:`analyses/${id}`,citationCount:2,sourceCount:1,capturedAt:at,completedAt:at,expiresAt:0};
    const citations=[1,2].map(index=>({id:`c${index}`,url,blockId:'b',title:'Analytics guide',start:0,end:20}));
    const answer:CapturedAnswer={provider,providerResponseId:id,model:'test',status:'completed',blocks:[{id:'b',text:'Independent advice.'}],text:'Independent advice.',citations,sources:[],createdAt:at,usage:{inputTokens:0,outputTokens:0,totalTokens:0},raw:{}};
    const analysis:Analysis={brands:[{brandId:project.brand.id,mentioned:false,explicitRank:null,mentionOrder:null,sentiment:'not_applicable',evidence:[],rankEvidence:null,sentimentEvidence:null}],model:'test',parserVersion:'test',createdAt:at,usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
    await repository.createRun(run,[result]);
    await artifacts.put(result.captureKey!,answer); await artifacts.put(result.analysisKey!,analysis);
    return {run,result,answer,analysis};
  }
  return {project,runtime,repository,queue,artifacts,engine,verifier,scan,setNow:(at:string)=>{clock=new Date(at);}};
}
describe('monthly GEO service integration',()=>{
  it('hydrates all providers, excludes incomplete scans, and de-duplicates native citations without paid calls',async()=>{
    const f=await setup();
    await f.scan('openai-one','2026-10-03T12:00:00Z');
    const gemini=await f.scan('gemini-two','2026-10-17T12:00:00Z','gemini');
    await f.repository.saveMeasurement(gemini.result,gemini.run,gemini.answer,gemini.analysis);
    await f.scan('perplexity-three','2026-10-21T12:00:00Z','perplexity');
    await f.scan('partial','2026-10-20T12:00:00Z','openai','https://wrong.com/article','partial');
    await f.scan('november','2026-11-01T12:00:00Z','openai','https://future.com/article');
    const observations=await geoObservations(f.runtime,f.project,'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');
    expect(observations).toHaveLength(3);
    expect(observations.every(item=>item.citations.length===1)).toBe(true);
    await f.engine.handle(f.project.id,'2026-11');
    const report=await f.repository.getGeoBacklinkReport(f.project.id,'2026-11');
    expect(report).toMatchObject({status:'completed',scanCount:3,answerCount:3,candidateCount:1});
    const recommendations=await f.repository.listGeoBacklinkRecommendations(f.project.id);
    expect(recommendations.items).toHaveLength(1);
    expect(recommendations.items[0].candidate?.evidence).toMatchObject({providers:['gemini','openai','perplexity'],distinctScans:3,citationConsistency:100,article:{brandPresence:'unknown'}});
    expect(f.queue.messages).toEqual([{kind:'geo-backlinks-progress',projectId:f.project.id,date:'2026-11-02'}]);
  });
  it('keeps one original monthly cohort after simultaneous delivery, subsequent evidence, and manual retry',async()=>{
    const f=await setup();await f.scan('a','2026-10-03T12:00:00Z');await f.scan('b','2026-10-15T12:00:00Z');
    await Promise.all([f.engine.handle(f.project.id,'2026-11'),f.engine.handle(f.project.id,'2026-11')]);
    const original=await f.repository.getGeoBacklinkReport(f.project.id,'2026-11');
    await f.scan('late','2026-10-26T12:00:00Z','openai','https://anotherpublisher.com/article');
    await f.engine.handle(f.project.id,'2026-11');
    expect(await f.repository.getGeoBacklinkReport(f.project.id,'2026-11')).toEqual(original);
    expect((await f.repository.listGeoBacklinkRecommendations(f.project.id)).total).toBe(1);
  });
  it('imports original dates before selection and keeps excluded candidates in the backlog',async()=>{
    const f=await setup();await f.scan('a','2026-10-03T12:00:00Z');await f.scan('b','2026-10-15T12:00:00Z');
    vi.spyOn(f.repository,'listLegacyGeoBacklinkHistory').mockResolvedValue([{id:'legacy-1',url:'https://news.publisher.com/old',recommendedAt:'2026-10-01T12:00:00Z',source:'recommendations:backlink'}]);
    await f.engine.handle(f.project.id,'2026-11');
    expect((await f.repository.getGeoBacklinkReport(f.project.id,'2026-11'))?.selectedRecommendationIds).toEqual([]);
    expect((await f.repository.listGeoBacklinkRecommendations(f.project.id)).items[0]).toMatchObject({imported:true,recommendedAt:'2026-10-01T12:00:00.000Z'});
    expect((await f.repository.listGeoBacklinkCandidates(f.project.id)).total).toBe(1);
  });
  it('records insufficient data without fake recommendations',async()=>{
    const f=await setup();await f.scan('single','2026-10-03T12:00:00Z');
    await f.engine.handle(f.project.id,'2026-11');
    expect(await f.repository.getGeoBacklinkReport(f.project.id,'2026-11')).toMatchObject({status:'insufficient_data',selectedRecommendationIds:[]});
    expect((await f.repository.listGeoBacklinkRecommendations(f.project.id)).total).toBe(0);
  });
  it('does nothing while disabled and recovers an interrupted generation lease',async()=>{
    const f=await setup();
    await f.repository.saveProject({...f.project,geoBacklinks:{...f.project.geoBacklinks,enabled:false},version:2},1);
    await f.engine.handle(f.project.id,'2026-11');expect(await f.repository.getGeoBacklinkReport(f.project.id,'2026-11')).toBeNull();
    await f.repository.saveProject({...f.project,version:3},2);
    await f.scan('a','2026-10-03T12:00:00Z');await f.scan('b','2026-10-15T12:00:00Z');
    f.verifier.verify.mockRejectedValueOnce(new Error('Interrupted worker'));
    await expect(f.engine.handle(f.project.id,'2026-11')).rejects.toThrow('Interrupted worker');
    expect((await f.repository.getGeoBacklinkReport(f.project.id,'2026-11'))?.status).toBe('failed');
    await f.engine.handle(f.project.id,'2026-11');
    expect((await f.repository.listGeoBacklinkRecommendations(f.project.id)).total).toBe(1);
  });
  it('schedules at the account local first-day 06:00 and recovers missed queue delivery',async()=>{
    const f=await setup();
    await f.repository.saveProject({...f.project,timezone:'Asia/Nicosia',version:2},1);
    f.setNow('2026-11-01T03:59:59Z');await f.engine.reconcile();
    expect(f.queue.messages.filter(m=>m.kind==='geo-backlinks')).toHaveLength(0);
    f.setNow('2026-11-01T04:00:00Z');await f.engine.reconcile();
    expect(f.queue.messages.some(m=>m.kind==='geo-backlinks' && m.month==='2026-11')).toBe(true);
    f.queue.messages.splice(0);await f.engine.reconcile();
    expect(f.queue.messages.some(m=>m.kind==='geo-backlinks')).toBe(true);
    await f.engine.handle(f.project.id,'2026-11');f.queue.messages.splice(0);await f.engine.reconcile();
    expect(f.queue.messages.some(m=>m.kind==='geo-backlinks')).toBe(false);
  });
  it('uses publication dates for checkpoints and never passes post-publication article content off as baseline evidence',async()=>{
    const f=await setup();
    const imported=importedGeoRecommendation(f.project,{domain:'publisher.com',articleUrl:'https://publisher.com/analytics',recommendedAt:'2026-10-01T00:00:00Z',priority:'P4',status:'recommended'},now);
    await f.repository.importGeoBacklinkHistory(f.project.id,[imported],'admin',now.toISOString());
    const published={...imported,status:'published' as const,publishedAt:'2026-10-02T12:00:00.000Z',publishedUrl:imported.url,finalDomain:imported.domain,version:2};
    await f.repository.saveGeoBacklinkRecommendation(published,1,{id:'activity',projectId:f.project.id,recommendationId:imported.id,actorId:'admin',at:now.toISOString(),action:'updated',fromStatus:'recommended',toStatus:'published',changes:{}});
    await f.scan('baseline','2026-09-20T12:00:00Z');await f.scan('after','2026-10-17T12:00:00Z');
    await f.engine.progress(f.project.id,'2026-11-02');
    const snapshots=await f.repository.listGeoBacklinkPerformance(f.project.id);
    expect(snapshots.map(s=>s.checkpoint).sort()).toEqual([0,30]);
    expect(snapshots.find(s=>s.checkpoint===0)?.article).toBeNull();
    expect(snapshots.find(s=>s.checkpoint===30)).toMatchObject({status:'measured',publicationDate:published.publishedAt,metrics:{attribution:'attributed',domainCitationRate:100}});
    const count=f.verifier.verify.mock.calls.length;await f.engine.progress(f.project.id,'2026-11-02');
    expect(f.verifier.verify).toHaveBeenCalledTimes(count);
  });
  it('validates dedicated queue messages without changing existing scan messages',()=>{
    expect(parseScanMessage({kind:'geo-backlinks',projectId:'account',month:'2026-11'})).toEqual({kind:'geo-backlinks',projectId:'account',month:'2026-11'});
    expect(()=>parseScanMessage({kind:'geo-backlinks',projectId:'account',month:'2026-13'})).toThrow();
    expect(parseScanMessage({kind:'reconcile'})).toEqual({kind:'reconcile'});
  });
});
