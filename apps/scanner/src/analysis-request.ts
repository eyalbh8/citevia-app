import { createHash } from 'node:crypto';
import { IDENTITY_PARSER_VERSION, type Analysis, type CapturedAnswer, type RunSnapshot } from '@citevia/core';
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_SCHEMA, extractionInput, parseExtraction } from './extraction.js';
import { SCORED_PARSER_VERSION, scoredExtractionRequest, parseScoredExtraction } from './scoring-extraction.js';
import { identityExtractionRequest, parseIdentityExtraction } from './identity-extraction.js';
import { ProviderError, type ExtractionRequest, type ProviderReceipt } from './provider.js';

function checkParser(version: string) {
  if (/^igeo-(?:evidence|identity)-v/.test(version) &&
      !['igeo-evidence-v1', SCORED_PARSER_VERSION, IDENTITY_PARSER_VERSION].includes(version)) {
    throw new ProviderError('unsupported_parser_version', 'This score requires a newer scanner.', false);
  }
}

function identityInputHash(answer: CapturedAnswer, snapshot: RunSnapshot) {
  const request = identityExtractionRequest(answer, snapshot);
  return createHash('sha256').update(JSON.stringify([
    snapshot.parserVersion, request, answer.blocks.map(block => [block.id, block.text]),
    answer.citations.map(citation => [citation.id, citation.blockId, citation.start, citation.end, citation.url, citation.title]),
  ], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value)).digest('hex');
}

export function matchesIdentityReceipt(analysis: Analysis, answer: CapturedAnswer, snapshot: RunSnapshot) {
  return analysis.parserVersion === IDENTITY_PARSER_VERSION &&
    snapshot.parserVersion === IDENTITY_PARSER_VERSION &&
    analysis.identityInputHash === identityInputHash(answer, snapshot);
}

/** Shared request/parser used by realtime, cache validation, evaluation and Batch. */
export function analysisRequest(answer: CapturedAnswer, snapshot: RunSnapshot): ExtractionRequest {
  checkParser(snapshot.parserVersion);
  const request = snapshot.parserVersion === IDENTITY_PARSER_VERSION
    ? identityExtractionRequest(answer, snapshot)
    : snapshot.parserVersion === SCORED_PARSER_VERSION
    ? scoredExtractionRequest(answer, snapshot)
    : {
        model: snapshot.extractionModel,
        instructions: EXTRACTION_INSTRUCTIONS,
        input: extractionInput(answer, snapshot),
        schema: EXTRACTION_SCHEMA,
        ...(snapshot.extractionModel === 'gpt-6-luna' ? { reasoningEffort: 'none' as const } : {}),
      };
  return { ...request,
    ...(snapshot.analysisFeedback ? {
      instructions: request.instructions + '\nA previous completed analysis failed server validation. Correct the issue in validation_feedback and return the full requested JSON. Copy company names exactly as written in the saved answer, including prefixes and punctuation. Keep every evidence and identity requirement; never invent an entity or evidence to satisfy validation.',
      input: { ...(request.input as Record<string, unknown>), validation_feedback: snapshot.analysisFeedback },
    } : {}),
    costContext: { projectId: snapshot.projectId, ...snapshot.execution, stage: snapshot.execution?.stage ?? 'analysis' } };
}

export function parseAnalysisReceipt(receipt: ProviderReceipt, answer: CapturedAnswer, snapshot: RunSnapshot): Analysis {
  checkParser(snapshot.parserVersion);
  if (snapshot.parserVersion === IDENTITY_PARSER_VERSION) {
    return { ...parseIdentityExtraction(receipt, answer, snapshot), identityInputHash: identityInputHash(answer, snapshot) };
  }
  return snapshot.parserVersion === SCORED_PARSER_VERSION
    ? parseScoredExtraction(receipt, answer, snapshot)
    : parseExtraction(receipt, answer, snapshot);
}
