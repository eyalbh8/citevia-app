import { describe, expect, it, vi } from 'vitest';
import type { CapturedAnswer, OnboardingJob } from '@citevia/core';
import { researchEvidenceCatalog, requireOfficialResearch, isOfficialBrandSource } from '../apps/scanner/src/onboarding-evidence.js';
import { OpenAIOnboardingProvider } from '../apps/scanner/src/onboarding-provider.js';

function research(): CapturedAnswer {
  const text =
    '## Research\nAcme produce strumenti per le imprese. ([Acme](https://acme.com/about))\n\nAcme vende questi strumenti solo alle piccole imprese. ([Acme](https://acme.com/products))';
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
  it('retains the actual quoted Hebrew sentence when a selection moves only its terminal period', async () => {
    const saved = research();
    const company = { ...job, input: { ...job.input, name: 'משרד עורכי הדין דנה', language: 'he' } };
    const overview = 'משרד עורכי הדין דנה מעניק ייעוץ משפטי בישראל.';
    const offering = 'משרד עורכי הדין דנה הוא "משרד בוטיק המעניק ייעוץ משפטי לעסקים בלבד".';
    saved.text = overview + '\n' + offering;
    saved.blocks = [{ id: 'text', text: saved.text }];
    saved.citations = [overview, offering].map((line, i) => ({ ...saved.citations[0],
      start: i ? overview.length + 1 : 0, end: i ? saved.text.length : overview.length }));
    const items = researchEvidenceCatalog(saved);
    const extract = vi.fn(async () => receipt({ ...base, evidence: [
      { field: 'about', value: overview, evidenceId: items[0].id },
      { field: 'keyFeatures', value: 'משרד בוטיק המעניק ייעוץ משפטי לעסקים בלבד.', evidenceId: items[1].id },
    ] }));
    const result = await new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).brandbook(company, saved);
    expect(result.brandbook.keyFeatures).toEqual([offering]);
    expect(result.brandbook.names).toEqual([company.input.name]);
    // Choosing Hebrew prompts does not make an unverified translated name valid.
    await expect(new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).brandbook({ ...company,
      input: { ...company.input, name: 'Dana Law Firm' } }, saved))
      .rejects.toMatchObject({ code: 'onboarding_official_research_missing' });
    expect(extract).toHaveBeenCalledTimes(1);
  });

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
        competitorSearchQuery: 'fornitori di strumenti per piccole imprese',
        evidence: [
          { field: 'about', evidenceId: catalog[0].id, value: 'Acme produce strumenti per le imprese.' },
          { field: 'keyFeatures', evidenceId: catalog[1].id, value: 'Acme vende questi strumenti' },
        ],
      }),
    );
    const result = await new OpenAIOnboardingProvider({
      answer: vi.fn(),
      extract,
    }).brandbook(job, saved);
    expect(result.brandbook.evidence).toEqual([
      { field: 'about', quote: catalog[0].quote, url: catalog[0].url },
      { field: 'keyFeatures', quote: catalog[1].quote, url: catalog[1].url },
    ]);
    expect(result.competitorSearchQuery).toBe('fornitori di strumenti per piccole imprese');
    expect(result.brandbook).not.toHaveProperty('competitorSearchQuery');
    expect(result.brandbook.about).toBe('Acme produce strumenti per le imprese.');
    expect(result.brandbook.keyFeatures).toEqual(['Acme vende questi strumenti solo alle piccole imprese.']);
    expect(result.brandbook.names).toEqual(['Acme']);
    expect(result.receipt).toMatchObject({
      instructionsVersion: 'citevia-onboarding-v9',
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
    const saved = research(), catalog = researchEvidenceCatalog(saved);
    const proofs = [
      { field: 'about', evidenceId: catalog[0].id, value: 'Acme produce strumenti per le imprese.' },
      { field: 'keyFeatures', evidenceId: catalog[1].id, value: 'Acme vende questi strumenti' },
    ];
    for (const payload of [
      { ...base, evidence: proofs, about: 'An invented override' },
      { ...base, evidence: proofs, identityStatus: 'different_business' },
      { ...base, evidence: proofs, caseStudiesSourceUrl: 'https://acme.com/unrelated' },
      { ...base, evidence: [proofs[0], { ...proofs[1], value: 'A completely invented offering' }] },
      { ...base, evidence: [{ ...proofs[0], value: 'A completely invented description' }, proofs[1]] },
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
  it('keeps unverified optional information out of facts without discarding a supported profile', async () => {
    const saved = research(), items = researchEvidenceCatalog(saved);
    const extract = vi.fn(async () => receipt({
      ...base, evidence: [
        {field: 'about', value: 'Acme produce strumenti per le imprese.', evidenceId: items[0].id},
        {field: 'keyFeatures', value: 'Acme vende questi strumenti', evidenceId: items[1].id},
        {field: 'industryCategory', value: 'Medical devices', evidenceId: items[0].id},
        {field: 'values', value: 'Free repairs', evidenceId: items[0].id},
      ],
    }));
    const result = await new OpenAIOnboardingProvider({answer: vi.fn(), extract}).brandbook(job, saved);
    expect(result.brandbook).toMatchObject({ industryCategory: '', values: [], unknowns: ['Unverified against the official sources: Medical devices','Unverified against the official sources: Free repairs'] });
    expect(result.brandbook.evidence).toHaveLength(2);
  });

  it('declines an explicit identity mismatch and keeps a denied offering out of the profile', async () => {
    const saved = research();
    const host = 'https://acme.com';
    for (const claim of ['We could not identify Acme.', 'The site belongs to Gamma, not Acme.', 'לא ניתן לזהות את Acme כעסק הזה.']) {
      expect(() => requireOfficialResearch([{id:'one',blockId:'b',start:0,end:claim.length,url:host,quote:claim}],host,'Acme')).toThrow();
    }
    const refusal = 'Acme does not provide legal services.';
    const lines = ['Acme makes tools for small businesses.', refusal];
    saved.text = lines.join('\n'); saved.blocks = lines.map((text,i)=>({id:String(i),text}));
    saved.citations = lines.map((line,i)=>({...saved.citations[0],url:host,blockId:String(i),start:0,end:line.length}));
    const items = researchEvidenceCatalog(saved);
    const extract = vi.fn(async () => receipt({...base,knowledgeSources:[host],evidence:[
      {field:'about',value:lines[0],evidenceId:items[0].id},
      {field:'keyFeatures',value:'legal services',evidenceId:items[1].id},
    ]}));
    await expect(new OpenAIOnboardingProvider({answer:vi.fn(),extract}).brandbook(job,saved))
      .rejects.toMatchObject({code:'brandbook_evidence_invalid'});
  });

  it('uses the nearest named offering heading only for its contiguous, officially cited bullets', async () => {
    for (const [heading, accepted] of [['Acme services:', true], ['Gamma services:', false],
      ['Acme competitors:', false], ['Acme services:\n', false]] as const) {
      const saved = research(); const url = 'https://acme.com/about';
      const overview = 'Acme makes tools for small businesses.';
      const bullet = '- Bench installation for small workshops.';
      const text = [overview, heading, bullet].join('\n');
      const start = text.indexOf(bullet);
      saved.text = text; saved.blocks = [{id: 'text', text}];
      saved.citations = [
        {...saved.citations[0],url,start:0,end:overview.length},
        {...saved.citations[1],url,start,end:text.length},
      ];
      const items = researchEvidenceCatalog(saved);
      const extract = vi.fn(async () => receipt({...base,knowledgeSources:[url],evidence:[
        {field:'about',value:overview,evidenceId:items[0].id},
        {field:'keyFeatures',value:'Bench installation',evidenceId:items[1].id},
      ]}));
      const result = new OpenAIOnboardingProvider({answer:vi.fn(),extract}).brandbook(job,saved);
      if (accepted) expect((await result).brandbook.keyFeatures).toEqual(['Bench installation for small workshops.']);
      else await expect(result).rejects.toMatchObject({code:'brandbook_evidence_invalid'});
    }
  });

  it('isolates claims attached to different companies on a shared citation line', () => {
    const target = 'https://acme.com/about', rival = 'https://rival.com/products';
    const text = 'Acme makes tools. ([source](' + target + ')) Rival offers financing. ([source](' + rival + '))';
    const original = research();
    const captured = {...original, text, blocks: [{id:'text',text}], citations: [target, rival].map((url,i) => {
      const start = text.indexOf('([source](' + url);
      return {...original.citations[0], id:String(i), start, end:start+('([source](' + url + '))').length,url};
    })};
    const catalog = researchEvidenceCatalog(captured);
    expect(catalog[0].quote).not.toContain('Rival');
    expect(catalog[1].quote).not.toContain('Acme');
    expect(() => requireOfficialResearch(catalog, target, 'Rival')).toThrow();
    expect(isOfficialBrandSource('https://evil.acme.com.ph/', target)).toBe(false);
    expect(isOfficialBrandSource('https://another.hosted.com/', 'https://my.hosted.com')).toBe(false);
  });

  it('requires a narrative identity on an official page before paying to extract the brandbook', async () => {
    const saved = research(); const extract = vi.fn();
    // “Acme” occurs in the link label and host, not in the supported statement.
    const text = 'Gamma runs this firm. ([Acme](https://acme.com/about))';
    saved.text = text; saved.blocks = [{id: 'text', text}];
    saved.citations = [{...saved.citations[0], start:text.indexOf('([Acme]'),end:text.length}];
    await expect(new OpenAIOnboardingProvider({answer:vi.fn(), extract}).brandbook(job, saved))
      .rejects.toMatchObject({code:'onboarding_official_research_missing'});
    expect(extract).not.toHaveBeenCalled();
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
      code: 'onboarding_official_research_missing',
      retryable: false,
    });
    expect(extract).not.toHaveBeenCalled();
  });
});
