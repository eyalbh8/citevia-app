import { describe, expect, it, vi } from 'vitest';
import type { CapturedAnswer, OnboardingJob } from '@citevia/core';
import { researchEvidenceCatalog } from '../apps/scanner/src/onboarding-evidence.js';
import { OpenAIOnboardingProvider } from '../apps/scanner/src/onboarding-provider.js';

function research(): CapturedAnswer {
  const text =
    '## Research\nAcme produce strumenti per le imprese. ([Acme](https://acme.com/about))\n\nIts tools support small teams. ([Acme](https://acme.com/products))';
  const first = text.indexOf('([Acme]'),
    second = text.lastIndexOf('([Acme]');
  return {
    providerResponseId: 'native',
    model: 'test',
    status: 'completed',
    blocks: [{ id: 'text', text }],
    text,
    citations: [
      {
        id: 'one',
        blockId: 'text',
        url: 'https://acme.com/about',
        title: 'Official',
        start: first,
        end: text.indexOf('\n', first),
      },
      {
        id: 'two',
        blockId: 'text',
        url: 'https://acme.com/products',
        title: 'Products',
        start: second,
        end: text.length,
      },
    ],
    sources: [{ url: 'https://acme.com/unrelated' }],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: new Date().toISOString(),
    raw: {},
  };
}
const job = {
  id: 'job',
  input: {
    name: 'Acme',
    website: 'https://acme.com',
    country: 'IT',
    language: 'it',
    timezone: 'UTC',
    description: '',
    manualPrompts: [],
  },
} as unknown as OnboardingJob;
const base = {
  about: 'Acme produce strumenti per le imprese.',
  industryCategory: 'Tools',
  subIndustryCategory: '',
  names: ['Acme'],
  keyFeatures: [],
  toneOfVoice: [],
  values: [],
  personality: [],
  targetAudience: [],
  knowledgeSources: ['https://acme.com/about'],
  sitemapUrl: null,
  caseStudiesSourceUrl: null,
  postGuidelines: { dos: [], donts: [] },
  unknowns: [],
};
const receipt = (output: unknown) => ({
  response: {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(output) }],
      },
    ],
  },
  requestId: 'native',
  receivedAt: new Date().toISOString(),
});

describe('brandbook evidence references', () => {
  it('copies quotes and their native source bindings deterministically instead of asking the model to reproduce text', async () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    expect(catalog).toHaveLength(2);
    expect(catalog[0].quote).toContain('Acme produce strumenti');
    expect(catalog.every((item) => saved.text.includes(item.quote))).toBe(true);
    expect(catalog[0].url).toBe('https://acme.com/about');
    expect(catalog[1].url).toBe('https://acme.com/products');
    const extract = vi.fn(async (_request: unknown) =>
      receipt({
        ...base,
        evidence: [{ field: 'about', evidenceId: catalog[0].id }],
      }),
    );
    const result = await new OpenAIOnboardingProvider({
      answer: vi.fn(),
      extract,
    }).brandbook(job, saved);
    expect(result.brandbook.evidence).toEqual([
      { field: 'about', quote: catalog[0].quote, url: catalog[0].url },
    ]);
    expect(result.receipt).toMatchObject({
      instructionsVersion: 'citevia-onboarding-v4',
      evidenceCatalog: catalog,
    });
    const request = extract.mock.calls[0][0] as any;
    expect(
      request.schema.properties.evidence.items.properties.evidenceId.enum,
    ).toEqual(catalog.map((item) => item.id));
    expect(
      request.schema.properties.evidence.items.properties,
    ).not.toHaveProperty('quote');
  });
  it('rejects hallucinated IDs, paraphrases, extra evidence fields, empty evidence and unvisited source URLs', async () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    for (const payload of [
      { ...base, evidence: [{ field: 'about', evidenceId: 'invented' }] },
      {
        ...base,
        evidence: [
          {
            field: 'about',
            quote: 'A paraphrase',
            url: 'https://acme.com/about',
          },
        ],
      },
      {
        ...base,
        evidence: [
          {
            field: 'about',
            evidenceId: catalog[0].id,
            url: 'https://acme.com/unrelated',
          },
        ],
      },
      { ...base, evidence: [] },
      {
        ...base,
        evidence: [{ field: 'about', evidenceId: catalog[0].id }],
        knowledgeSources: ['https://unvisited.com'],
      },
    ]) {
      const extract = vi.fn(async () => receipt(payload));
      await expect(
        new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).brandbook(
          job,
          saved,
        ),
      ).rejects.toMatchObject({
        code: 'brandbook_evidence_invalid',
        retryable: false,
      });
      expect(extract).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects citation-free research before another paid call and ignores unsafe or malformed native annotations', async () => {
    const saved = research(),
      extract = vi.fn();
    saved.citations = saved.citations.map((citation) => ({
      ...citation,
      url: 'javascript:alert(1)',
    }));
    expect(researchEvidenceCatalog(saved)).toEqual([]);
    await expect(
      new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).brandbook(
        job,
        saved,
      ),
    ).rejects.toMatchObject({
      code: 'research_evidence_missing',
      retryable: false,
    });
    expect(extract).not.toHaveBeenCalled();
  });
});
