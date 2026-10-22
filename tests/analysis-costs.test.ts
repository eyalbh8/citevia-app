import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryCallLedger, PostgresCallLedger, summarizeProviderCosts, type ProviderCallIntent } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { captured, snapshot, project, target } from '../apps/scanner/test/fixtures.js';
import { analysisCacheKey, cachedAnalysis, optimizeScanProvider } from '../apps/scanner/src/analysis-costs.js';
import { analysisRequest } from '../apps/scanner/src/analysis-request.js';
import { OpenAIAnswerProvider } from '../apps/scanner/src/openai.js';
import { estimateProviderCost, observeResponseProvider } from '../apps/scanner/src/cost-observer.js';
import { PostgresRepository } from '@citevia/storage';
import { extractionBody, ProviderError } from '../apps/scanner/src/provider.js';

afterEach(()=>vi.unstubAllEnvs());
const at = '2026-10-22T12:00:00.000Z';
const saved = {...snapshot,projectId:project.id,competitors:[],parserVersion:'igeo-evidence-v2',extractionModel:'gpt-6-luna'};
const native = () => ({requestId:'provider-1',receivedAt:at,response:{model:'gpt-6-luna',status:'completed',usage:{input_tokens:3000,output_tokens:400,total_tokens:3400,input_tokens_details:{cached_tokens:1000},output_tokens_details:{reasoning_tokens:20}},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({companies:[{name:'Acme',evidenceId:0,sentiment:'positive',sentimentEvidenceId:0}],brands:{[target.id]:{mentioned:true,sentiment:'positive',evidenceIds:[0],sentimentEvidenceId:0,explicitRank:null,rankEvidenceId:null}}})}]}]}});

describe('exact analysis reuse',()=>{
  it('revalidates cached evidence, scopes it to the account/configuration, and charges zero new tokens',async()=>{
    const artifacts=new MemoryArtifacts();
    const extract=vi.fn(async()=>native());
    const provider=optimizeScanProvider(new OpenAIAnswerProvider({answer:vi.fn(),extract}),{artifacts,now:()=>new Date(at)});
    const answer=captured('Acme is useful.');
    const first=await provider.extract(answer,saved);
    const second=await provider.extract(answer,saved);
    expect(extract).toHaveBeenCalledOnce();
    expect(first.usage).toMatchObject({inputTokens:3000,cachedInputTokens:1000,reasoningTokens:20});
    expect(second.usage).toEqual({inputTokens:0,outputTokens:0,totalTokens:0});
    expect(second.brands).toEqual(first.brands);
    expect(second.reusedFrom).toBe(analysisCacheKey(answer,saved));
    expect(analysisCacheKey(answer,{...saved,projectId:'another-account'})).not.toBe(second.reusedFrom);
    expect(analysisCacheKey(answer,{...saved,extractionModel:'other-model'})).not.toBe(second.reusedFrom);
    expect(analysisCacheKey(answer,{...saved,brand:{...saved.brand,aliases:['Different']}})).not.toBe(second.reusedFrom);
    expect(analysisCacheKey({...answer,blocks:[{...answer.blocks[0],id:'changed-block'}]},saved)).not.toBe(second.reusedFrom);
    // The cost-only context must not cause misses or leave local metadata in provider bodies.
    expect(analysisCacheKey(answer,{...saved,execution:{runId:'different',promptId:'different',attempt:3}})).toBe(second.reusedFrom);
    expect(extractionBody(analysisRequest(answer,saved))).not.toHaveProperty('costContext');
  });
  it('ignores corrupted and expired entries, and never reuses data without an account scope',async()=>{
    const artifacts=new MemoryArtifacts(),answer=captured('Acme is useful.'),key=analysisCacheKey(answer,saved)!;
    await artifacts.put(key,{savedAt:at,receipt:{...native(),response:{...native().response,output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}}});
    expect(await cachedAnalysis(artifacts,answer,saved,new Date(at))).toBeNull();
    await artifacts.put(key,{savedAt:'2026-01-01T00:00:00Z',receipt:native()});
    expect(await cachedAnalysis(artifacts,answer,saved,new Date(at))).toBeNull();
    expect(analysisCacheKey(answer,{...saved,projectId:undefined})).toBeNull();
  });
  it('continues with paid analysis when an optional cache read fails or contains invalid JSON',async()=>{
    for (const error of [new Error('Storage unavailable'),new SyntaxError('Malformed cached JSON')]) {
      const artifacts=new MemoryArtifacts();
      vi.spyOn(artifacts,'get').mockRejectedValueOnce(error);
      const extract=vi.fn(async()=>native());
      const provider=optimizeScanProvider(new OpenAIAnswerProvider({answer:vi.fn(),extract}),{artifacts,now:()=>new Date(at)});
      const parsed=await provider.extract(captured('Acme is useful.'),saved);
      expect(parsed.brands[0].mentioned).toBe(true);
      expect(extract).toHaveBeenCalledOnce();
    }
  });
  it('sends only evidence IDs/text while preserving the server evidence catalog',()=>{
    const request=analysisRequest(captured('Acme is useful.'),saved);
    expect(request.input).toMatchObject({evidence_catalog:[{id:0,quote:'Acme is useful.'}]});
    const row=(request.input as {evidence_catalog:unknown[]}).evidence_catalog[0];
    expect(row).not.toHaveProperty('start'); expect(row).not.toHaveProperty('blockId');
    expect(extractionBody(request).reasoning).toEqual({effort:'none'});
  });
  it('uses at most one configured fallback for invalid output and never after a timeout',async()=>{
    const bad={...native(),response:{...native().response,output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}};
    const extract=vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce({...native(),response:{...native().response,model:'fallback-model'}});
    const provider=new OpenAIAnswerProvider({extract,answer:vi.fn()});
    const config={...saved,extractionFallbackModel:'fallback-model'};
    const result=await provider.extract(captured('Acme is useful.'),config);
    expect(result.model).toBe('fallback-model');
    expect(result.raw).toHaveProperty('rejectedPrimaryReceipt');
    expect(extract).toHaveBeenCalledTimes(2);
    expect(analysisCacheKey(captured(),config)).not.toBe(analysisCacheKey(captured(),saved));
    extract.mockReset().mockRejectedValue(new ProviderError('openai_timeout','timeout',true));
    await expect(provider.extract(captured(),config)).rejects.toMatchObject({code:'openai_timeout'});
    expect(extract).toHaveBeenCalledOnce();
  });
  it('preserves the paid primary receipt and prevents a fallback timeout from replaying legacy analysis',async()=>{
    const bad={...native(),response:{...native().response,output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}};
    const extract=vi.fn().mockResolvedValueOnce(bad).mockRejectedValueOnce(new ProviderError('openai_timeout','timeout',true,'fallback-request'));
    const provider=new OpenAIAnswerProvider({extract,answer:vi.fn()});
    await expect(provider.extract(captured(),{...saved,parserVersion:'legacy-parser',extractionFallbackModel:'fallback-model'})).rejects.toMatchObject({
      code:'openai_timeout',retryable:false,
      receipt:{response:bad.response,fallbackRequestFailure:{code:'openai_timeout',requestId:'fallback-request'}},
    });
    expect(extract).toHaveBeenCalledTimes(2);
    extract.mockReset().mockResolvedValueOnce(bad).mockRejectedValueOnce(new Error('Ledger unavailable'));
    await expect(provider.extract(captured(),{...saved,parserVersion:'legacy-parser',extractionFallbackModel:'fallback-model'})).rejects.toMatchObject({
      code:'analysis_fallback_failed',retryable:false,receipt:{response:bad.response},
    });
    expect(extract).toHaveBeenCalledTimes(2);
  });
});

describe('provider cost observations and budgets',()=>{
  it('prices input-cache subsets once, includes reasoning in output, and leaves unknown models unpriced',()=>{
    expect(estimateProviderCost('openai','gpt-6-luna',{inputTokens:3000,outputTokens:400,totalTokens:3400},'batch')).toBeCloseTo(.00025);
    expect(estimateProviderCost('openai','gpt-6-luna',{inputTokens:3000,cachedInputTokens:1000,outputTokens:400,reasoningTokens:20,totalTokens:3400})).toBeCloseTo(.00041);
    expect(estimateProviderCost('openai','unknown',{inputTokens:10,outputTokens:20,totalTokens:30})).toBeNull();
    expect(estimateProviderCost('openai','gpt-4.1-nano',{inputTokens:10,outputTokens:20,totalTokens:30})).toBeNull();
    expect(estimateProviderCost('openai','gpt-4.1-mini-other-model',{inputTokens:10,outputTokens:20,totalTokens:30})).toBeNull();
    expect(estimateProviderCost('openai','gpt-4.1-mini-2025-04-14',{inputTokens:1000000,outputTokens:0,totalTokens:1000000})).toBe(.4);
    expect(estimateProviderCost('gemini','gemini-3.8-flash',{inputTokens:1000000,outputTokens:1000000,totalTokens:2000000},'realtime','2027-01-02')).toBe(9);
  });
  it('records every paid attempt including failures without retaining prompt/response content',async()=>{
    const ledger=new MemoryCallLedger();
    const extract=vi.fn().mockResolvedValueOnce(native()).mockRejectedValueOnce(new ProviderError('openai_timeout','timed out',true));
    const provider=observeResponseProvider({extract,answer:vi.fn()},ledger);
    const request=analysisRequest(captured('Acme is useful.'),saved);
    await provider.extract(request);
    await expect(provider.extract(request)).rejects.toMatchObject({code:'openai_timeout'});
    expect(ledger.calls.size).toBe(2);
    const calls=[...ledger.calls.values()];
    expect(calls[0].outcome).toMatchObject({status:'succeeded',usage:{cachedInputTokens:1000,reasoningTokens:20}});
    expect(calls[1].outcome).toMatchObject({status:'uncertain',estimatedUsd:null});
    expect(JSON.stringify(calls)).not.toContain('Acme is useful');
  });
  it('checks an estimated budget before starting a request, and blocks unpriced models with a budget',async()=>{
    vi.stubEnv('LLM_MONTHLY_BUDGET_USD','0.000001');
    const extract=vi.fn(),ledger=new MemoryCallLedger();
    const provider=observeResponseProvider({extract,answer:vi.fn()},ledger);
    await expect(provider.extract(analysisRequest(captured(),saved))).rejects.toMatchObject({code:'cost_budget_exceeded',retryable:false});
    expect(extract).not.toHaveBeenCalled();
    await expect(provider.extract(analysisRequest(captured(),{...saved,extractionModel:'unknown'}))).rejects.toMatchObject({code:'cost_unpriced_request'});
  });
  it('holds reservations for missing or partial native usage instead of recording a free request',async()=>{
    const ledger=new MemoryCallLedger();
    const receipts=[
      {...native(),response:{...native().response,usage:undefined}},
      {...native(),response:{...native().response,usage:{input_tokens:3000}}},
    ];
    const extract=vi.fn().mockResolvedValueOnce(receipts[0]).mockResolvedValueOnce(receipts[1]);
    const provider=observeResponseProvider({extract,answer:vi.fn()},ledger);
    for (let index=0;index<receipts.length;index++) await provider.extract(analysisRequest(captured(),saved));
    const calls=[...ledger.calls.values()];
    expect(calls.every(call=>Number(call.intent.reservedUsd)>0)).toBe(true);
    expect(calls.every(call=>call.outcome?.estimatedUsd===null && call.outcome.status==='uncertain')).toBe(true);
    expect(calls[1].outcome).toMatchObject({usage:{inputTokens:3000,outputTokens:0},errorCode:'provider_usage_unavailable'});
    const held=calls.reduce((sum,call)=>sum+Number(call.outcome?.estimatedUsd ?? call.intent.reservedUsd),0);
    await expect(ledger.reserve({...calls[0].intent,id:'additional',reservedUsd:.1},held+.05)).rejects.toMatchObject({code:'cost_budget_exceeded'});
  });
  it('preserves uncertain native Gemini and Perplexity collection usage after normalization',async()=>{
    for (const providerName of ['gemini','perplexity'] as const) {
      const ledger=new MemoryCallLedger();
      const partial={...captured(),model:providerName==='gemini'?'gemini-3.8-flash':'unpriced-perplexity',
        usage:{inputTokens:123,outputTokens:0,totalTokens:123},
        raw:{response:providerName==='gemini'?{usageMetadata:{promptTokenCount:123}}:{usage:{input_tokens:123}}},
      };
      const collect=vi.fn(async()=>partial);
      const provider=optimizeScanProvider({collect,extract:vi.fn()},{artifacts:new MemoryArtifacts(),ledger});
      await provider.collect('Saved prompt',{...saved,provider:providerName,generationModel:partial.model});
      const call=[...ledger.calls.values()][0];
      expect(call.outcome).toMatchObject({status:'uncertain',estimatedUsd:null,usage:{inputTokens:123},errorCode:'provider_usage_unavailable'});
      expect(collect).toHaveBeenCalledOnce();
    }
  });
  it('keeps SQL reservations/outcomes append-only and idempotent with account-scoped admission',async()=>{
    const db=await localPostgres();
    try {
      await new PostgresRepository(db).saveProject(project,null);
      const ledger=new PostgresCallLedger(db);
      const intent:ProviderCallIntent={id:'call-1',projectId:project.id,stage:'analysis',provider:'openai',model:'gpt-6-luna',mode:'realtime',createdAt:at,reservedUsd:.6,priceVersion:'2026-10-22'};
      await ledger.reserve(intent,1);
      await ledger.reserve(intent,1);
      await expect(ledger.reserve({...intent,id:'call-2'},1)).rejects.toMatchObject({code:'cost_budget_exceeded'});
      await ledger.settle('call-1',{status:'succeeded',completedAt:at,estimatedUsd:.1});
      await ledger.settle('call-1',{status:'succeeded',completedAt:at,estimatedUsd:999});
      await ledger.reserve({...intent,id:'call-2'},1);
      const rows=(await db.query('SELECT phase,data FROM citevia_cost_events WHERE call_id=$1 ORDER BY phase',['call-1'])).rows;
      expect(rows).toHaveLength(2);
      expect(rows.find(r=>r.phase==='outcome')?.data).toMatchObject({estimatedUsd:.1});
      const report=await summarizeProviderCosts(db,{start:'2026-10-01',end:'2026-11-01',projectId:project.id});
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({attempts:2,succeeded:1,unresolved:1});
      expect(Number(report.rows[0].estimated_completed_usd)).toBeCloseTo(.1);
      expect(Number(report.rows[0].outstanding_reserved_usd)).toBeCloseTo(.6);
    } finally {await db.close();}
  },30000);
  it('stages attempt metadata before013 exists and never bypasses an enabled budget',async()=>{
    const db=await localPostgres(undefined,{migrate:false});
    try {
      const artifacts=new MemoryArtifacts(),ledger=new PostgresCallLedger(db,artifacts);
      const intent:ProviderCallIntent={id:'pre-migration',projectId:project.id,stage:'analysis',provider:'openai',model:'gpt-6-luna',mode:'realtime',createdAt:at,reservedUsd:.01,priceVersion:'2026-10-22'};
      await ledger.reserve(intent);
      await ledger.settle(intent.id,{status:'succeeded',completedAt:at,estimatedUsd:.001});
      expect(await artifacts.get(`provider-costs/${intent.id}/reservation.json`)).toEqual(intent);
      expect(await artifacts.get(`provider-costs/${intent.id}/outcome.json`)).toMatchObject({estimatedUsd:.001});
      await expect(ledger.reserve({...intent,id:'budget-needs-sql'},1)).rejects.toMatchObject({code:'42P01'});
      expect(await artifacts.get('provider-costs/budget-needs-sql/reservation.json')).toBeNull();
    } finally {await db.close();}
  },30000);
});
