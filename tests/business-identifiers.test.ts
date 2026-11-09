import { describe, expect, it } from 'vitest';
import { type Brand } from '@citevia/core';
import { captured, snapshot } from '../apps/scanner/test/fixtures.js';
import { businessIdentifierOffset, containsBusinessIdentifier } from '../apps/scanner/src/business-identifiers.js';
import { parseScoredExtraction, scoredExtractionRequest, SCORED_PARSER_VERSION } from '../apps/scanner/src/scoring-extraction.js';

const brand: Brand = { id: 'target', name: "משרד עורכי הדין דנה ברק ושות'",
  aliases: ["דנה ברק ושות'", 'דנה ברק', 'Dana Barak'], domains: ['barak.example'] };
const configured = { ...snapshot, brand, competitors: [], parserVersion: SCORED_PARSER_VERSION,
  analysisPromptId: snapshot.prompts[0].id };
const present = { mentioned: true, sentiment: 'neutral', evidenceIds: [0], sentimentEvidenceId: 0,
  explicitRank: null, rankEvidenceId: null };
const absent = { mentioned: false, sentiment: 'not_applicable', evidenceIds: [], sentimentEvidenceId: null,
  explicitRank: null, rankEvidenceId: null };
const receipt = (row: typeof present | typeof absent, companies: unknown[] = []) => ({ receivedAt: '2026-11-09T00:00:00Z',
  requestId: 'test', response: { status: 'completed', output: [{ type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({ brands: { target: row }, companies }) }] }] } });

describe('exact business identifiers', () => {
  it.each([
    'עו״ד דנה ברק מייצגת בעסקאות מקרקעין.',
    "המשרד של **דנה ברק ושות׳** מלווה חברות.",
    "משרד עורכי הדין **דנה ברק ושות'** מלווה חברות.",
    'Dana **Barak** handles contracts.',
    'כתובת המשרד: office@barak.example',
    'אתר המשרד: https://www.barak.example/contact',
    'אפשר לתאם פגישה באתר barak.example',
    'פרטי המשרד: https://contact.barak.example/',
  ])('recognizes a configured alias or official identifier: %s', text => {
    expect(containsBusinessIdentifier(text, brand)).toBe(true);
    const analysis = parseScoredExtraction(receipt(present), captured(text), configured);
    expect(analysis.brands[0]).toMatchObject({ mentioned: true, appearanceRank: 1, sentiment: 'neutral' });
    expect(analysis.companies).toHaveLength(1);
    for (const span of analysis.brands[0].evidence) expect(text.slice(span.start, span.end)).toBe(span.quote);
  });
  it.each([
    'משרד ברק מטפל בחוזים.',
    'דנה מייצגת לקוחות.',
    'משרד דנה ברקוביץ מייצג לקוחות.',
    'אפשר לפנות ל־notbarak.example',
    'אתר המשרד: https://barak.example.other.example/',
    'אתר המשרד: https://other.example/barak.example',
    'אתר המשרד: https://barak.example@other.example/',
    'מקור: https://barak.example/review',
    'https://barak.example/review',
    '[מדריך משפטי](https://barak.example/guide)',
  ])('rejects an unverified partial name, lookalike or source URL: %s', text => {
    expect(containsBusinessIdentifier(text, brand)).toBe(false);
  });
  it('preserves the original UTF-16 occurrence across emphasis and emoji', () => {
    const text = '🧭 Dana **Barak** handles contracts.';
    expect(businessIdentifierOffset(text, brand)).toBe(text.indexOf('Dana'));
  });
  it('does not broaden a near-generic brand into its service', () => {
    const e2 = { id: 'e2', name: 'E2 Visas USA', aliases: [], domains: ['e2visasusa.com'] };
    expect(containsBusinessIdentifier('E2 visa USA requirements and investor services', e2)).toBe(false);
    expect(containsBusinessIdentifier('E2 Visas USA provides a business-specific assessment.', e2)).toBe(true);
  });
  it('does not override a source-only or generic-topic absence based on identifiers alone', () => {
    const answer = captured('General contract advice from barak.example.');
    answer.citations[0].url = 'https://barak.example/guide';
    const analysis = parseScoredExtraction(receipt(absent), answer, configured);
    expect(analysis.brands[0]).toMatchObject({ mentioned: false, appearanceRank: null });
    expect(analysis.companies).toEqual([]);
  });
  it('does not turn native citation metadata into a visible company mention', () => {
    const answer = captured('General legal advice.');
    answer.citations[0].url = 'https://barak.example/guide';
    const analysis = parseScoredExtraction(receipt(present), answer, configured);
    expect(analysis.brands[0].mentioned).toBe(false);
  });
  it('accepts a canonical company label when the selected passage uses its verified short identity', () => {
    const answer = captured('דנה ברק מייצגת בעסקאות מקרקעין.');
    const analysis = parseScoredExtraction(receipt(present, [{ name: brand.name, evidenceId: 0 }]), answer, configured);
    expect(analysis.brands[0].mentioned).toBe(true);
    expect(analysis.companies?.[0].name).toBe(brand.name);
  });
  it('resolves a canonical inventory label to the verified brand passage when its selected introduction lacks a name', () => {
    const answer = captured('Professional credentials and evidence.\nדנה ברק מייצגת בעסקאות מקרקעין.');
    const analysis = parseScoredExtraction(receipt({ ...present, evidenceIds: [0, 1], sentimentEvidenceId: 1 },
      [{ name: brand.name, evidenceId: 0 }]), answer, configured);
    expect(analysis.brands[0].mentioned).toBe(true);
    expect(analysis.companies?.[0].evidence.quote).toContain('דנה ברק');
  });
  it('passes the prompt, official domains and attached citations to the analyzer', () => {
    const answer = captured();
    const request = scoredExtractionRequest(answer, configured);
    expect(request.input).toMatchObject({ question: snapshot.prompts[0].text,
      brands: [{ brandId: 'target', name: brand.name, aliases: brand.aliases, domains: brand.domains }],
      citations: [{ url: answer.citations[0].url, evidenceIds: [0] }] });
  });
});
