import { restoreReportFields } from './public-report.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GEO_BACKLINK_STATUSES, geoBacklinkAnalysisWindow, geoBacklinkDomain, SCAN_PROVIDERS,
  type Project, type User, type GeoBacklinkRecommendation, type GeoBacklinkActivity,
} from '@citevia/core';
import { AccessError, type Runtime, type GeoBacklinkPageOptions } from '@citevia/storage';
import { importedGeoRecommendation, newGeoReport } from '../../scanner/src/geo-backlinks.js';
import { publicArticleUrl } from '../../scanner/src/geo-backlink-articles.js';

const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const urlSchema = z.string().trim().max(2048).refine(value=>Boolean(publicArticleUrl(value)),'Use a public HTTP(S) URL.');
const atSchema = z.string().datetime({offset:true});
const fail = (status:number,code:string,message:string):never=>{throw new AccessError(status,code,message);};
const json = (value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function page(query:URLSearchParams): GeoBacklinkPageOptions {
  return {
    offset:z.coerce.number().int().min(0).max(1000000).parse(query.get('offset') || 0),
    limit:z.coerce.number().int().min(1).max(100).parse(query.get('limit') || 25),
    month:query.get('month') ? monthSchema.parse(query.get('month')) : undefined,
    status:query.get('status') ? z.enum(GEO_BACKLINK_STATUSES).parse(query.get('status')) : undefined,
    priority:query.get('priority') ? z.enum(['P1','P2','P3','P4']).parse(query.get('priority')) : undefined,
    provider:query.get('provider') ? z.enum(SCAN_PROVIDERS).parse(query.get('provider')) : undefined,
    category:query.get('category') ? z.enum(['competitor_gap','underrepresented','coverage_gap','secondary']).parse(query.get('category')) : undefined,
    query:z.string().max(200).parse(query.get('q') || ''),
    sort:z.enum(['date','recommendedAt','domain','priority','status','score','eligibleAgainAt']).parse(query.get('sort') || 'date'),
    direction:z.enum(['asc','desc']).parse(query.get('direction') || 'desc'),
  };
}
const publicReport = (report: Awaited<ReturnType<Runtime['repository']['getGeoBacklinkReport']>>)=>{
  if (!report) return null;
  const {leaseToken:_token,leaseUntil:_until,...publicValue}=report;
  return publicValue;
};
const recommendationSummary = (item:GeoBacklinkRecommendation)=>({...item,
  candidate:item.candidate ? {...item.candidate,evidence:{...item.candidate.evidence,observations:[]}} : null});
export async function geoBacklinksRoute(runtime:Runtime,project:Project,user:User,tail:string,request:Request,now:Date,body:(request:Request)=>Promise<unknown>):Promise<Response|null> {
  if (tail!=='geo-backlinks' && !tail.startsWith('geo-backlinks/')) return null;
  if (!user.isSystemAdmin || user.disabled) return fail(403,'FORBIDDEN','System administrator access is required.');
  if (!project.geoBacklinks?.enabled) return fail(403,'GEO_BACKLINKS_DISABLED','Enable GEO Backlink Strategy in project settings first.');
  const path=tail.slice('geo-backlinks'.length), method=request.method, query=new URL(request.url).searchParams, {repository,queue}=runtime;
  const refreshProgress=async()=>{
    const cached=await runtime.artifacts.get<Record<string,unknown>>(`geo-backlinks/${project.id}/progress-summary`);
    if (cached) await runtime.artifacts.put(`geo-backlinks/${project.id}/progress-summary`,{...cached,pending:true});
    await queue.send([{kind:'geo-backlinks-progress',projectId:project.id,date:now.toISOString().slice(0,10)}]);
  };
  const recoverableRefresh=()=>refreshProgress().catch(()=>console.error(JSON.stringify({event:'geo_progress_refresh_pending',projectId:project.id})));
  if (project.demo && method!=='GET') return fail(403,'ACCOUNT_READ_ONLY','This account is read-only.');
  if (path==='/reports' && method==='GET') {
    const options=page(query), result=await repository.listGeoBacklinkReports(project.id,options.offset!,options.limit!);
    return json({...result,items:result.items.map(publicReport)});
  }
  if (path==='/reports' && method==='POST') {
    const input=z.object({month:monthSchema}).strict().parse(await body(request));
    const window=geoBacklinkAnalysisWindow(input.month,project.timezone);
    if (Date.parse(window.end)>now.getTime()) return fail(400,'FUTURE_REPORT','The analysis calendar month must have ended.');
    const {report}=await repository.reserveGeoBacklinkReport(newGeoReport(project,input.month,now,user.subject));
    if (['completed','insufficient_data'].includes(report.status)) return json({report:publicReport(report)});
    await queue.send([{kind:'geo-backlinks',projectId:project.id,month:input.month}]);
    return json({report:publicReport(report)},202);
  }
  const reportMatch=path.match(/^\/reports\/(20\d{2}-\d{2})$/);
  if (reportMatch && method==='GET') {
    const month=monthSchema.parse(reportMatch[1]), report=await repository.getGeoBacklinkReport(project.id,month);
    const recommendations=report ? await Promise.all(report.selectedRecommendationIds.map(id=>repository.getGeoBacklinkRecommendation(project.id,id))) : [];
    return json({report:publicReport(report),recommendations:recommendations.filter((item):item is GeoBacklinkRecommendation=>Boolean(item)).map(recommendationSummary)});
  }
  if (path==='/recommendations' && method==='GET') {
    const result=await repository.listGeoBacklinkRecommendations(project.id,page(query));
    return json({...result,items:result.items.map(recommendationSummary)});
  }
  if (path==='/candidates' && method==='GET') {
    const result=await repository.listGeoBacklinkCandidates(project.id,page(query));
    return json({...result,items:result.items.map(item=>({...item,evidence:{...item.evidence,observations:[]}}))});
  }
  if (path==='/progress' && method==='GET') {
    const cached=await runtime.artifacts.get<Record<string,unknown>>(`geo-backlinks/${project.id}/progress-summary`);
    if (cached) return json(cached);
    await queue.send([{kind:'geo-backlinks-progress',projectId:project.id,date:now.toISOString().slice(0,10)}]);
    return json({months:[],placements:[],pending:true,evaluatedAt:null,caveat:'Measurements are being prepared from saved scans.'});
  }
  if (path==='/progress/refresh' && method==='POST') {
    await refreshProgress();
    return json({queued:true},202);
  }
  if (path==='/history/import' && method==='POST') {
    const input=z.object({items:z.array(z.object({domain:z.string().min(1).max(253),articleUrl:urlSchema,recommendedAt:atSchema,
      priority:z.enum(['P1','P2','P3','P4']),status:z.enum(GEO_BACKLINK_STATUSES),notes:z.string().max(10000).optional()}).strict()).min(1).max(500)}).strict().parse(await body(request));
    let entries:GeoBacklinkRecommendation[];
    try {entries=input.items.map(item=>importedGeoRecommendation(project,item,now));}
    catch {return fail(400,'INVALID_HISTORY','Each domain must match its article URL and have an actual recommendation date in the past.');}
    const imported=await repository.importGeoBacklinkHistory(project.id,entries,user.subject,now.toISOString());
    await recoverableRefresh();
    return json({imported});
  }
  const itemMatch=path.match(/^\/recommendations\/([A-Za-z0-9_-]+)$/);
  if (itemMatch) {
    const existing=await repository.getGeoBacklinkRecommendation(project.id,itemMatch[1]);
    if (!existing) return fail(404,'NOT_FOUND','Recommendation not found.');
    if (method==='GET') {
      const options=page(query);
      const [activities,snapshots]=await Promise.all([repository.listGeoBacklinkActivities(project.id,existing.id,options.offset!,options.limit!),repository.listGeoBacklinkPerformance(project.id,existing.id)]);
      return json({recommendation:existing,activities:activities.items,activityTotal:activities.total,snapshots:snapshots.filter(s=>s.publicationDate===existing.publishedAt && s.publicationUrl===existing.publishedUrl)});
    }
    if (method==='PATCH') {
      const input=z.object({version:z.number().int().positive(),status:z.enum(GEO_BACKLINK_STATUSES).optional(),
        notes:z.string().max(10000).optional(),ownerId:z.string().max(200).nullable().optional(),contactedAt:atSchema.nullable().optional(),
        publishedAt:atSchema.nullable().optional(),publishedUrl:urlSchema.nullable().optional(),landingPage:urlSchema.nullable().optional(),
        placementType:z.string().max(200).nullable().optional(),linkType:z.enum(['follow','nofollow','sponsored','ugc','unknown']).optional(),
        cost:z.number().finite().min(0).max(1e9).nullable().optional(),currency:z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
      }).strict().parse(restoreReportFields(await body(request), { ...existing }));
      const next={...existing,...input,version:input.version+1,updatedAt:now.toISOString()};
      if (next.status==='published' && (!next.publishedAt || !next.publishedUrl)) return fail(400,'PUBLICATION_REQUIRED','Record a publication date and URL before marking a placement published.');
      if ([next.contactedAt,next.publishedAt].some(at=>at && Date.parse(at)>now.getTime())) return fail(400,'FUTURE_DATE','Contact and publication dates cannot be in the future.');
      if (next.cost!==null && !next.currency) return fail(400,'CURRENCY_REQUIRED','Choose the currency for the recorded placement cost.');
      if (next.ownerId && next.ownerId!==existing.ownerId) {
        const owner=await repository.getUser(next.ownerId) || await repository.getUserById(next.ownerId);
        if (!owner || owner.disabled || (!owner.isSystemAdmin && !await repository.getMembership(project.id,owner.subject))) return fail(400,'INVALID_OWNER','Choose an active user with access to this account.');
      }
      next.finalDomain=next.publishedUrl?geoBacklinkDomain(next.publishedUrl):null;
      if (next.status==='outreach_sent' && !next.contactedAt) next.contactedAt=now.toISOString();
      const changes:GeoBacklinkActivity['changes']={};
      for (const key of ['status','notes','ownerId','contactedAt','publishedAt','publishedUrl','finalDomain','landingPage','placementType','linkType','cost','currency'] as const) {
        if (JSON.stringify(existing[key])!==JSON.stringify(next[key])) changes[key]={from:existing[key],to:next[key]};
      }
      const activity:GeoBacklinkActivity={id:randomUUID(),projectId:project.id,recommendationId:existing.id,actorId:user.subject,at:now.toISOString(),action:'updated',fromStatus:existing.status,toStatus:next.status,changes};
      if (!await repository.saveGeoBacklinkRecommendation(next,input.version,activity)) return fail(409,'VERSION_CONFLICT','This recommendation changed. Refresh before saving.');
      await recoverableRefresh();
      return json({recommendation:next});
    }
  }
  return fail(404,'NOT_FOUND','GEO backlink endpoint not found.');
}
