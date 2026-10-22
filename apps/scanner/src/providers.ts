import { snapshotProvider, type ScanProvider } from '@citevia/core';
import { PostgresCallLedger, productionDatabase, SqlProviderAdmissionStore, type AnswerProvider, type CallLedger, type Runtime } from '@citevia/storage';
import { GeminiCollector } from './gemini.js';
import { PerplexityCollector } from './perplexity.js';
import { createOpenAIProviderFromEnv } from './openai.js';
import { providerApiKey } from './provider-http.js';
import { observeScanProviderCollections, optimizeScanProvider } from './analysis-costs.js';
import { guardScanProvider } from './provider-admission.js';

/** Collection uses each native API. A common OpenAI extractor validates exactly the saved answer. */
export function createScanProviderFromEnv(runtime?: Pick<Runtime,'artifacts'>, suppliedLedger?: CallLedger): AnswerProvider {
  const ledger = suppliedLedger ?? (process.env.APP_MODE === 'aws' ? new PostgresCallLedger(productionDatabase(),runtime?.artifacts) : undefined);
  let openai: Promise<AnswerProvider> | undefined;
  const extractor = () =>
    (openai ??= createOpenAIProviderFromEnv(ledger).catch((error) => {
      openai = undefined;
      throw error;
    }));
  const collectors = new Map<
    ScanProvider,
    Promise<Pick<AnswerProvider, 'collect'>>
  >();
  async function collector(provider: ScanProvider) {
    let pending = collectors.get(provider);
    if (!pending) {
      pending = (
        provider === 'openai'
          ? extractor()
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
    extract: async (answer, snapshot) =>
      (await extractor()).extract(answer, snapshot),
  };
  const observed = observeScanProviderCollections(provider, { ledger });
  const guarded = process.env.APP_MODE === 'aws'
    ? guardScanProvider(observed, new SqlProviderAdmissionStore(productionDatabase())) : observed;
  return runtime ? optimizeScanProvider(guarded, { artifacts: runtime.artifacts }) : guarded;
}
