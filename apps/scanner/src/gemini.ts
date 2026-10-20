import type {
  CapturedAnswer,
  Citation,
  RetrievedSource,
  RunSnapshot,
  TextBlock,
} from '@citevia/core';
import { object, type ProviderReceipt } from './provider.js';
import { safeUrl } from './normalize.js';
import { providerPost, type HttpOptions } from './provider-http.js';

export function geminiBody(prompt: string, snapshot: RunSnapshot) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: {
      parts: [
        {
          text: `Answer the user's question in ${snapshot.language}, for a user in ${snapshot.country}. Use Google Search to ground current information.`,
        },
      ],
    },
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 8000, candidateCount: 1 },
  };
}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
/** Gemini grounding offsets are UTF-8 bytes. The rest of Citevia uses JS UTF-16 offsets. */
export function byteSpan(
  text: string,
  start: unknown,
  end: unknown,
  quote?: unknown,
): { start: number | null; end: number | null } {
  const bytes = Buffer.from(text, 'utf8');
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    Number(start) < 0 ||
    Number(end) <= Number(start) ||
    Number(end) > bytes.length
  )
    return { start: null, end: null };
  const prefix = bytes.subarray(0, Number(start)).toString('utf8'),
    segment = bytes.subarray(Number(start), Number(end)).toString('utf8');
  if (
    Buffer.byteLength(prefix) !== start ||
    Buffer.byteLength(segment) !== Number(end) - Number(start) ||
    (typeof quote === 'string' && quote !== segment)
  )
    return { start: null, end: null };
  return { start: prefix.length, end: prefix.length + segment.length };
}
export function normalizeGemini(
  receipt: ProviderReceipt,
  fallbackModel: string,
): CapturedAnswer {
  const native = receipt.response;
  const candidate = object(
    Array.isArray(native.candidates) ? native.candidates[0] : undefined,
  );
  const content = object(candidate?.content),
    grounding = object(candidate?.groundingMetadata);
  const blocks: TextBlock[] = [],
    citations: Citation[] = [],
    sources: RetrievedSource[] = [];
  for (const [index, raw] of (Array.isArray(content?.parts)
    ? content.parts
    : []
  ).entries()) {
    const part = object(raw);
    if (typeof part?.text === 'string' && part.thought !== true)
      blocks.push({ id: `part_${index}`, text: part.text });
  }
  const chunks = Array.isArray(grounding?.groundingChunks)
    ? grounding.groundingChunks
    : [];
  for (const chunk of chunks) {
    const web = object(object(chunk)?.web),
      url = safeUrl(web?.uri);
    if (url)
      sources.push({
        url,
        title: typeof web?.title === 'string' ? web.title : url,
        type: 'web',
      });
  }
  for (const [index, raw] of (Array.isArray(grounding?.groundingSupports)
    ? grounding.groundingSupports
    : []
  ).entries()) {
    const support = object(raw),
      segment = object(support?.segment);
    const block = blocks.find(
      (block) => block.id === `part_${segment?.partIndex ?? 0}`,
    );
    if (!block) continue;
    const span = byteSpan(
      block.text,
      segment?.startIndex ?? 0,
      segment?.endIndex,
      segment?.text,
    );
    for (const chunkIndex of Array.isArray(support?.groundingChunkIndices)
      ? support.groundingChunkIndices
      : []) {
      if (!Number.isInteger(chunkIndex) || Number(chunkIndex) < 0) continue;
      const web = object(object(chunks[Number(chunkIndex)])?.web),
        url = safeUrl(web?.uri);
      if (url)
        citations.push({
          id: `${block.id}_support_${index}_${chunkIndex}`,
          blockId: block.id,
          url,
          title: typeof web?.title === 'string' ? web.title : url,
          ...span,
        });
    }
  }
  const feedback = object(native.promptFeedback),
    reason = candidate?.finishReason ?? feedback?.blockReason;
  const refused = [
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
  ].includes(String(reason));
  const usage = object(native.usageMetadata),
    suggestions = object(grounding?.searchEntryPoint);
  return {
    provider: 'gemini',
    providerResponseId:
      typeof native.responseId === 'string' ? native.responseId : '',
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
    model:
      typeof native.modelVersion === 'string'
        ? native.modelVersion
        : fallbackModel,
    status: refused
      ? 'refused'
      : reason === 'STOP'
        ? 'completed'
        : 'incomplete',
    ...(refused
      ? { refusal: `Gemini blocked this answer (${String(reason)}).` }
      : {}),
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
    citations,
    sources,
    usage: {
      inputTokens: count(usage?.promptTokenCount),
      outputTokens:
        count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount),
      totalTokens: count(usage?.totalTokenCount),
      ...(Array.isArray(grounding?.webSearchQueries)
        ? { searchQueries: grounding.webSearchQueries.length }
        : {}),
    },
    ...(typeof suggestions?.renderedContent === 'string'
      ? { searchSuggestions: [suggestions.renderedContent] }
      : {}),
    createdAt: receipt.receivedAt,
    raw: receipt,
  };
}
export class GeminiCollector {
  constructor(private readonly options: HttpOptions) {}
  async collect(prompt: string, snapshot: RunSnapshot) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(snapshot.generationModel)}:generateContent`;
    return normalizeGemini(
      await providerPost(
        'gemini',
        url,
        geminiBody(prompt, snapshot),
        this.options,
      ),
      snapshot.generationModel,
    );
  }
}
