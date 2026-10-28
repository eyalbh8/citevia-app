import { analysisProvider, snapshotProvider, type ScanProvider } from '@citevia/core';
import { PostgresCallLedger, productionDatabase, SqlProviderAdmissionStore, type AnswerProvider, type CallLedger, type Runtime } from '@citevia/storage';
import { GeminiCollector } from './gemini.js';
import { GeminiAnalysisProvider } from './gemini-analysis.js';
import { PerplexityCollector } from './perplexity.js';
import { createOpenAIProviderFromEnv, OpenAIAnswerProvider } from './openai.js';
import { providerApiKey } from './provider-http.js';
import { observeScanProviderCollections, optimizeScanProvider } from './analysis-costs.js';
import { guardScanProvider } from './provider-admission.js';
import { hasCompleteTokenUsage, observeCall } from './cost-observer.js';
import { usage } from './normalize.js';

/** Collection uses each native API; the saved extraction model selects its analyzer. */
export function createScanProviderFromEnv(runtime?: Pick<Runtime,'artifacts'>, suppliedLedger?: CallLedger): AnswerProvider {
  const ledger = suppliedLedger ?? (process.env.APP_MODE === 'aws' ? new PostgresCallLedger(productionDatabase(),runtime?.artifacts) : undefined);
  let openai: Promise<AnswerProvider> | undefined;
  const openaiProvider = () =>
    (openai ??= createOpenAIProviderFromEnv(ledger).catch((error) => {
      openai = undefined;
      throw error;
    }));
  let gemini: Promise<AnswerProvider> | undefined;
  const geminiExtractor = () => (gemini ??= providerApiKey('gemini').then((apiKey) => {
    const transport = new GeminiAnalysisProvider({ apiKey });
    return new OpenAIAnswerProvider({
      async answer() { throw new Error('Gemini analysis cannot collect answers.'); },
      extract: request => observeCall({ ledger, context: request.costContext, provider: 'gemini', model: request.model,
        stage: 'analysis', inputBytes: Buffer.byteLength(JSON.stringify(request)), maxOutputTokens: request.maxOutputTokens ?? 12000 },
      () => transport.extract(request), receipt => ({ usage: usage(receipt.response),
        usageComplete: hasCompleteTokenUsage(receipt.response, 'gemini'),
        model: String(receipt.response.modelVersion ?? request.model), requestId: receipt.requestId })),
    });
  }).catch((error) => { gemini = undefined; throw error; }));
  const collectors = new Map<
    ScanProvider,
    Promise<Pick<AnswerProvider, 'collect'>>
  >();
  async function collector(provider: ScanProvider) {
    let pending = collectors.get(provider);
    if (!pending) {
      pending = (
        provider === 'openai'
          ? openaiProvider()
          : providerApiKey(provider).then((apiKey) =>
              provider === 'gemini'
                ? new GeminiCollector({ apiKey })
                : new PerplexityCollector({ apiKey }),
            )
      ).catch((error) => {
        collectors.delete(provider);
        throw error;
      });
      collectors.set(provider, pending);
    }
    return pending;
  }
  const provider: AnswerProvider = {
    collect: async (prompt, snapshot) =>
      (await collector(snapshotProvider(snapshot))).collect(prompt, snapshot),
    extract: async (answer, snapshot) => {
      const scope = analysisProvider(snapshot.extractionModel);
      // A fallback never silently changes the billing provider of the frozen run.
      const config = snapshot.extractionFallbackModel && analysisProvider(snapshot.extractionFallbackModel) !== scope
        ? { ...snapshot, extractionFallbackModel: undefined } : snapshot;
      return (await (scope === 'gemini' ? geminiExtractor() : openaiProvider())).extract(answer, config);
    },
  };
  const observed = observeScanProviderCollections(provider, { ledger });
  const guarded = process.env.APP_MODE === 'aws'
    ? guardScanProvider(observed, new SqlProviderAdmissionStore(productionDatabase())) : observed;
  return runtime ? optimizeScanProvider(guarded, { artifacts: runtime.artifacts }) : guarded;
}
