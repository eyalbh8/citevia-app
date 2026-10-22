import { randomUUID } from 'node:crypto';
import type { Usage } from '@citevia/core';
import { CostBudgetError, type CallLedger, type ProviderCallIntent, type ProviderCallOutcome } from '@citevia/storage';
import { usage } from './normalize.js';
import { object, ProviderError, type NativeResponse, type ProviderReceipt, type ResponseProvider, type AnswerRequest, type ExtractionRequest, type ProviderCallContext } from './provider.js';

export const PRICE_VERSION = '2026-10-22';
export interface ModelPrice { input: number; output: number; cachedInput?: number; cacheWrite?: number; search?: number }
// USD per million tokens. Search is per invocation. Unknown models remain unpriced,
// rather than incorrectly reporting zero. Customer invoices remain authoritative.
const prices: Record<string, Record<string, ModelPrice>> = {
  openai: {
    'gpt-6-luna': { input: .1, output: .5, cachedInput: .01, cacheWrite: .125, search: .01 },
    'gpt-4.1-mini': { input: .4, output: 1.6, cachedInput: .1, search: .01 },
    'gpt-4.1': { input: 2, output: 8, cachedInput: .5, search: .01 },
  },
  gemini: {
    'gemini-3.8-flash': { input: .75, output: 3.75, cachedInput: .075, search: .014 },
    'gemini-3.5-flash-lite': { input: .3, output: 2.5, cachedInput: .03, search: .014 },
  },
};
function price(provider: string, model: string, at: string): ModelPrice | null {
  let configured: Record<string, Record<string, ModelPrice>> = {};
  if (process.env.LLM_MODEL_PRICES_JSON) {
    configured = JSON.parse(process.env.LLM_MODEL_PRICES_JSON);
    for (const models of Object.values(configured)) for (const value of Object.values(models))
      if (!value || !Number.isFinite(value.input) || value.input < 0 || !Number.isFinite(value.output) || value.output < 0 ||
          ['cachedInput','cacheWrite','search'].some(key => key in value && (!Number.isFinite(value[key as keyof ModelPrice]) || Number(value[key as keyof ModelPrice]) < 0)))
        throw new Error('LLM_MODEL_PRICES_JSON contains an invalid price.');
  }
  const entries = { ...prices[provider], ...configured[provider] };
  // A dated snapshot inherits its alias price. Another model family (nano/image/etc.) does not.
  const key = Object.keys(entries).sort((a,b)=>b.length-a.length).find(k=>model===k ||
    (model.startsWith(`${k}-`) && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(k.length+1))));
  if (!key) return null;
  const value = { ...entries[key] };
  if (provider==='gemini' && key==='gemini-3.8-flash' && at >= '2027-01-01' && !configured[provider]?.[key]) {
    value.input *= 2; value.output *= 2; if (value.cachedInput) value.cachedInput *= 2;
  }
  return value;
}
export function estimateProviderCost(provider: string, model: string, tokens: Usage, mode: 'realtime'|'batch' = 'realtime', at = new Date().toISOString()): number | null {
  const p = price(provider,model,at);
  if (!p) return null;
  const cached = Math.min(tokens.inputTokens,Math.max(0,tokens.cachedInputTokens || 0));
  const written = Math.min(tokens.inputTokens-cached,Math.max(0,tokens.cacheWriteTokens || 0));
  const discount = mode==='batch' ? .5 : 1;
  const tokenCost = ((tokens.inputTokens-cached-written)*p.input + cached*(p.cachedInput ?? p.input) + written*(p.cacheWrite ?? p.input) + tokens.outputTokens*p.output)/1e6;
  // Google search credits and provider invoice adjustments are deliberately not guessed.
  return tokenCost*discount + (tokens.searchCalls ?? tokens.searchQueries ?? 0)*(p.search ?? 0);
}
export function budgetFromEnv(): number {
  const value = Number(process.env.LLM_MONTHLY_BUDGET_USD || 0);
  if (!Number.isFinite(value) || value<0) throw new Error('LLM_MONTHLY_BUDGET_USD must be a nonnegative number.');
  return value;
}
export async function settleCall(ledger: CallLedger, id: string, outcome: ProviderCallOutcome): Promise<void> {
  try { await ledger.settle(id,outcome); }
  catch { console.error(JSON.stringify({event:'provider_cost_outcome_unsaved',callId:id})); }
}
/** Normalization fills missing counters with zero; billing estimates must distinguish missing from a real zero. */
export function hasCompleteTokenUsage(response: NativeResponse, provider: 'openai'|'gemini'|'perplexity' = 'openai'): boolean {
  const tokens = object(provider==='gemini' ? response.usageMetadata : response.usage);
  const keys = provider==='gemini' ? ['promptTokenCount','candidatesTokenCount'] : ['input_tokens','output_tokens'];
  return keys.every(key =>
    typeof tokens?.[key] === 'number' && Number.isSafeInteger(tokens[key]) && Number(tokens[key]) >= 0);
}
export async function observeCall<T>(options: {
  ledger?: CallLedger; context?: ProviderCallContext; provider: string; model: string; stage: string;
  mode?: 'realtime'|'batch'; inputBytes: number; maxOutputTokens: number; search?: boolean; now?:()=>Date;
}, call:()=>Promise<T>, receipt:(value:T)=>{usage:Usage;usageComplete?:boolean;model:string;requestId?:string|null}):Promise<T> {
  if (!options.ledger) return call();
  const at = () => (options.now?.() ?? new Date()).toISOString();
  const id = randomUUID();
  const reserveUsage:Usage = { inputTokens:Math.max(1,options.inputBytes),outputTokens:options.maxOutputTokens,totalTokens:0,...(options.search?{searchCalls:1}:{}) };
  const intent:ProviderCallIntent = {id,...options.context,stage:options.context?.stage||options.stage,provider:options.provider,model:options.model,mode:options.mode||'realtime',createdAt:at(),reservedUsd:estimateProviderCost(options.provider,options.model,reserveUsage,options.mode,at()),priceVersion:PRICE_VERSION};
  try { await options.ledger.reserve(intent,budgetFromEnv()); }
  catch(error) {
    if(error instanceof CostBudgetError) throw new ProviderError(error.code,error.message,false);
    throw error;
  }
  try {
    const result=await call(), { usageComplete = true, ...details }=receipt(result);
    await settleCall(options.ledger,id,{status:usageComplete?'succeeded':'uncertain',completedAt:at(),...details,
      estimatedUsd:usageComplete?estimateProviderCost(options.provider,details.model,details.usage,options.mode,at()):null,
      ...(!usageComplete?{errorCode:'provider_usage_unavailable'}:{})});
    return result;
  } catch(error) {
    await settleCall(options.ledger,id,{status:'uncertain',completedAt:at(),estimatedUsd:null,errorCode:error instanceof ProviderError?error.code:'provider_error'});
    throw error;
  }
}

export function observeResponseProvider(provider: ResponseProvider, ledger: CallLedger): ResponseProvider {
  const run = (request: AnswerRequest | ExtractionRequest, search: boolean) => observeCall({ledger,context:request.costContext,provider:'openai',model:request.model,stage:search?'research':'content',inputBytes:Buffer.byteLength(JSON.stringify(request)),maxOutputTokens:request.maxOutputTokens ?? (search?8000:12000),search},
    ()=>search?provider.answer(request as AnswerRequest):provider.extract(request as ExtractionRequest),
    (r:ProviderReceipt)=>({usage:usage(r.response),usageComplete:hasCompleteTokenUsage(r.response),model:String(r.response.model||request.model),requestId:r.requestId}));
  return {answer:request=>run(request,true),extract:request=>run(request,false)};
}
