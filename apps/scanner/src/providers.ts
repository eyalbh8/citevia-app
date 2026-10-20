import { snapshotProvider, type ScanProvider } from '@citevia/core';
import type { AnswerProvider } from '@citevia/storage';
import { GeminiCollector } from './gemini.js';
import { PerplexityCollector } from './perplexity.js';
import { createOpenAIProviderFromEnv } from './openai.js';
import { providerApiKey } from './provider-http.js';

/** Collection uses each native API. A common OpenAI extractor validates exactly the saved answer. */
export function createScanProviderFromEnv(): AnswerProvider {
  let openai: Promise<AnswerProvider> | undefined;
  const extractor = () =>
    (openai ??= createOpenAIProviderFromEnv().catch((error) => {
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
  return {
    collect: async (prompt, snapshot) =>
      (await collector(snapshotProvider(snapshot))).collect(prompt, snapshot),
    extract: async (answer, snapshot) =>
      (await extractor()).extract(answer, snapshot),
  };
}
