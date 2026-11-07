import { expect, it } from 'vitest';
import { IDENTITY_PARSER_VERSION } from '@citevia/core';
import { captured, instant, snapshot } from './fixtures.js';
import { analysisRequest, matchesIdentityReceipt, parseAnalysisReceipt } from '../src/analysis-request.js';

it('binds saved identity decisions to the captured citation IDs, prompt and official domains', () => {
  const context = { ...snapshot, parserVersion: IDENTITY_PARSER_VERSION, analysisPromptId: snapshot.prompts[0].id };
  const answer = captured();
  const brands = [snapshot.brand, ...snapshot.competitors].map(({ id }) => ({
    id, decision: 'absent', nameId: null, discussionId: null, citationIds: [], sentiment: 'unknown',
    sentimentId: null, explicitRank: null, rankId: null,
  }));
  const receipt = { requestId: 'test', receivedAt: instant, response: { status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ brands, companies: [] }) }] },
  ] } };
  const saved = parseAnalysisReceipt(receipt, answer, context);
  expect(matchesIdentityReceipt(saved, answer, context)).toBe(true);
  expect(matchesIdentityReceipt(saved, answer, { ...context, analysisPromptId: snapshot.prompts[1].id })).toBe(false);
  expect(matchesIdentityReceipt(saved, answer, { ...context, brand: { ...context.brand, domains: ['other.example'] } })).toBe(false);
  expect(matchesIdentityReceipt(saved, { ...answer, citations: answer.citations.map(c => ({ ...c, id: c.id + '-different' })) }, context)).toBe(false);
  expect(() => analysisRequest(answer, { ...context, parserVersion: 'igeo-identity-v99' })).toThrow(/newer scanner/);
});
