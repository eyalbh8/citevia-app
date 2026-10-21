import { describe, expect, it, vi } from 'vitest';
import {
  competitorBrands,
  competitorDomain,
  type Analysis,
  type Brand,
  type CapturedAnswer,
  type DiscoveredCompetitor,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { resolveDiscoveredCompetitors } from '../apps/scanner/src/competitor-discovery.js';
import { researchEvidenceCatalog } from '../apps/scanner/src/onboarding-evidence.js';
import { OpenAIOnboardingProvider } from '../apps/scanner/src/onboarding-provider.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { FixtureProvider } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';
import { policyJob } from './fixtures/onboarding-job.js';

const target: Brand = {
  id: 'target',
  name: 'Acme',
  aliases: ['Acme Tools'],
  domains: ['www.acme.com'],
};
const candidate: DiscoveredCompetitor = {
  name: 'Clearview',
  domain: 'clearview.com',
  evidence: [
    {
      quote: 'Clearview offers competing analytics.',
      url: 'https://clearview.com/about',
    },
  ],
};
function research(): CapturedAnswer {
  const blocks = [
    {
      id: 'rival',
      text: 'Clearview offers competing analytics to the same small business audience. https://www.clearview.com/about',
    },
    {
      id: 'own',
      text: 'Acme Tools offers analytics. https://help.acme.com/about',
    },
    {
      id: 'duplicate',
      text: 'Clearview also sells these tools. https://other.com/about',
    },
  ];
  return {
    providerResponseId: 'fixture-research',
    model: 'fixture',
    status: 'completed',
    blocks,
    text: blocks.map((block) => block.text).join('\n'),
    citations: blocks.map((block, index) => ({
      id: `c${index}`,
      blockId: block.id,
      title: 'Official website',
      url: block.text.slice(block.text.indexOf('https://')),
      start: 0,
      end: block.text.length,
    })),
    sources: [{ url: 'https://unrelated.com' }],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: new Date().toISOString(),
    raw: {},
  };
}

describe('grounded onboarding competitors', () => {
  it('keeps competitor extraction alongside the brandbook and outside its editable fields', async () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    const job = policyJob();
    const output = {
      about: 'Acme Tools offers analytics.',
      industryCategory: 'Analytics',
      subIndustryCategory: '',
      names: ['Acme Tools'],
      keyFeatures: [],
      toneOfVoice: [],
      values: [],
      personality: [],
      targetAudience: [],
      knowledgeSources: [],
      sitemapUrl: null,
      caseStudiesSourceUrl: null,
      postGuidelines: { dos: [], donts: [] },
      unknowns: [],
      evidence: [{ field: 'about', evidenceId: catalog[1].id }],
      competitors: [
        {
          name: 'Clearview',
          websiteUrl: 'https://clearview.com',
          evidenceIds: [catalog[0].id],
        },
      ],
    };
    const extract = vi.fn(async (_request: unknown) => ({
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(output) }],
          },
        ],
      },
      receivedAt: new Date().toISOString(),
      requestId: 'fixture',
    }));
    const result = await new OpenAIOnboardingProvider({
      answer: vi.fn(),
      extract,
    }).brandbook(job, saved);
    expect(result.competitors).toMatchObject([
      { name: 'Clearview', domain: 'clearview.com' },
    ]);
    expect(result.brandbook).not.toHaveProperty('competitors');
    const request = extract.mock.calls[0][0] as {
      schema: { required: string[]; properties: Record<string, unknown> };
    };
    expect(request.schema.required).toContain('competitors');
    expect(request.schema.properties).toHaveProperty('competitors');
  });

  it('copies official-domain evidence, deduplicates names/domains and excludes own aliases/domains', () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    const result = resolveDiscoveredCompetitors(
      [
        {
          name: 'Clearview',
          websiteUrl: 'https://clearview.com',
          evidenceIds: [catalog[0].id],
        },
        {
          name: 'Clearview',
          websiteUrl: 'https://www.clearview.com/product',
          evidenceIds: [catalog[0].id],
        },
        {
          name: 'Acme Tools',
          websiteUrl: 'https://acme.com',
          evidenceIds: [catalog[1].id],
        },
        {
          name: 'Clearview',
          websiteUrl: 'https://other.com',
          evidenceIds: [catalog[2].id],
        },
      ],
      saved,
      target,
    );
    expect(result).toEqual([
      {
        name: 'Clearview',
        domain: 'clearview.com',
        evidence: [{ quote: catalog[0].quote, url: catalog[0].url }],
      },
    ]);
  });

  it('drops invented identities, unrelated citations, unsafe sites and missing evidence without inventing replacements', () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    expect(
      resolveDiscoveredCompetitors(
        [
          {
            name: 'Invented',
            websiteUrl: 'https://clearview.com',
            evidenceIds: [catalog[0].id],
          },
          {
            name: 'Clearview',
            websiteUrl: 'https://unrelated.com',
            evidenceIds: [catalog[0].id],
          },
          {
            name: 'Clearview',
            websiteUrl: 'http://127.0.0.1',
            evidenceIds: [catalog[0].id],
          },
          {
            name: 'Clearview',
            websiteUrl: 'https://clearview.com',
            evidenceIds: ['fabricated'],
          },
        ],
        saved,
        target,
      ),
    ).toEqual([]);
    expect(resolveDiscoveredCompetitors([], saved, target)).toEqual([]);
  });

  it('creates stable IDs and caps tracked competitors at five while protecting the own brand', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ...candidate,
      name: `Company ${index}`,
      domain: `company${index}.com`,
    }));
    const project = { id: 'project-1', brand: target };
    const brands = competitorBrands(project, [
      { ...candidate, name: 'ACME TOOLS' },
      { ...candidate, domain: 'help.acme.com' },
      ...items,
      { ...items[0], domain: 'another.com' },
    ]);
    expect(brands).toHaveLength(5);
    expect(brands).toEqual(competitorBrands(project, items));
    expect(brands[0].id).not.toBe(
      competitorBrands({ ...project, id: 'other-project' }, items)[0].id,
    );
    for (const value of [
      'localhost',
      '127.0.0.1',
      'https://user:password@company.com',
      'https://company.com:8080',
      'ftp://company.com',
      'fake.example',
    ])
      expect(competitorDomain(value)).toBeNull();
  });

  it.each(['automatic', 'manual', 'cleared'] as const)(
    'assigns before the first provider scans and preserves manual choices (%s)',
    async (choice) => {
      const manual = choice === 'manual';
      const repository = new MemoryRepository(),
        artifacts = new MemoryArtifacts(),
        queue = new MemoryQueue();
      await repository.syncUser(testIdentity('owner'));
      const runtime = { repository, artifacts, queue };
      const { items } = await createAccounts(
        runtime,
        'owner',
        `competitor-${choice}`,
        {
          accounts: [
            {
              name: 'Acme',
              website: 'https://acme.com',
              region: 'US',
              language: 'en',
            },
          ],
        },
        new Date(),
        100,
      );
      const item = items[0],
        provider = new FixtureOnboardingProvider();
      const original = provider.brandbook.bind(provider);
      vi.spyOn(provider, 'brandbook').mockImplementation(async (job) => ({
        ...(await original(job)),
        competitors: [candidate],
      }));
      if (choice !== 'automatic')
        await repository.saveProject(
          {
            ...item.project,
            competitors: manual
              ? [
                  {
                    id: 'chosen',
                    name: 'Metriclane',
                    aliases: ['Metric Lane'],
                    domains: ['metriclane.com'],
                  },
                ]
              : [],
            competitorsConfiguredAt: new Date().toISOString(),
            version: item.project.version + 1,
          },
          item.project.version,
        );
      const answers = new FixtureProvider(),
        extract = vi.spyOn(answers, 'extract');
      const worker = new OnboardingEngine(runtime, provider, async () => {});
      const scanner = new Scanner({
        ...runtime,
        provider: answers,
        onboarding: worker,
      });
      let processed = 0;
      while (queue.messages.length) {
        if (++processed > 1000) throw Error('Unbounded queue');
        await scanner.handle(queue.messages.shift()!);
      }
      const project = (await repository.getProject(item.project.id))!;
      expect(project.competitors).toHaveLength(choice === 'cleared' ? 0 : 1);
      if (choice !== 'cleared') {
        expect(project.competitors[0].name).toBe(
          manual ? 'Metriclane' : 'Clearview',
        );
        expect(project.competitors[0].domains).toEqual([
          manual ? 'metriclane.com' : 'clearview.com',
        ]);
      }
      const runs = await repository.listRuns(project.id);
      expect(runs).toHaveLength(3);
      expect(
        runs.every(
          (run) =>
            JSON.stringify(run.snapshot.competitors) ===
            JSON.stringify(project.competitors),
        ),
      ).toBe(true);
      expect(extract).toHaveBeenCalled();
      const rows = await repository.listResults(project.id, runs[0].id);
      const analysis = await artifacts.get<Analysis>(
        rows.find((row) => row.analysisKey)!.analysisKey!,
      );
      if (choice === 'cleared') expect(analysis?.brands).toHaveLength(1);
      else
        expect(
          analysis?.brands.find(
            (brand) => brand.brandId === project.competitors[0].id,
          )?.mentioned,
        ).toBe(true);
      await worker.handle(item.project.id, item.job.id);
      expect((await repository.getProject(project.id))?.competitors).toEqual(
        project.competitors,
      );
      expect(await repository.listRuns(project.id)).toHaveLength(3);
    },
  );
});
