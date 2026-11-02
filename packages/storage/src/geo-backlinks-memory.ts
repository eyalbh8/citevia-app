import type { GeoBacklinkActivity, GeoBacklinkCandidate, GeoBacklinkLedger, GeoBacklinkMonthlyReport, GeoBacklinkPerformanceSnapshot, GeoBacklinkRecommendation, Project } from '@citevia/core';
import { geoCanonicalDomain, geoSelectProposals, geoFinal, geoLedger, geoPageBounds, geoSameCohort, geoBestCandidates, geoRefreshCandidate, geoValidateCandidate, geoValidateRecommendation, type GeoBacklinkCommit, type GeoBacklinkPageOptions } from './geo-backlinks.js';
export interface GeoBacklinkMemoryState {
  projects: Record<string,Project>;
  geoReports?: Record<string,GeoBacklinkMonthlyReport>;
  geoCandidates?: Record<string,GeoBacklinkCandidate>;
  geoRecommendations?: Record<string,GeoBacklinkRecommendation>;
  geoLedger?: Record<string,GeoBacklinkLedger>;
  geoActivities?: Record<string,GeoBacklinkActivity>;
  geoPerformance?: Record<string,GeoBacklinkPerformanceSnapshot>;
}
const key=(...parts:string[])=>JSON.stringify(parts);
const values=<T>(record:Record<string,T>|undefined)=>Object.values(record || {});
const clone=<T>(value:T):T=>structuredClone(value);
function project(state:GeoBacklinkMemoryState,id:string) { const found=state.projects[id]; if(!found) throw new Error('Project missing'); return found; }
const enabled=(project:Project)=>project.geoBacklinks?.enabled && !project.demo;
function page<T>(items:T[],options:GeoBacklinkPageOptions) { const bounds=geoPageBounds(options); return {items:items.slice(bounds.offset,bounds.offset+bounds.limit),total:items.length}; }
export function listGeoBacklinkProjects(state:GeoBacklinkMemoryState,offset:number,limit:number) {
  return page(values(state.projects).filter(enabled).sort((a,b)=>a.id.localeCompare(b.id)),{offset,limit});
}
export function getGeoBacklinkReport(state:GeoBacklinkMemoryState,projectId:string,month:string) { return state.geoReports?.[key(projectId,month)] || null; }
export function reserveGeoBacklinkReport(state:GeoBacklinkMemoryState,report:GeoBacklinkMonthlyReport) {
  const account=project(state,report.projectId),existing=getGeoBacklinkReport(state,report.projectId,report.month);
  if(existing) return {status:'existing' as const,report:existing};
  if(!enabled(account)) throw new Error('GEO backlinks are disabled');
  if(report.version!==1 || report.status!=='queued' || report.selectedRecommendationIds.length) throw new Error('Invalid initial GEO report');
  (state.geoReports ||= {})[key(report.projectId,report.month)]=clone(report);
  return {status:'created' as const,report};
}
export function claimGeoBacklinkReport(state:GeoBacklinkMemoryState,projectId:string,month:string,token:string,now:string,leaseUntil:string) {
  if(!enabled(project(state,projectId))) return null;
  const current=getGeoBacklinkReport(state,projectId,month);
  if(!current || geoFinal(current) || (current.status==='running' && Date.parse(current.leaseUntil || '')>Date.parse(now))) return null;
  if(!token || !(Date.parse(leaseUntil)>Date.parse(now))) throw new Error('Invalid GEO report lease');
  const report:GeoBacklinkMonthlyReport={...current,status:'running',version:current.version+1,leaseToken:token,leaseUntil,updatedAt:now,error:undefined};
  state.geoReports![key(projectId,month)]=report; return report;
}
function insertRecommendation(state:GeoBacklinkMemoryState,item:GeoBacklinkRecommendation,actorId:string,at:string) {
  if(state.geoRecommendations?.[key(item.projectId,item.id)]) return false;
  (state.geoRecommendations ||= {})[key(item.projectId,item.id)]=clone(item);
  const ledgerKey=key(item.projectId,item.domain);
  (state.geoLedger ||= {})[ledgerKey]=geoLedger(item,state.geoLedger?.[ledgerKey]);
  const activity:GeoBacklinkActivity={id:`${item.id}:created`,projectId:item.projectId,recommendationId:item.id,actorId,at,
    action:item.imported?'imported':'recommended',fromStatus:null,toStatus:item.status,changes:{}};
  (state.geoActivities ||= {})[key(activity.projectId,activity.id)]=activity;
  return true;
}
export function commitGeoBacklinkReport(state:GeoBacklinkMemoryState,input:GeoBacklinkCommit) {
  const account=project(state,input.report.projectId),current=getGeoBacklinkReport(state,input.report.projectId,input.report.month);
  if(!current || geoFinal(current)) return current;
  if(!enabled(account) || current.status!=='running' || current.leaseToken!==input.leaseToken || Date.parse(current.leaseUntil || '')<=Date.parse(input.now)) return null;
  if(!geoFinal(input.report) || input.report.id!==current.id) throw new Error('Invalid final GEO report');
  // Validate the entire write before mutating any state, matching SQL rollback semantics.
  for(const candidate of geoBestCandidates(input.candidates)) {
    if(candidate.projectId!==account.id || candidate.evaluatedMonth!==current.month) throw new Error('Invalid GEO candidate account/month');
    geoValidateCandidate(candidate);
  }
  for(const item of input.recommendations) {
    if(item.projectId!==account.id || item.reportId!==current.id || item.month!==current.month || item.version!==1 || !item.candidate || item.candidate.evaluatedMonth!==current.month) throw new Error('Invalid GEO recommendation cohort');
    geoValidateRecommendation(item);
  }
  for(const candidate of geoBestCandidates(input.candidates)) {
    const domain=geoCanonicalDomain(candidate.domain),id=key(account.id,domain),previous=state.geoCandidates?.[id];
    (state.geoCandidates ||= {})[id]=geoRefreshCandidate({...clone(candidate),domain},previous);
  }
  const days=Math.max(180,input.exclusionDays,current.settings.exclusionDays,account.geoBacklinks!.exclusionDays);
  const allocation=geoSelectProposals(input.recommendations,values(state.geoLedger).filter(item=>item.projectId===account.id),input.now,{...current.settings,exclusionDays:days});
  const selected:string[]=[];
  for(const proposed of allocation.selected) {
    const domain=geoCanonicalDomain(proposed.domain);
    const item={...proposed,domain,recommendedAt:input.now,eligibleAgainAt:new Date(Date.parse(input.now)+days*86400000).toISOString()};
    if(insertRecommendation(state,item,input.report.requestedBy || 'system',input.now)) selected.push(item.id);
  }
  const report:GeoBacklinkMonthlyReport={...clone(input.report),version:current.version+1,selectedRecommendationIds:selected,
    excludedCount:allocation.excludedCount,updatedAt:input.now,generatedAt:input.now};
  delete report.leaseToken;delete report.leaseUntil;
  state.geoReports![key(account.id,current.month)]=report;return report;
}
export function failGeoBacklinkReport(state:GeoBacklinkMemoryState,projectId:string,month:string,token:string,error:string,now:string) {
  project(state,projectId);const current=getGeoBacklinkReport(state,projectId,month);
  if(!current || geoFinal(current) || current.leaseToken!==token) return false;
  const next:GeoBacklinkMonthlyReport={...current,status:'failed',version:current.version+1,updatedAt:now,error};
  delete next.leaseToken;delete next.leaseUntil;
  state.geoReports![key(projectId,month)]=next;return true;
}
export function listGeoBacklinkReports(state:GeoBacklinkMemoryState,projectId:string,offset:number,limit:number) {
  return page(values(state.geoReports).filter(item=>item.projectId===projectId).sort((a,b)=>b.month.localeCompare(a.month)),{offset,limit});
}
export function listActiveGeoBacklinkReports(state:GeoBacklinkMemoryState,limit=100,now=new Date().toISOString()) {
  return values(state.geoReports).filter(item=>enabled(state.projects[item.projectId]) && (item.status==='queued' ||
    (item.status==='failed' && Date.parse(item.updatedAt)<Date.parse(now)-300000) || (item.status==='running' && Date.parse(item.leaseUntil || '')<=Date.parse(now))))
    .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt) || a.projectId.localeCompare(b.projectId)).slice(0,geoPageBounds({limit}).limit);
}
function matches(item:GeoBacklinkCandidate|GeoBacklinkRecommendation,options:GeoBacklinkPageOptions) {
  const candidate='candidate' in item?item.candidate:item;
  return (!options.month || ('month' in item?item.month:item.evaluatedMonth)===options.month) &&
    (!options.status || ('status' in item && item.status===options.status)) && (!options.priority || item.priority===options.priority) &&
    (!options.category || candidate?.category===options.category) && (!options.provider || candidate?.evidence.providers.some(p=>p===options.provider)) &&
    (!options.query || `${item.domain} ${item.url}`.toLowerCase().includes(options.query.toLowerCase()));
}
export function listGeoBacklinkCandidates(state:GeoBacklinkMemoryState,projectId:string,options:GeoBacklinkPageOptions={}) {
  return page(values(state.geoCandidates).filter(item=>item.projectId===projectId && matches(item,options)).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt) || a.domain.localeCompare(b.domain)),options);
}
export function listGeoBacklinkRecommendations(state:GeoBacklinkMemoryState,projectId:string,options:GeoBacklinkPageOptions={}) {
  const sort=options.sort || 'date',direction=options.direction==='asc'?1:-1;
  return page(values(state.geoRecommendations).filter(item=>item.projectId===projectId && matches(item,options)).sort((a,b)=>{
    if (sort === 'score') return ((a.candidate?.score ?? -1) - (b.candidate?.score ?? -1)) * direction || b.id.localeCompare(a.id);
    const left=sort==='date'?a.recommendedAt:a[sort],right=sort==='date'?b.recommendedAt:b[sort];
    return left.localeCompare(right)*direction || b.id.localeCompare(a.id);
  }),options);
}
export function getGeoBacklinkRecommendation(state:GeoBacklinkMemoryState,projectId:string,id:string) {return state.geoRecommendations?.[key(projectId,id)] || null;}
export function saveGeoBacklinkRecommendation(state:GeoBacklinkMemoryState,next:GeoBacklinkRecommendation,expectedVersion:number,activity:GeoBacklinkActivity) {
  project(state,next.projectId);const current=getGeoBacklinkRecommendation(state,next.projectId,next.id);
  if(!current || current.version!==expectedVersion) return false;
  if(next.version!==expectedVersion+1 || !geoSameCohort(current,next) || activity.projectId!==next.projectId || activity.recommendationId!==next.id || activity.fromStatus!==current.status || activity.toStatus!==next.status) throw new Error('Invalid GEO recommendation update');
  if(state.geoActivities?.[key(activity.projectId,activity.id)]) throw new Error('Duplicate GEO activity');
  state.geoRecommendations![key(next.projectId,next.id)]=clone(next);
  const ledger=state.geoLedger?.[key(next.projectId,next.domain)];if(ledger?.recommendationId===next.id) ledger.status=next.status;
  (state.geoActivities ||= {})[key(activity.projectId,activity.id)]=clone(activity);return true;
}
export function listGeoBacklinkActivities(state:GeoBacklinkMemoryState,projectId:string,recommendationId:string,offset:number,limit:number) {
  return page(values(state.geoActivities).filter(item=>item.projectId===projectId && item.recommendationId===recommendationId).sort((a,b)=>b.at.localeCompare(a.at) || b.id.localeCompare(a.id)),{offset,limit});
}
export function listGeoBacklinkLedger(state:GeoBacklinkMemoryState,projectId:string) {return values(state.geoLedger).filter(item=>item.projectId===projectId).sort((a,b)=>a.domain.localeCompare(b.domain));}
export function importGeoBacklinkHistory(state:GeoBacklinkMemoryState,projectId:string,entries:GeoBacklinkRecommendation[],actorId:string,now:string) {
  project(state,projectId);
  const prepared=entries.map(entry=>{
    if(entry.projectId!==projectId || entry.reportId!==null || entry.version!==1 || !entry.imported || !Number.isFinite(Date.parse(entry.recommendedAt)) || Date.parse(entry.recommendedAt)>Date.parse(now)) throw new Error('Invalid historical GEO recommendation');
    geoValidateRecommendation(entry);
    return {...entry,domain:geoCanonicalDomain(entry.domain),eligibleAgainAt:new Date(Math.max(Date.parse(entry.eligibleAgainAt)||0,Date.parse(entry.recommendedAt)+180*86400000)).toISOString()};
  });
  return prepared.filter(item=>insertRecommendation(state,item,actorId,now)).length;
}
export function listLegacyGeoBacklinkHistory(_state:GeoBacklinkMemoryState,_projectId:string):{id:string;url:string;recommendedAt:string;source:string}[] {return [];}
export function putGeoBacklinkPerformance(state:GeoBacklinkMemoryState,snapshot:GeoBacklinkPerformanceSnapshot) {
  const recommendation=getGeoBacklinkRecommendation(state,snapshot.projectId,snapshot.recommendationId);
  if(!recommendation || recommendation.publishedAt!==snapshot.publicationDate || (recommendation.publishedUrl || recommendation.url)!==snapshot.publicationUrl) return false;
  const id=key(snapshot.projectId,snapshot.recommendationId,snapshot.publicationDate,snapshot.publicationUrl,String(snapshot.checkpoint));
  const previous=state.geoPerformance?.[id];if(previous && previous.status!=='insufficient_data') return false;
  (state.geoPerformance ||= {})[id]=clone(snapshot);return true;
}
export function listGeoBacklinkPerformance(state:GeoBacklinkMemoryState,projectId:string,recommendationId?:string) {
  return values(state.geoPerformance).filter(item=>item.projectId===projectId && (!recommendationId || item.recommendationId===recommendationId)).sort((a,b)=>b.publicationDate.localeCompare(a.publicationDate) || a.checkpoint-b.checkpoint);
}
