import { geoBacklinkMonth, geoBacklinkAnalysisWindow, geoBacklinkPromptKey, geoBacklinkMetrics, SCAN_PROVIDERS, type Project, type GeoBacklinkRecommendation } from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { geoObservations } from './geo-backlinks.js';

export async function buildGeoBacklinkProgress(runtime:Runtime,project:Project,now:Date) {
  const current=geoBacklinkMonth(now,project.timezone), [year,month]=current.split('-').map(Number);
  const months=Array.from({length:6},(_,index)=>new Date(Date.UTC(year,month-6+index,1)).toISOString().slice(0,7));
  const windows=months.map(value=>{
    const [y,m]=value.split('-').map(Number);
    return geoBacklinkAnalysisWindow(new Date(Date.UTC(y,m,1)).toISOString().slice(0,7),project.timezone);
  });
  const observations=await geoObservations(runtime,project,windows[0].start,now.toISOString());
  const grouped=windows.map(window=>observations.filter(item=>item.at>=window.start && item.at<window.end));
  const present=grouped.filter(items=>items.length).map(items=>new Set(items.map(geoBacklinkPromptKey)));
  const common=new Set([...(present[0] || [])].filter(key=>present.every(keys=>keys.has(key))));
  const all:GeoBacklinkRecommendation[]=[];
  for (let offset=0;;offset+=100) {
    const result=await runtime.repository.listGeoBacklinkRecommendations(project.id,{offset,limit:100});
    all.push(...result.items);
    if (offset+result.items.length>=result.total) break;
  }
  const snapshots=await runtime.repository.listGeoBacklinkPerformance(project.id);
  return {evaluatedAt:now.toISOString(),comparablePromptCount:common.size,
    excludedChangedPrompts:observations.filter(item=>!common.has(geoBacklinkPromptKey(item))).length,
    caveat:'Visibility uses matched provider and prompt versions across months with available scans. These are observed correlations, not proof of causation.',
    months:months.map((month,index)=>{
      const cohort=all.filter(item=>item.month===month), comparable=grouped[index].filter(item=>common.has(geoBacklinkPromptKey(item)));
      return {month,recommendationCount:cohort.length,contactedCount:cohort.filter(item=>item.contactedAt).length,
        acceptedCount:cohort.filter(item=>['accepted','published'].includes(item.status)).length,publishedCount:cohort.filter(item=>item.status==='published').length,
        metrics:geoBacklinkMetrics(comparable),providers:Object.fromEntries(SCAN_PROVIDERS.map(provider=>[provider,geoBacklinkMetrics(comparable.filter(item=>item.provider===provider))]))};
    }),
    placements:all.filter(item=>item.publishedAt).map(recommendation=>({
      recommendation:{...recommendation,candidate:recommendation.candidate?{...recommendation.candidate,evidence:{...recommendation.candidate.evidence,observations:[]}}:null},
      snapshots:snapshots.filter(s=>s.recommendationId===recommendation.id && s.publicationDate===recommendation.publishedAt && s.publicationUrl===recommendation.publishedUrl)}))};
}
