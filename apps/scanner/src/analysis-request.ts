import type { Analysis, CapturedAnswer, RunSnapshot } from '@citevia/core';
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_SCHEMA, extractionInput, parseExtraction } from './extraction.js';
import { SCORED_PARSER_VERSION, scoredExtractionRequest, parseScoredExtraction } from './scoring-extraction.js';
import type { ExtractionRequest, ProviderReceipt } from './provider.js';

/** Shared request/parser used by realtime, cache validation, evaluation and Batch. */
export function analysisRequest(answer: CapturedAnswer, snapshot: RunSnapshot): ExtractionRequest {
  const request = snapshot.parserVersion === SCORED_PARSER_VERSION
    ? scoredExtractionRequest(answer, snapshot)
    : {
        model: snapshot.extractionModel,
        instructions: EXTRACTION_INSTRUCTIONS,
        input: extractionInput(answer, snapshot),
        schema: EXTRACTION_SCHEMA,
        ...(snapshot.extractionModel === 'gpt-6-luna' ? { reasoningEffort: 'none' as const } : {}),
      };
  return { ...request, costContext: { projectId: snapshot.projectId, ...snapshot.execution, stage: 'analysis' } };
}

export function parseAnalysisReceipt(receipt: ProviderReceipt, answer: CapturedAnswer, snapshot: RunSnapshot): Analysis {
  return snapshot.parserVersion === SCORED_PARSER_VERSION
    ? parseScoredExtraction(receipt, answer, snapshot)
    : parseExtraction(receipt, answer, snapshot);
}
