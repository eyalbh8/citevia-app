import { createHash } from 'node:crypto';
import type { Analysis, CapturedAnswer, RunSnapshot } from '@citevia/core';
import type { AnswerProvider, ArtifactStore, CallLedger } from '@citevia/storage';
import { analysisRequest, parseAnalysisReceipt } from './analysis-request.js';
import { hasCompleteTokenUsage, observeCall } from './cost-observer.js';
import { extractionBody, object, type ProviderReceipt } from './provider.js';

const MAX_CACHE_AGE = 90 * 86400_000;
export function analysisCacheKey(answer: CapturedAnswer, snapshot: RunSnapshot): string | null {
  if (!snapshot.projectId) return null;
  // Exact model input includes company identities, instructions, schema and evidence.
  // Keep block IDs too: cache reuse must never transplant offsets onto other blocks.
  const data = { version: 1, parserVersion:snapshot.parserVersion, fallbackModel:snapshot.extractionFallbackModel, blocks:answer.blocks,
    body:extractionBody(analysisRequest(answer,snapshot)) };
  return `analysis-cache/${snapshot.projectId}/${createHash('sha256').update(JSON.stringify(data)).digest('hex')}.json`;
}
export interface AnalysisCacheEntry { savedAt: string; receipt: ProviderReceipt }
export async function cachedAnalysis(artifacts:ArtifactStore, answer:CapturedAnswer, snapshot:RunSnapshot, now = new Date()):Promise<Analysis|null> {
  const key = analysisCacheKey(answer,snapshot);
  if (!key || process.env.ANALYSIS_CACHE_ENABLED === 'false') return null;
  const entry = await artifacts.get<AnalysisCacheEntry>(key);
  if (!entry || !Number.isFinite(Date.parse(entry.savedAt)) || now.getTime()-Date.parse(entry.savedAt)>MAX_CACHE_AGE || Date.parse(entry.savedAt)>now.getTime()) return null;
  try {
    const parsed = parseAnalysisReceipt(entry.receipt,answer,snapshot);
    return {...parsed,reusedFrom:key,usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
  } catch { return null; }
}
export async function cacheAnalysis(artifacts:ArtifactStore, answer:CapturedAnswer, snapshot:RunSnapshot, analysis:Analysis, now = new Date()):Promise<void> {
  const key = analysisCacheKey(answer,snapshot), raw=object(analysis.raw);
  if (!key || !object(raw?.response) || process.env.ANALYSIS_CACHE_ENABLED === 'false') return;
  // Revalidate native receipt before caching; a normalized projection alone is not proof.
  const receipt=raw as unknown as ProviderReceipt;
  parseAnalysisReceipt(receipt,answer,snapshot);
  await artifacts.put(key,{savedAt:now.toISOString(),receipt} satisfies AnalysisCacheEntry);
}
export function optimizeScanProvider(provider:AnswerProvider, options:{artifacts:ArtifactStore;ledger?:CallLedger;now?:()=>Date}):AnswerProvider {
  const pending = new Map<string,Promise<Analysis>>();
  return {
    collect: (prompt,snapshot)=>snapshot.provider==='openai' || !snapshot.provider
      ? provider.collect(prompt,snapshot)
      : observeCall({ledger:options.ledger,provider:snapshot.provider,model:snapshot.generationModel,stage:'collection',context:{projectId:snapshot.projectId,...snapshot.execution},inputBytes:Buffer.byteLength(prompt)+1000,maxOutputTokens:8000,search:true,now:options.now},
          ()=>provider.collect(prompt,snapshot),answer=>({usage:answer.usage,
            usageComplete:hasCompleteTokenUsage(object(object(answer.raw)?.response) ?? {},snapshot.provider),
            model:answer.model,requestId:answer.requestId})),
    async extract(answer,snapshot) {
      const now=options.now?.() ?? new Date();
      const key=process.env.ANALYSIS_CACHE_ENABLED==='false'?null:analysisCacheKey(answer,snapshot);
      let saved: Analysis | null = null;
      try { saved=await cachedAnalysis(options.artifacts,answer,snapshot,now); }
      catch { console.error(JSON.stringify({event:'analysis_cache_read_skipped',projectId:snapshot.projectId})); }
      if (saved) return saved;
      if (key && pending.has(key)) {
        const shared=structuredClone(await pending.get(key)!);
        return {...shared,reusedFrom:key,usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
      }
      const work=(async()=>{
        const analysis=await provider.extract(answer,snapshot);
        try { await cacheAnalysis(options.artifacts,answer,snapshot,analysis,now); }
        catch { console.error(JSON.stringify({event:'analysis_cache_write_skipped',projectId:snapshot.projectId})); }
        return analysis;
      })();
      if (key) pending.set(key,work);
      try { return await work; } finally { if(key) pending.delete(key); }
    },
  };
}
