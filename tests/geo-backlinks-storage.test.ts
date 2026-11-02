import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GEO_BACKLINK_SETTINGS, type GeoBacklinkCandidate, type GeoBacklinkMonthlyReport, type GeoBacklinkPerformanceSnapshot, type GeoBacklinkRecommendation, type Project } from '@citevia/core';
import { MemoryRepository, PostgresRepository, type Repository, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { newProject } from './fixtures/scanner.js';
const now='2026-11-02T10:00:00.000Z';
const later=(value:string,days:number)=>new Date(Date.parse(value)+days*86400000).toISOString();
function account():Project {return {...newProject({id:randomUUID(),now:new Date('2026-10-01T00:00:00Z')}),geoBacklinks:{...DEFAULT_GEO_BACKLINK_SETTINGS,enabled:true}};}
function report(project:Project,month='2026-11',at=now):GeoBacklinkMonthlyReport {
  return {id:randomUUID(),projectId:project.id,month,status:'queued',version:1,createdAt:at,updatedAt:at,generatedAt:null,
    analysisStart:'2026-10-01T00:00:00Z',analysisEnd:'2026-11-01T00:00:00Z',timezone:'UTC',scanCount:5,answerCount:10,candidateCount:1,excludedCount:0,
    algorithmVersion:'test-v1',settings:project.geoBacklinks!,selectedRecommendationIds:[],warnings:[]};
}
function candidate(project:Project,domain='publisher.co.uk',month='2026-11'):GeoBacklinkCandidate {
  return {id:randomUUID(),projectId:project.id,domain,url:`https://${domain}/article`,title:'Editorial source',firstDiscoveredAt:'2026-10-02T00:00:00Z',lastSeenAt:'2026-10-31T00:00:00Z',evaluatedMonth:month,
    priority:'P4',category:'secondary',score:40,scoreBreakdown:{citationConsistency:20,competitorGap:0,relevance:20,visibilityGap:0,placement:0},explanation:['Cited in relevant tracked prompts.'],action:'Seek independent editorial coverage.',
    evidence:{article:{status:'unavailable',url:`https://${domain}/article`,verifiedAt:null,title:null,publisher:null,brandPresence:'unknown',competitors:[],brandPosition:null,hasBrandLink:null,links:[],topicRelevant:null,marketRelevant:null,outdated:null,placementOpportunity:'unknown',excerpts:[],reason:'Unavailable'},
      observations:[],providers:['openai'],prompts:[],distinctScans:2,totalScans:5,citationConsistency:0.4,recentConsistency:0.4,aiBrandMentionRate:0,aiAverageBrandRank:null,aiCompetitors:[],firstCitedAt:'2026-10-02T00:00:00Z',lastCitedAt:'2026-10-31T00:00:00Z'}};
}
function recommendation(project:Project,source:GeoBacklinkCandidate,cohort:GeoBacklinkMonthlyReport|null,at=now):GeoBacklinkRecommendation {
  return {id:randomUUID(),projectId:project.id,reportId:cohort?.id ?? null,month:cohort?.month ?? at.slice(0,7),domain:source.domain,url:source.url,priority:source.priority,recommendedAt:at,eligibleAgainAt:later(at,180),status:'recommended',candidate:cohort?source:null,
    contactedAt:null,publishedAt:null,publishedUrl:null,finalDomain:null,landingPage:null,placementType:null,linkType:'unknown',cost:null,currency:null,notes:'',ownerId:null,version:1,createdAt:at,updatedAt:at,...(!cohort?{imported:true,importSource:'admin:historical'}:{})};
}
async function reserve(repository:Repository,cohort:GeoBacklinkMonthlyReport,at=now) {
  await repository.reserveGeoBacklinkReport(cohort);
  const token=randomUUID();
  const claimed=await repository.claimGeoBacklinkReport(cohort.projectId,cohort.month,token,at,later(at,1));
  expect(claimed).not.toBeNull();return {claimed:claimed!,token};
}
async function finalize(repository:Repository,project:Project,domain='publisher.co.uk',month='2026-11',at=now) {
  const cohort=report(project,month,at),source=candidate(project,domain,month),item=recommendation(project,source,cohort,at),{claimed,token}=await reserve(repository,cohort,at);
  const saved=await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[source],recommendations:[item],exclusionDays:180,now:at});
  return {cohort:saved!,source,item};
}
for(const engine of ['memory','postgres'] as const) describe(`GEO backlink ${engine} persistence`,()=>{
  let repository:Repository,db:SqlDatabase|undefined;
  beforeAll(async()=>{if(engine==='postgres'){db=await localPostgres();repository=new PostgresRepository(db);}else repository=new MemoryRepository();},30000);
  afterAll(async()=>{await db?.close();});
  async function create(){const project=account();await repository.saveProject(project,null);return project;}
  it('enforces 180 full days across paths and PSL subdomains even when rejected',async()=>{
    const project=await create(),first=await finalize(repository,project,'www.publisher.co.uk');
    let saved=await repository.getGeoBacklinkRecommendation(project.id,first.item.id);expect(saved?.domain).toBe('publisher.co.uk');
    const rejected={...saved!,status:'rejected' as const,version:2,updatedAt:now};
    expect(await repository.saveGeoBacklinkRecommendation(rejected,1,{id:randomUUID(),projectId:project.id,recommendationId:rejected.id,actorId:'admin',at:now,action:'updated',fromStatus:'recommended',toStatus:'rejected',changes:{status:{from:'recommended',to:'rejected'}}})).toBe(true);
    expect((await finalize(repository,project,'news.publisher.co.uk','2026-12',later(now,1))).cohort.selectedRecommendationIds).toEqual([]);
    expect((await finalize(repository,project,'publisher.co.uk','2027-01',later(now,150))).cohort.selectedRecommendationIds).toEqual([]);
    expect((await finalize(repository,project,'publisher.co.uk','2027-02',new Date(Date.parse(later(now,180))-1).toISOString())).cohort.selectedRecommendationIds).toEqual([]);
    expect((await finalize(repository,project,'publisher.co.uk','2027-03',later(now,180))).cohort.selectedRecommendationIds).toHaveLength(1);
    expect((await repository.listGeoBacklinkRecommendations(project.id)).total).toBe(2);
    expect((await repository.listGeoBacklinkLedger(project.id))[0]).toMatchObject({firstRecommendedAt:now,lastRecommendedAt:later(now,180)});
  });
  it('serializes competing monthly finalizations and permits independent accounts',async()=>{
    const project=await create(),other=await create();
    const reports=[report(project,'2026-11'),report(project,'2026-12')];
    const prepared=await Promise.all(reports.map(async cohort=>({cohort,...await reserve(repository,cohort)})));
    const results=await Promise.all(prepared.map(({cohort,claimed,token})=>{
      const source=candidate(project,'concurrent.com',cohort.month);return repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[source],recommendations:[recommendation(project,source,cohort)],exclusionDays:180,now});
    }));
    expect(results.flatMap(result=>result!.selectedRecommendationIds)).toHaveLength(1);
    expect((await finalize(repository,other,'concurrent.com')).cohort.selectedRecommendationIds).toHaveLength(1);
    expect(await repository.getGeoBacklinkRecommendation(other.id,results.flatMap(result=>result!.selectedRecommendationIds)[0])).toBeNull();
  });
  it('refills the priority allocation against imports committed during generation and counts excluded domains once',async()=>{
    const project=await create(),cohort=report(project),{claimed,token}=await reserve(repository,cohort);
    const priorities=['P1','P1','P1','P1','P1','P1','P2','P2','P2','P3','P4','P4'] as const;
    const sources=priorities.map((priority,index)=>({...candidate(project,index===0?'top-publisher.com':`refill-${index}.com`),priority,score:100-index}));
    const proposals=sources.map(source=>recommendation(project,source,cohort));
    const duplicate={...sources[0],id:randomUUID(),url:'https://news.top-publisher.com/another-article'};
    proposals.push({...recommendation(project,duplicate,cohort),id:proposals[0].id});
    await repository.importGeoBacklinkHistory(project.id,[recommendation(project,sources[0],null,later(now,-1))],'admin',now);
    const saved=await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[...sources,duplicate],recommendations:proposals,exclusionDays:180,now});
    expect(saved?.selectedRecommendationIds).toHaveLength(10);expect(saved?.excludedCount).toBe(1);
    const selected=await Promise.all(saved!.selectedRecommendationIds.map(id=>repository.getGeoBacklinkRecommendation(project.id,id)));
    expect(selected.map(item=>item!.priority).sort()).toEqual(['P1','P1','P1','P1','P1','P2','P2','P2','P3','P4']);
    expect(new Set(selected.map(item=>item!.domain)).size).toBe(10);
    expect(selected.some(item=>item!.domain==='top-publisher.com')).toBe(false);
    expect((await repository.listGeoBacklinkRecommendations(project.id)).total).toBe(11);
    expect((await repository.listGeoBacklinkLedger(project.id)).some(item=>item.domain==='refill-11.com')).toBe(false);
  });
  it('refills simultaneous monthly cohorts from remaining qualified domains under the account lock',async()=>{
    const project=await create();project.geoBacklinks!.target=2;project.version=2;await repository.saveProject(project,1);
    const cohorts=[report(project,'2026-11'),report(project,'2026-12')];
    const prepared=await Promise.all(cohorts.map(async cohort=>({cohort,...await reserve(repository,cohort)})));
    const saved=await Promise.all(prepared.map(({cohort,claimed,token})=>{
      const sources=Array.from({length:4},(_,index)=>({...candidate(project,`parallel-refill-${index}.com`,cohort.month),score:100-index}));
      return repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:sources,recommendations:sources.map(source=>recommendation(project,source,cohort)),exclusionDays:180,now});
    }));
    expect(saved.map(item=>item!.selectedRecommendationIds.length)).toEqual([2,2]);
    const history=await repository.listGeoBacklinkRecommendations(project.id);
    expect(history.total).toBe(4);expect(new Set(history.items.map(item=>item.domain)).size).toBe(4);
    expect(saved.map(item=>item!.excludedCount).sort()).toEqual([0,2]);
  });
  it('preserves immutable cohorts on retry and cannot lease a completed report',async()=>{
    const project=await create(),saved=await finalize(repository,project);
    const replacement=report(project);
    expect(await repository.reserveGeoBacklinkReport(replacement)).toEqual({status:'existing',report:saved.cohort});
    expect(await repository.claimGeoBacklinkReport(project.id,saved.cohort.month,'new-token',now,later(now,1))).toBeNull();
    const source=candidate(project,'another.com');
    expect(await repository.commitGeoBacklinkReport({report:{...saved.cohort,selectedRecommendationIds:[]},leaseToken:'stale',candidates:[source],recommendations:[],exclusionDays:180,now})).toEqual(saved.cohort);
    expect((await repository.listGeoBacklinkCandidates(project.id)).items).toHaveLength(1);
  });
  it('recovers an expired lease and rejects the stale writer',async()=>{
    const project=await create(),cohort=report(project),{claimed,token}=await reserve(repository,cohort);
    expect(await repository.claimGeoBacklinkReport(project.id,cohort.month,'other',now,later(now,1))).toBeNull();
    const after=later(now,2),replacement=await repository.claimGeoBacklinkReport(project.id,cohort.month,'new-token',after,later(after,1));
    expect(replacement?.version).toBe(3);
    expect(await repository.failGeoBacklinkReport(project.id,cohort.month,token,'stale',after)).toBe(false);
    expect(await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[],recommendations:[],exclusionDays:180,now:after})).toBeNull();
    expect(await repository.failGeoBacklinkReport(project.id,cohort.month,'new-token','fetch failed',after)).toBe(true);
    expect(await repository.claimGeoBacklinkReport(project.id,cohort.month,'retry',after,later(after,1))).not.toBeNull();
  });
  it('imports real history idempotently and preserves later exclusions when older history is added',async()=>{
    const project=await create(),source=candidate(project,'imported.com');
    const newest=recommendation(project,source,null,later(now,-1));
    expect(await repository.importGeoBacklinkHistory(project.id,[newest],'admin',now)).toBe(1);
    expect(await repository.importGeoBacklinkHistory(project.id,[newest],'admin',now)).toBe(0);
    const older=recommendation(project,source,null,later(now,-250));
    expect(await repository.importGeoBacklinkHistory(project.id,[older],'admin',now)).toBe(1);
    expect((await repository.listGeoBacklinkLedger(project.id))[0]).toMatchObject({firstRecommendedAt:older.recommendedAt,lastRecommendedAt:newest.recommendedAt,eligibleAgainAt:newest.eligibleAgainAt});
    expect((await finalize(repository,project,'www.imported.com')).cohort.selectedRecommendationIds).toHaveLength(0);
    expect((await repository.listGeoBacklinkActivities(project.id,newest.id,0,25)).total).toBe(1);
    await expect(repository.importGeoBacklinkHistory(project.id,[{...newest,id:'future',recommendedAt:later(now,1)}],'admin',now)).rejects.toThrow('Invalid historical');
  });
  it('does not block discovered backlog and preserves discovery dates on rescore',async()=>{
    const project=await create(),cohort=report(project),{claimed,token}=await reserve(repository,cohort),backlog=candidate(project,'backlog.com');
    await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[backlog],recommendations:[],exclusionDays:180,now});
    expect(await repository.listGeoBacklinkLedger(project.id)).toEqual([]);
    const saved=await finalize(repository,project,'backlog.com','2026-12',later(now,30));
    expect(saved.cohort.selectedRecommendationIds).toHaveLength(1);
    expect((await repository.listGeoBacklinkCandidates(project.id)).items[0].firstDiscoveredAt).toBe(backlog.firstDiscoveredAt);
  });
  it('audits lifecycle CAS, filters/paginates history and rejects changing immutable evidence',async()=>{
    const project=await create(),saved=await finalize(repository,project);
    const current=(await repository.getGeoBacklinkRecommendation(project.id,saved.item.id))!;
    const next={...current,notes:'Contact verified editor',version:2,updatedAt:later(now,1)};
    const activity={id:randomUUID(),projectId:project.id,recommendationId:next.id,actorId:'admin',at:next.updatedAt,action:'updated' as const,fromStatus:current.status,toStatus:next.status,changes:{notes:{from:'',to:next.notes}}};
    expect(await repository.saveGeoBacklinkRecommendation(next,1,activity)).toBe(true);
    expect(await repository.saveGeoBacklinkRecommendation(next,1,activity)).toBe(false);
    await expect(repository.saveGeoBacklinkRecommendation({...next,url:'https://another.com',version:3},2,{...activity,id:randomUUID()})).rejects.toThrow('Invalid GEO recommendation');
    expect((await repository.listGeoBacklinkRecommendations(project.id,{query:'publisher',priority:'P4',provider:'openai',category:'secondary',status:'recommended',month:'2026-11',limit:1})).total).toBe(1);
    expect((await repository.listGeoBacklinkRecommendations(project.id,{query:'absent'})).items).toEqual([]);
    expect((await repository.listGeoBacklinkActivities(project.id,next.id,0,25)).total).toBe(2);
  });
  it('rechecks imports made during report generation and rejects mismatched URL evidence',async()=>{
    const project=await create(),cohort=report(project),source=candidate(project,'during-generation.com'),{claimed,token}=await reserve(repository,cohort);
    const prior=recommendation(project,source,null,later(now,-1));
    await repository.importGeoBacklinkHistory(project.id,[prior],'admin',now);
    const item=recommendation(project,source,cohort);
    await expect(repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[source],recommendations:[{...item,url:'https://wrong-domain.com/article'}],exclusionDays:1,now})).rejects.toThrow('URL/domain');
    expect((await repository.listGeoBacklinkCandidates(project.id)).total).toBe(0);
    const saved=await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[source],recommendations:[item],exclusionDays:1,now});
    expect(saved?.selectedRecommendationIds).toEqual([]);
    expect((await repository.listGeoBacklinkRecommendations(project.id)).total).toBe(1);
  });
  it('stores publication-specific checkpoints once and permits insufficient-data backfill',async()=>{
    const project=await create(),saved=await finalize(repository,project);
    const current=(await repository.getGeoBacklinkRecommendation(project.id,saved.item.id))!;
    const published={...current,status:'published' as const,publishedAt:now,publishedUrl:current.url,version:2};
    await repository.saveGeoBacklinkRecommendation(published,1,{id:randomUUID(),projectId:project.id,recommendationId:current.id,actorId:'admin',at:now,action:'updated',fromStatus:'recommended',toStatus:'published',changes:{}});
    const snapshot:GeoBacklinkPerformanceSnapshot={id:randomUUID(),projectId:project.id,recommendationId:current.id,checkpoint:30,publicationDate:now,publicationUrl:current.url,start:now,end:later(now,30),measuredAt:later(now,30),status:'insufficient_data',comparablePromptKeys:[],excludedChangedPrompts:0,
      metrics:{answers:0,scans:0,brandMentionRate:null,averageBrandRank:null,domainCitationRate:null,articleCitationRate:null,uniqueReferringDomains:0,competitorRates:[],attribution:'unattributed'},providers:{},article:null,delta:{brandMentionRate:null,averageBrandRank:null,domainCitationRate:null},referralTraffic:null,conversions:null,caveat:'Correlation does not prove causation.'};
    expect(await repository.putGeoBacklinkPerformance(snapshot)).toBe(true);
    expect(await repository.putGeoBacklinkPerformance({...snapshot,status:'measured',metrics:{...snapshot.metrics,answers:10,scans:5}})).toBe(true);
    expect(await repository.putGeoBacklinkPerformance({...snapshot,status:'measured',metrics:{...snapshot.metrics,answers:99}})).toBe(false);
    expect(await repository.putGeoBacklinkPerformance({...snapshot,publicationDate:later(now,1)})).toBe(false);
    expect(await repository.putGeoBacklinkPerformance({...snapshot,publicationUrl:'https://another.com/article'})).toBe(false);
    expect((await repository.listGeoBacklinkPerformance(project.id,current.id))[0].metrics.answers).toBe(10);
    expect(await repository.listGeoBacklinkPerformance('another-account',current.id)).toEqual([]);
    const changedUrl='https://publisher.co.uk/new-article';
    await repository.saveGeoBacklinkRecommendation({...published,publishedUrl:changedUrl,version:3},2,{id:randomUUID(),projectId:project.id,recommendationId:current.id,actorId:'admin',at:now,action:'updated',fromStatus:'published',toStatus:'published',changes:{}});
    expect(await repository.putGeoBacklinkPerformance({...snapshot,publicationUrl:changedUrl,status:'measured'})).toBe(true);
    expect((await repository.listGeoBacklinkPerformance(project.id,current.id))).toHaveLength(2);
  });
  it('preserves the strongest domain candidate and does not regress the backlog during historical generation',async()=>{
    const project=await create(),cohort=report(project),{claimed,token}=await reserve(repository,cohort);
    const strong=candidate(project,'same-domain.com'),weak={...candidate(project,'news.same-domain.com'),score:5,title:'Weak'};
    await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[strong,weak],recommendations:[],exclusionDays:180,now});
    expect((await repository.listGeoBacklinkCandidates(project.id)).items[0].score).toBe(40);
    const oldReport=report(project,'2026-10'),oldLease=await reserve(repository,oldReport);
    await repository.commitGeoBacklinkReport({report:{...oldLease.claimed,status:'completed'},leaseToken:oldLease.token,candidates:[{...strong,score:99,evaluatedMonth:'2026-10',lastSeenAt:'2026-09-30T00:00:00Z'}],recommendations:[],exclusionDays:180,now});
    expect((await repository.listGeoBacklinkCandidates(project.id)).items[0]).toMatchObject({score:40,evaluatedMonth:'2026-11'});
  });
  it('uses saved data while scanning is paused when the backlink toggle stays enabled',async()=>{
    const project=await create();await repository.saveProject({...project,enabled:false,version:project.version+1},project.version);
    const saved=await finalize(repository,project,'paused-scanning.com');
    expect(saved.cohort.selectedRecommendationIds).toHaveLength(1);
    expect((await repository.listGeoBacklinkProjects(0,100)).items.some(item=>item.id===project.id)).toBe(true);
  });
  it('requires enabled settings and stops committing after opt-out',async()=>{
    const project=await create(),cohort=report(project),{claimed,token}=await reserve(repository,cohort);
    await repository.saveProject({...project,geoBacklinks:{...project.geoBacklinks!,enabled:false},version:project.version+1},project.version);
    expect(await repository.commitGeoBacklinkReport({report:{...claimed,status:'completed'},leaseToken:token,candidates:[],recommendations:[],exclusionDays:180,now})).toBeNull();
    await expect(repository.reserveGeoBacklinkReport(report(project,'2026-12'))).rejects.toThrow('disabled');
    expect((await repository.listGeoBacklinkProjects(0,100)).items.some(item=>item.id===project.id)).toBe(false);
  });
});
