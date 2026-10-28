import type {
  CapturedAnswer,
  Citation,
  RetrievedSource,
  TextBlock,
  Usage,
} from '@citevia/core';
import {
  object,
  type NativeResponse,
  type ProviderReceipt,
} from './provider.js';

const nonnegative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
export function usage(response: NativeResponse): Usage {
  const gemini = object(response.usageMetadata);
  if (gemini) return {
    inputTokens: nonnegative(gemini.promptTokenCount),
    outputTokens: nonnegative(gemini.candidatesTokenCount) + nonnegative(gemini.thoughtsTokenCount),
    totalTokens: nonnegative(gemini.totalTokenCount),
    cachedInputTokens: nonnegative(gemini.cachedContentTokenCount),
    reasoningTokens: nonnegative(gemini.thoughtsTokenCount),
  };
  const value = object(response.usage);
  const inputDetails = object(value?.input_tokens_details);
  const outputDetails = object(value?.output_tokens_details);
  return {
    inputTokens: nonnegative(value?.input_tokens),
    outputTokens: nonnegative(value?.output_tokens),
    totalTokens: nonnegative(value?.total_tokens),
    ...(inputDetails ? {
      cachedInputTokens: nonnegative(inputDetails.cached_tokens),
      cacheWriteTokens: nonnegative(inputDetails.cache_write_tokens),
    } : {}),
    ...(outputDetails ? { reasoningTokens: nonnegative(outputDetails.reasoning_tokens) } : {}),
    searchCalls: (response.output ?? []).filter(
      (item) => object(item)?.type === 'web_search_call',
    ).length,
  };
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

export function normalizeAnswer(
  receipt: ProviderReceipt,
  fallbackModel: string,
): CapturedAnswer {
  const native = receipt.response;
  const blocks: TextBlock[] = [];
  const citations: Citation[] = [];
  const sources: RetrievedSource[] = [];
  const refusals: string[] = [];
  for (const [outputIndex, item] of (native.output ?? []).entries()) {
    const output = object(item);
    if (output?.type === 'message' && Array.isArray(output.content)) {
      for (const [contentIndex, content] of output.content.entries()) {
        const part = object(content);
        if (part?.type === 'refusal' && typeof part.refusal === 'string')
          refusals.push(part.refusal);
        if (part?.type !== 'output_text' || typeof part.text !== 'string')
          continue;
        const block = {
          id: `output_${outputIndex}_content_${contentIndex}`,
          text: part.text,
        };
        blocks.push(block);
        for (const [annotationIndex, annotation] of (Array.isArray(
          part.annotations,
        )
          ? part.annotations
          : []
        ).entries()) {
          const value = object(annotation);
          if (value?.type !== 'url_citation') continue;
          const url = safeUrl(value.url);
          if (!url) continue; // Native malformed/unsafe annotations are still preserved under raw.
          const start = Number.isInteger(value.start_index)
            ? Number(value.start_index)
            : 0;
          const end = Number.isInteger(value.end_index)
            ? Number(value.end_index)
            : start;
          citations.push({
            id: `${block.id}_citation_${annotationIndex}`,
            blockId: block.id,
            url,
            title: typeof value.title === 'string' ? value.title : url,
            start,
            end,
          });
        }
      }
    }
    if (output?.type === 'web_search_call') {
      const action = object(output.action);
      for (const item of Array.isArray(action?.sources) ? action.sources : []) {
        const source = object(item);
        const url = safeUrl(source?.url);
        if (url)
          sources.push({
            url,
            ...(typeof source?.title === 'string'
              ? { title: source.title }
              : {}),
            ...(typeof source?.type === 'string' ? { type: source.type } : {}),
          });
      }
    }
  }
  return {
    provider: 'openai',
    providerResponseId: typeof native.id === 'string' ? native.id : '',
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
    model: typeof native.model === 'string' ? native.model : fallbackModel,
    status: refusals.length
      ? 'refused'
      : native.status === 'completed'
        ? 'completed'
        : 'incomplete',
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
    citations,
    sources,
    usage: usage(native),
    createdAt: receipt.receivedAt,
    raw: receipt,
    ...(refusals.length ? { refusal: refusals.join('\n') } : {}),
  };
}
