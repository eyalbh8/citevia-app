import { randomUUID } from 'node:crypto';
import type { Usage } from '@citevia/core';
import { CostBudgetError, type CallLedger, type ProviderCallIntent, type ProviderCallOutcome } from '@citevia/storage';
import { usage } from './normalize.js';
import { object, ProviderError, maximumSearchCalls, type NativeResponse, type ProviderReceipt, type ResponseProvider, type AnswerRequest, type ExtractionRequest, type ProviderCallContext } from './provider.js';

export const PRICE_VERSION = '2026-11-02';
export interface ModelPrice { input: number; output: number; cachedInput?: number; cacheWrite?: number; search?: number; imageInput?: number; longContextThreshold?: number }
export interface BillableUsage extends Usage { imageInputTokens?: number }
// USD per million tokens. Search is per invocation. Unknown models remain unpriced,
// rather than incorrectly reporting zero. Customer invoices remain authoritative.
const prices: Record<string, Record<string, ModelPrice>> = {
  openai: {
    // https://developers.openai.com/api/docs/models/gpt-6-astra
    'gpt-6-astra': { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5, search: .01, longContextThreshold: 272000 },
    // Images API does not discount cached input; output tokens are image tokens.
    // https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
    'gpt-image-2.5-sunburst': { input: 5, imageInput: 8, output: 30 },
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
          ['cachedInput','cacheWrite','search','imageInput','longContextThreshold'].some(key => key in value && (!Number.isFinite(value[key as keyof ModelPrice]) || Number(value[key as keyof ModelPrice]) < 0)))
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
export function estimateProviderCost(provider: string, model: string, tokens: BillableUsage, mode: 'realtime'|'batch' = 'realtime', at = new Date().toISOString()): number | null {
  const p = price(provider,model,at);
  if (!p) return null;
  if (p.longContextThreshold && tokens.inputTokens > p.longContextThreshold) {
    p.input *= 2; p.output *= 1.5;
    if (p.cachedInput !== undefined) p.cachedInput *= 2;
    if (p.cacheWrite !== undefined) p.cacheWrite *= 2;
  }
  // Split Images API input modalities instead of charging text rates for image tokens.
  const imageInput = Math.min(tokens.inputTokens, Math.max(0, tokens.imageInputTokens ?? 0));
  if (imageInput > 0 && p.imageInput === undefined) return null;
  const cached = Math.min(tokens.inputTokens-imageInput,Math.max(0,tokens.cachedInputTokens || 0));
  const written = Math.min(tokens.inputTokens-imageInput-cached,Math.max(0,tokens.cacheWriteTokens || 0));
  const discount = mode==='batch' ? .5 : 1;
  const tokenCost = ((tokens.inputTokens-imageInput-cached-written)*p.input + imageInput*(p.imageInput ?? 0) + cached*(p.cachedInput ?? p.input) + written*(p.cacheWrite ?? p.input) + tokens.outputTokens*p.output)/1e6;
  // Google search credits and provider invoice adjustments are deliberately not guessed.
  return tokenCost*discount + (tokens.searchCalls ?? tokens.searchQueries ?? 0)*(p.search ?? 0);
}
export function budgetFromEnv(name = 'LLM_MONTHLY_BUDGET_USD'): number {
  const value = Number(process.env[name] || 0);
  if (!Number.isFinite(value) || value<0) throw new Error(`${name} must be a nonnegative number.`);
  if (name === 'LLM_MONTHLY_BUDGET_USD' && process.env.ACCOUNT_MONTHLY_BUDGET_USD) {
    const total = budgetFromEnv('ACCOUNT_MONTHLY_BUDGET_USD');
    const infrastructure = budgetFromEnv('ACCOUNT_MONTHLY_INFRA_RESERVE_USD');
    if (total <= infrastructure) throw new Error('Account budget must exceed its infrastructure reserve.');
    return value > 0 ? Math.min(value, total - infrastructure) : total - infrastructure;
  }
  return value;
}
/** Explicit policy holds for variable image/tool workloads, not provider price quotes. */
export function reservationFromEnv(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : budgetFromEnv(name);
  if (value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}
export function providerReportedCost(response: NativeResponse): number | undefined {
  const cost = object(object(response.usage)?.cost);
  if (cost?.currency !== 'USD') return undefined;
  const amount = typeof cost.total_cost === 'number' ? cost.total_cost :
    typeof cost.total_cost === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cost.total_cost) ? Number(cost.total_cost) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}
export function imageBillableUsage(response: NativeResponse): BillableUsage {
  const details = object(object(response.usage)?.input_tokens_details);
  return { ...usage(response), cachedInputTokens: 0, cacheWriteTokens: 0,
    imageInputTokens: typeof details?.image_tokens === 'number' ? details.image_tokens : 0 };
}
export function hasCompleteImageUsage(response: NativeResponse): boolean {
  const counts = object(response.usage), details = object(counts?.input_tokens_details);
  return hasCompleteTokenUsage(response) && ['image_tokens', 'text_tokens'].every(key =>
    typeof details?.[key] === 'number' && Number.isSafeInteger(details[key]) && Number(details[key]) >= 0) &&
    Number(details?.image_tokens) + Number(details?.text_tokens) === counts?.input_tokens;
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
export function logBudgetDenial(code: string, context: { projectId?: string; provider: string; model: string; stage: string }): void {
  console.warn(JSON.stringify({ event: 'provider_budget_denied', code, projectId: context.projectId, provider: context.provider, model: context.model, stage: context.stage }));
}
export async function observeCall<T>(options: {
  ledger?: CallLedger; context?: ProviderCallContext; provider: string; model: string; stage: string;
  reservationUsd?: number | null;
  mode?: 'realtime'|'batch'; inputBytes: number; maxOutputTokens: number; search?: boolean; now?:()=>Date;
}, call:()=>Promise<T>, receipt:(value:T)=>{usage:BillableUsage;usageComplete?:boolean;model:string;requestId?:string|null;reportedUsd?:number}):Promise<T> {
  if (!options.ledger) return call();
  const at = () => (options.now?.() ?? new Date()).toISOString();
  const id = randomUUID();
  const reserveUsage:Usage = { inputTokens:Math.max(1,options.inputBytes),outputTokens:options.maxOutputTokens,totalTokens:0,...(options.search?{searchCalls:options.provider === 'openai' ? maximumSearchCalls() : 1}:{}) };
  const intent:ProviderCallIntent = {id,...options.context,stage:options.context?.stage||options.stage,provider:options.provider,model:options.model,mode:options.mode||'realtime',createdAt:at(),reservedUsd:options.reservationUsd !== undefined ? options.reservationUsd : estimateProviderCost(options.provider,options.model,reserveUsage,options.mode,at()),priceVersion:PRICE_VERSION};
  if (options.search && options.reservationUsd === undefined && intent.reservedUsd !== null)
    intent.reservedUsd = Math.max(intent.reservedUsd, reservationFromEnv('LLM_SEARCH_RESERVATION_USD', 1));
  const perRequest = budgetFromEnv('LLM_MAX_REQUEST_USD');
  if (perRequest > 0 && (intent.reservedUsd === null || intent.reservedUsd > perRequest)) {
    logBudgetDenial('cost_request_budget_exceeded', intent);
    throw new ProviderError('cost_request_budget_exceeded', 'This request exceeds the configured estimated provider cost limit.', false);
  }
  try { await options.ledger.reserve(intent,budgetFromEnv(),budgetFromEnv('LLM_GLOBAL_MONTHLY_BUDGET_USD')); }
  catch(error) {
    if(error instanceof CostBudgetError) {
      logBudgetDenial(error.code, intent);
      throw new ProviderError(error.code,error.message,false);
    }
    throw error;
  }
  try {
    const result=await call(), { usageComplete = true, reportedUsd, ...details }=receipt(result);
    await settleCall(options.ledger,id,{status:usageComplete || reportedUsd !== undefined?'succeeded':'uncertain',completedAt:at(),...details,
      estimatedUsd:reportedUsd ?? (usageComplete?estimateProviderCost(options.provider,details.model,details.usage,options.mode,at()):null),
      ...(!usageComplete && reportedUsd === undefined?{errorCode:'provider_usage_unavailable'}:{})});
    return result;
  } catch(error) {
    // Explicit admission rejection is not a purchased inference. Preserve the
    // reservation for ambiguous transport/server failures, even if retriable.
    const rejected = error instanceof ProviderError &&
      (error.kind === 'deferred' || error.kind === 'quota' || error.httpStatus === 429 ||
        [400, 401, 403, 404, 422].includes(error.httpStatus ?? 0));
    await settleCall(options.ledger,id,{status:rejected?'failed':'uncertain',completedAt:at(),estimatedUsd:rejected?0:null,errorCode:error instanceof ProviderError?error.code:'provider_error'});
    throw error;
  }
}

export function observeResponseProvider(provider: ResponseProvider, ledger: CallLedger): ResponseProvider {
  const run = (request: AnswerRequest | ExtractionRequest, search: boolean) => observeCall({ledger,context:request.costContext,provider:'openai',model:request.model,stage:search?'research':'content',inputBytes:Buffer.byteLength(JSON.stringify(request)),maxOutputTokens:request.maxOutputTokens ?? (search?8000:12000),search},
    ()=>search?provider.answer(request as AnswerRequest):provider.extract(request as ExtractionRequest),
    (r:ProviderReceipt)=>({usage:usage(r.response),usageComplete:hasCompleteTokenUsage(r.response),model:String(r.response.model||request.model),requestId:r.requestId}));
  return {answer:request=>run(request,true),extract:request=>run(request,false)};
}
