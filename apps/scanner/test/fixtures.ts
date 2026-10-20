import type { Brand, CapturedAnswer, Project, RunSnapshot, Analysis, BrandAnalysis } from '@citevia/core';
export const target: Brand = { id: 'acme', name: 'Acme', aliases: ['Acme Analytics'], domains: ['acme.example'] };
export const competitor: Brand = { id: 'bravo', name: 'Bravo', aliases: [], domains: ['bravo.example'] };
export const instant = '2026-10-19T08:00:00.000Z';
export const project: Project = {
  id: 'project-1', name: 'Acme', brand: target, competitors: [competitor], country: 'US', language: 'en', timezone: 'America/New_York',
  scheduleExpression: 'cron(0 8 ? * MON *)', enabled: true, generationModel: 'answer-snapshot', extractionModel: 'extract-snapshot', parserVersion: 'test-v1',
  version: 1, createdAt: instant, updatedAt: instant,
  scanProviders: [{ provider: 'openai', model: 'answer-snapshot' }],
  prompts: ['Which analytics products are good?', 'Which product has clear reports?'].map((text, index) => ({ id: `prompt-${index + 1}`, text, active: true, branded: false, version: 1, createdAt: instant, updatedAt: instant })),
};
export const snapshot: RunSnapshot = { projectName: project.name, brand: project.brand, competitors: project.competitors, prompts: project.prompts, country: project.country, language: project.language, timezone: project.timezone, generationModel: project.generationModel, extractionModel: project.extractionModel, parserVersion: project.parserVersion, configVersion: 1 };
export function captured(text = '1. Acme is useful.\n2. Bravo is reliable.'): CapturedAnswer {
  return { providerResponseId: 'provider-response-1', model: 'answer-snapshot', status: 'completed', blocks: [{ id: 'block-1', text }], text,
    citations: [{ id: 'citation-1', blockId: 'block-1', url: 'https://example.org/review', title: 'Review', start: 0, end: 10 }], sources: [{ url: 'https://example.org/review' }, { url: 'https://other.example/research' }],
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, searchCalls: 1 }, createdAt: instant, raw: { fixture: true } };
}
export const absent = (brandId: string): BrandAnalysis => ({ brandId, mentioned: false, explicitRank: null, mentionOrder: null, sentiment: 'not_applicable', evidence: [], rankEvidence: null, sentimentEvidence: null });
export function analysis(answer: CapturedAnswer): Analysis {
  const quote = answer.blocks[0].text;
  const span = { blockId: answer.blocks[0].id, quote, start: 0, end: quote.length };
  return { brands: [{ brandId: target.id, mentioned: true, explicitRank: 1, mentionOrder: 1, sentiment: 'positive', evidence: [span], rankEvidence: span, sentimentEvidence: span }, absent(competitor.id)], parserVersion: 'test-v1', model: 'extract-snapshot', createdAt: instant, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 }, raw: { fixture: true } };
}
