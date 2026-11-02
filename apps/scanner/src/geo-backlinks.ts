import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_GEO_BACKLINK_SETTINGS, GEO_BACKLINK_ALGORITHM_VERSION, geoBacklinkAnalysisWindow,
  geoBacklinkDomain, dueGeoBacklinkMonth, buildGeoBacklinkObservations, discoverGeoBacklinkCandidates,
  selectGeoBacklinkCandidates, snapshotProvider, geoBacklinkPerformanceSnapshot,
  type GeoBacklinkMonthlyReport, type GeoBacklinkRecommendation, type GeoBacklinkSettings,
  type Project, type CapturedAnswer, type Analysis, type Citation, type GeoBacklinkArticleEvidence,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { promptAnswers } from '../../api/src/prompt-answers.js';
import { GeoBacklinkArticleVerifier, publicArticleUrl } from './geo-backlink-articles.js';

export const geoId = (...values: string[]) => `geo_${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,40)}`;
export function geoSettings(project: Project): GeoBacklinkSettings {
  return { ...DEFAULT_GEO_BACKLINK_SETTINGS, ...project.geoBacklinks,
    exclusionDays: Math.max(180, project.geoBacklinks?.exclusionDays || 180),
    weights: { ...DEFAULT_GEO_BACKLINK_SETTINGS.weights, ...project.geoBacklinks?.weights } };
}
export function newGeoReport(project: Project, month: string, now: Date, requestedBy?: string): GeoBacklinkMonthlyReport {
  const window = geoBacklinkAnalysisWindow(month, project.timezone), at = now.toISOString();
  return {id:geoId(project.id,month),projectId:project.id,month,status:'queued',version:1,createdAt:at,updatedAt:at,
    generatedAt:null,analysisStart:window.start,analysisEnd:window.end,timezone:project.timezone,
    scanCount:0,answerCount:0,candidateCount:0,excludedCount:0,algorithmVersion:GEO_BACKLINK_ALGORITHM_VERSION,
    settings:geoSettings(project),selectedRecommendationIds:[],warnings:[],requestedBy};
}
/** Native index first, bounded legacy artifact hydration second. No provider calls. */
export async function geoObservations(runtime: Runtime, project: Project, start: string, end: string) {
  const history = await runtime.repository.listPromptHistory(project.id,start,end);
  history.runs = history.runs.filter(run=>run.status === 'completed' && !run.cancelledAt && !run.reportingExcludedAt);
  const rows = promptAnswers(history,project.id,undefined,undefined,'date','asc').filter(({result,run})=>
    result.status === 'succeeded' && Date.parse(result.capturedAt || run.createdAt) >= Date.parse(start) &&
    Date.parse(result.capturedAt || run.createdAt) < Date.parse(end));
  const qualified = (row:typeof rows[number]) => `${snapshotProvider(row.run.snapshot)}:${row.result.captureKey}`;
  const [native,saved] = await Promise.all([
    runtime.repository.listNativeCitations(project.id,rows.filter(row=>row.result.captureKey).map(qualified)),
    runtime.repository.listSavedAnalyses(project.id,rows.filter(row=>row.result.captureKey).map(({result})=>({responseId:result.responseId,captureKey:result.captureKey!,analysisKey:result.analysisKey}))),
  ]);
  const citations = new Map(native.map(row=>[row.captureKey,row.citations]));
  const analyses = new Map(saved.map(row=>[row.responseId,row.analysis]));
  const hydrated: Parameters<typeof buildGeoBacklinkObservations>[0] = [];
  for (let i=0;i<rows.length;i+=8) {
    hydrated.push(...await Promise.all(rows.slice(i,i+8).map(async row=>{
      const {result}=row;
      let sources: Citation[] | undefined = citations.get(qualified(row));
      let analysis = analyses.get(result.responseId);
      if (sources === undefined && result.captureKey) sources = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey))?.citations;
      if (analysis === undefined && result.analysisKey) analysis = await runtime.artifacts.get<Analysis>(result.analysisKey);
      return {...row,citations:sources || [],analysis};
    })));
  }
  return buildGeoBacklinkObservations(hydrated);
}
export function importedGeoRecommendation(project: Project, item: {
  domain: string; articleUrl: string; recommendedAt: string; priority: GeoBacklinkRecommendation['priority'];
  status: GeoBacklinkRecommendation['status']; notes?: string; source?: string;
}, now: Date): GeoBacklinkRecommendation {
  const domain = geoBacklinkDomain(item.domain), at = new Date(item.recommendedAt).toISOString();
  if (!domain || geoBacklinkDomain(item.articleUrl) !== domain || !publicArticleUrl(item.articleUrl) || Date.parse(at)>now.getTime()) throw new Error('Invalid historical recommendation');
  return {id:geoId(project.id,domain,at),projectId:project.id,reportId:null,month:at.slice(0,7),domain,url:item.articleUrl,
    priority:item.priority,recommendedAt:at,eligibleAgainAt:new Date(Date.parse(at)+geoSettings(project).exclusionDays*86400000).toISOString(),
    status:item.status,candidate:null,contactedAt:null,publishedAt:null,publishedUrl:null,finalDomain:null,landingPage:null,
    placementType:null,linkType:'unknown',cost:null,currency:null,notes:item.notes || '',ownerId:null,version:1,
    createdAt:now.toISOString(),updatedAt:now.toISOString(),imported:true,importSource:item.source || 'system_admin_import'};
}
export class GeoBacklinkEngine {
  constructor(private runtime: Runtime, private verifier: Pick<GeoBacklinkArticleVerifier,'verify'> = new GeoBacklinkArticleVerifier(), private now=()=>new Date()) {}
  async handle(projectId: string, month: string): Promise<void> {
    const {repository}=this.runtime;
    const project = await repository.getProject(projectId);
    if (!project?.geoBacklinks?.enabled || project.demo) return;
    const existing = await repository.reserveGeoBacklinkReport(newGeoReport(project,month,this.now()));
    if (['completed','insufficient_data'].includes(existing.report.status)) return;
    const token = randomUUID();
    const report = await repository.claimGeoBacklinkReport(projectId,month,token,this.now().toISOString(),new Date(this.now().getTime()+6*60000).toISOString());
    if (!report) return;
    try {
      // Only explicit backlink recommendation history is trustworthy for exclusions.
      const historical = await repository.listLegacyGeoBacklinkHistory(projectId);
      const imports = historical.flatMap(item=>{
        try { return [importedGeoRecommendation(project,{domain:geoBacklinkDomain(item.url) || '',articleUrl:item.url,recommendedAt:item.recommendedAt,priority:'P4',status:'recommended',source:item.source},this.now())]; }
        catch { return []; }
      });
      if (imports.length) await repository.importGeoBacklinkHistory(projectId,imports,'system:legacy-backlink-history',this.now().toISOString());
      const analysisProject = { ...project, timezone: report.timezone };
      const observations = await geoObservations(this.runtime,analysisProject,report.analysisStart,report.analysisEnd);
      const articles = new Map<string,GeoBacklinkArticleEvidence>();
      const discovered = discoverGeoBacklinkCandidates(analysisProject,month,observations,articles,report.settings);
      // Verify the strongest article per domain, with bounded network concurrency/time.
      const byDomain = new Map<string,typeof discovered[number]>();
      for (const candidate of [...discovered].sort((a,b)=>b.score-a.score || a.url.localeCompare(b.url)))
        if (!byDomain.has(candidate.domain)) byDomain.set(candidate.domain,candidate);
      const verify = [...byDomain.values()].slice(0,Math.min(40,report.settings.target*4));
      const verificationDeadline = Date.now()+150000;
      for (let i=0;i<verify.length;i+=4) {
        if (Date.now() >= verificationDeadline) break;
        const values = await Promise.all(verify.slice(i,i+4).map(async candidate=>[candidate.url,await this.verifier.verify(project,candidate.url,this.now())] as const));
        for (const [url,evidence] of values) articles.set(url,evidence);
      }
      const candidates = discoverGeoBacklinkCandidates(analysisProject,month,observations,articles,report.settings);
      const ledger = await repository.listGeoBacklinkLedger(projectId);
      const selected = selectGeoBacklinkCandidates(candidates,ledger,this.now(),report.settings);
      const at = this.now().toISOString();
      // The transaction re-runs allocation over the complete fresh pool. If another
      // month or historical import wins a domain, remaining eligible sites can fill it.
      const recommendations: GeoBacklinkRecommendation[] = candidates.map(candidate => ({
        id:geoId(projectId,month,candidate.domain),projectId,reportId:report.id,month,domain:candidate.domain,url:candidate.url,
        priority:candidate.priority,recommendedAt:at,eligibleAgainAt:new Date(Date.parse(at)+report.settings.exclusionDays*86400000).toISOString(),
        status:'recommended',candidate,contactedAt:null,publishedAt:null,publishedUrl:null,finalDomain:null,landingPage:null,
        placementType:null,linkType:'unknown',cost:null,currency:null,notes:'',ownerId:null,version:1,createdAt:at,updatedAt:at,
      }));
      const scanCount = new Set(observations.map(row=>`${row.provider}:${row.scanGroupId}`)).size;
      const completed: GeoBacklinkMonthlyReport = {...report,status:scanCount<2?'insufficient_data':'completed',
        updatedAt:at,generatedAt:at,scanCount,answerCount:observations.length,candidateCount:candidates.length,
        excludedCount:candidates.filter(c=>ledger.some(l=>l.domain===c.domain && Date.parse(l.eligibleAgainAt)>Date.parse(at))).length,
        warnings:[...(scanCount<2?['Insufficient completed scan history: at least two distinct provider scans are required.']:[]),
          ...(selected.length<report.settings.target?['Fewer qualified domains were available than the target; the report was not padded.']:[]),
          ...(articles.size<byDomain.size?['Article verification is bounded to the 40 strongest domains per run; remaining article presence is unknown.']:[]),
          'The 180-day protection covers recorded and imported recommendations only.'],
        selectedRecommendationIds:recommendations.map(r=>r.id)};
      const saved=await repository.commitGeoBacklinkReport({report:completed,leaseToken:token,candidates,
        recommendations:scanCount<2?[]:recommendations,exclusionDays:report.settings.exclusionDays,now:at});
      if (saved) await this.runtime.queue.send([{kind:'geo-backlinks-progress',projectId,date:at.slice(0,10)}]);
    } catch (error) {
      await repository.failGeoBacklinkReport(projectId,month,token,'Report generation interrupted. Retry to recover the original monthly cohort.',this.now().toISOString());
      throw error;
    }
  }
  async progress(projectId: string, date: string) {
    const project = await this.runtime.repository.getProject(projectId);
    if (!project?.geoBacklinks?.enabled || project.demo) return;
    const snapshots = await this.runtime.repository.listGeoBacklinkPerformance(projectId);
    const deadline = Date.now()+150000;
    for (let offset=0;;offset+=100) {
      const page = await this.runtime.repository.listGeoBacklinkRecommendations(projectId,{status:'published',offset,limit:100});
      for (const recommendation of page.items) {
        if (!recommendation.publishedAt) continue;
        const pub = Date.parse(recommendation.publishedAt);
        const pending = ([0,30,60,90] as const).filter(checkpoint=>this.now().getTime()>=pub+checkpoint*86400000 &&
          !snapshots.some(s=>s.recommendationId===recommendation.id && s.publicationDate===recommendation.publishedAt && s.publicationUrl===recommendation.publishedUrl && s.checkpoint===checkpoint &&
            (s.status==='measured' || s.measuredAt.slice(0,10)===date)));
        if (!pending.length) continue;
        // Unfinished daily work resumes on the next minute tick; completed checkpoints are durable.
        if (Date.now()>=deadline) return;
        const observed = await geoObservations(this.runtime,project,new Date(pub-30*86400000).toISOString(),new Date(Math.min(this.now().getTime(),pub+90*86400000)).toISOString());
        let baseline = snapshots.find(s=>s.recommendationId === recommendation.id && s.publicationDate === recommendation.publishedAt && s.publicationUrl === recommendation.publishedUrl && s.checkpoint === 0);
        const article = pending.some(checkpoint=>checkpoint>0) ? await this.verifier.verify(project,recommendation.publishedUrl || recommendation.url,this.now()) : null;
        const original = recommendation.candidate?.evidence.article;
        const baselineArticle = original?.verifiedAt && original.url===recommendation.publishedUrl && Date.parse(original.verifiedAt)<pub ? original : null;
        for (const checkpoint of pending) {
          const snapshot = geoBacklinkPerformanceSnapshot(recommendation,observed,checkpoint,this.now(),baseline,checkpoint===0?baselineArticle:article);
          if (!snapshot) continue;
          await this.runtime.repository.putGeoBacklinkPerformance(snapshot);
          if (checkpoint === 0) baseline = snapshot;
        }
      }
      if (offset+page.items.length>=page.total) break;
    }
    const {buildGeoBacklinkProgress}=await import('./geo-backlink-progress.js');
    const summary=await buildGeoBacklinkProgress(this.runtime,project,this.now());
    await this.runtime.artifacts.put(`geo-backlinks/${projectId}/progress-summary`,{...summary,pending:false});
    await this.runtime.artifacts.put(`geo-backlinks/${projectId}/progress-date`,{date});
  }
  async reconcile() {
    const {repository,queue,artifacts}=this.runtime;
    const now = this.now();
    for (let offset=0;;offset+=100) {
      const page = await repository.listGeoBacklinkProjects(offset,100);
      for (const project of page.items) {
        if (project.demo || !project.geoBacklinks?.enabled) continue;
        const month = dueGeoBacklinkMonth(now,project.timezone);
        if (month) {
          const {status} = await repository.reserveGeoBacklinkReport(newGeoReport(project,month,now));
          if (status === 'created')
            await queue.send([{kind:'geo-backlinks',projectId:project.id,month}]);
        }
        const date = now.toISOString().slice(0,10);
        const last = await artifacts.get<{date:string}>(`geo-backlinks/${project.id}/progress-date`);
        const summary = await artifacts.get<{pending?:boolean}>(`geo-backlinks/${project.id}/progress-summary`);
        if (last?.date !== date || summary?.pending) await queue.send([{kind:'geo-backlinks-progress',projectId:project.id,date}]);
      }
      if (offset+page.items.length>=page.total) break;
    }
    for (const report of await repository.listActiveGeoBacklinkReports(100,now.toISOString()))
      await queue.send([{kind:'geo-backlinks',projectId:report.projectId,month:report.month}]);
  }
}
