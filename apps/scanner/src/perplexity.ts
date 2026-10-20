import type {
  CapturedAnswer,
  Citation,
  RetrievedSource,
  RunSnapshot,
} from '@citevia/core';
import { object, type ProviderReceipt } from './provider.js';
import { normalizeAnswer, safeUrl } from './normalize.js';
import { providerPost, type HttpOptions } from './provider-http.js';

export function perplexityBody(prompt: string, snapshot: RunSnapshot) {
  const language = snapshot.language.split('-')[0];
  return {
    preset: snapshot.generationModel,
    input: prompt,
    // Preserve the preset's native search and citation instructions.
    ...(/^[a-z]{2}$/.test(language) ? { language_preference: language } : {}),
    store: false,
    tools: [
      { type: 'web_search', user_location: { country: snapshot.country } },
    ],
    max_output_tokens: 8000,
  };
}
export function normalizePerplexity(
  receipt: ProviderReceipt,
  fallbackModel: string,
): CapturedAnswer {
  const answer = normalizeAnswer(receipt, fallbackModel);
  const sources: RetrievedSource[] = [];
  const sourceIds = new Map<string, Set<string>>();
  const titles = new Map<string, string>();
  for (const item of receipt.response.output ?? []) {
    const value = object(item);
    if (value?.type !== 'search_results' || !Array.isArray(value.results))
      continue;
    for (const raw of value.results) {
      const result = object(raw),
        url = safeUrl(result?.url);
      if (!url) continue;
      const title = typeof result?.title === 'string' ? result.title : url;
      sources.push({ url, title, type: 'web' });
      titles.set(url, title);
      if (
        Number.isInteger(result?.id) ||
        (typeof result?.id === 'string' &&
          /^(?:[A-Za-z_]+:)?\d+$/.test(result.id))
      ) {
        const id = String(result!.id),
          urls = sourceIds.get(id) ?? new Set<string>();
        urls.add(url);
        sourceIds.set(id, urls);
      }
    }
  }
  const citations: Citation[] = [...answer.citations];
  // Agent API cites numeric source IDs in answer text. Never interpret source-list order as rank.
  // Ambiguous IDs across multiple search steps are retained in raw, without inventing attribution.
  for (const block of answer.blocks)
    for (const match of block.text.matchAll(/\[((?:[A-Za-z_]+:)?\d+)\]/g)) {
      const urls = sourceIds.get(match[1]);
      if (urls?.size !== 1) continue;
      const url = [...urls][0],
        start = match.index!,
        end = start + match[0].length;
      if (
        !citations.some(
          (c) =>
            c.blockId === block.id &&
            c.url === url &&
            c.start !== null &&
            c.end !== null &&
            c.start <= start &&
            c.end >= end,
        )
      )
        citations.push({
          id: `${block.id}_source_${start}`,
          blockId: block.id,
          url,
          title: titles.get(url) || url,
          start,
          end,
        });
    }
  const { searchCalls: _searchCalls, ...tokenUsage } = answer.usage;
  const details = object(object(receipt.response.usage)?.tool_calls_details);
  const searchCalls = object(details?.search_web)?.invocation;
  return {
    ...answer,
    provider: 'perplexity',
    citations,
    sources,
    model:
      typeof receipt.response.preset === 'string'
        ? `${receipt.response.preset} / ${answer.model}`
        : answer.model,
    usage: {
      ...tokenUsage,
      ...(typeof searchCalls === 'number' &&
      Number.isInteger(searchCalls) &&
      searchCalls >= 0
        ? { searchCalls }
        : {}),
    },
  };
}
export class PerplexityCollector {
  constructor(private readonly options: HttpOptions) {}
  async collect(prompt: string, snapshot: RunSnapshot) {
    return normalizePerplexity(
      await providerPost(
        'perplexity',
        'https://api.perplexity.ai/v1/agent',
        perplexityBody(prompt, snapshot),
        this.options,
      ),
      snapshot.generationModel,
    );
  }
}
