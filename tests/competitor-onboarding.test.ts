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
      text: 'Clearview provides inventory analytics. Clearview serves shops in Italy. https://www.clearview.com/about',
    },
    {
      id: 'own',
      text: 'Acme Tools offers inventory analytics and payroll audits for shops. https://help.acme.com/about',
    },
    {
      id: 'duplicate',
      text: 'Clearview provides inventory analytics. Clearview serves shops in Italy. https://other.com/about',
    },
    {
      id: 'clothing',
      text: 'Jet sells clothing to small businesses in Italy. https://jetwear.com/store',
    },
    {
      id: 'market',
      text: 'Clearview serves shops only in Canada. https://clearview.com/availability',
    },
    {
      id: 'misnamed',
      text: 'Our service includes inventory analytics for shops in Italy. https://clearview.com/clearview',
    },
    {
      id: 'regional',
      text: 'Clearview provides inventory analytics to customers in Milan and online worldwide. https://clearview.com/customers',
    },
    {
      id: 'hq',
      text: 'Clearview is headquartered in Italy. https://clearview.com/contact',
    },
    {
      id: 'toronto',
      text: 'Clearview serves retailers only in Toronto. https://clearview.com/retail',
    },
    {
      id: 'negative',
      text: 'Clearview does not serve shops in Italy. https://clearview.com/zones',
    },
    {
      id: 'italy',
      text: 'Clearview assists clients in Milan, Italy. https://clearview.com/lombardy',
    },
  ];
  return capturedResearch(blocks);
}
function capturedResearch(
  blocks: { id: string; text: string }[],
): CapturedAnswer {
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
      start: block.text.indexOf('https://'),
      end: block.text.length,
    })),
    sources: [{ url: 'https://unrelated.com' }],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: new Date().toISOString(),
    raw: {},
  };
}

const targetClaim =
  'Acme Tools offers inventory analytics and payroll audits for shops.';
const scope = { country: 'IT', language: 'en' };
function proposal(saved: CapturedAnswer) {
  const catalog = researchEvidenceCatalog(saved);
  return {
    name: 'Clearview',
    websiteUrl: 'https://clearview.com',
    relationship: 'direct_alternative',
    sharedNeed: 'inventory analytics',
    targetOffering: { quote: targetClaim, evidenceId: catalog[1].id },
    competingOffering: {
      quote: 'Clearview provides inventory analytics.',
      evidenceId: catalog[0].id,
    },
    market: {
      quote: 'Clearview serves shops in Italy.',
      area: 'Italy',
      country: 'IT',
      evidenceId: catalog[0].id,
    },
  };
}

describe('grounded onboarding competitors', () => {
  it('keeps competitor extraction alongside the brandbook and outside its editable fields', async () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved);
    const job = policyJob();
    const output = {
      evidence: [
        { field: 'about', value: targetClaim, evidenceId: catalog[1].id },
        { field: 'keyFeatures', value: targetClaim, evidenceId: catalog[1].id },
      ],
      knowledgeSources: [],
      sitemapUrl: null,
      caseStudiesSourceUrl: null,
      postGuidelines: { dos: [], donts: [] },
      unknowns: [],
      competitors: [proposal(saved)],
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

  it('retains only the official claims that explain the buyer overlap and available market', () => {
    const saved = research(),
      c = proposal(saved);
    const accepted = resolveDiscoveredCompetitors(
      [c, { ...c, websiteUrl: 'https://www.clearview.com/shop' }],
      saved,
      target,
      scope,
    );
    expect(accepted).toEqual([
      {
        name: c.name,
        domain: 'clearview.com',
        evidence: [
          {
            quote: c.competingOffering.quote,
            url: 'https://www.clearview.com/about',
          },
          { quote: c.market.quote, url: 'https://www.clearview.com/about' },
        ],
        relevance: {
          sharedNeed: 'inventory analytics',
          country: 'IT',
          targetOffering: {
            quote: c.targetOffering.quote,
            url: 'https://help.acme.com/about',
          },
          competingOffering: {
            quote: c.competingOffering.quote,
            url: 'https://www.clearview.com/about',
          },
          market: {
            quote: c.market.quote,
            url: 'https://www.clearview.com/about',
          },
        },
      },
    ]);
  });

  it('rejects unrelated providers, missing offering evidence, indirect sellers and the target’s own brands', () => {
    const saved = research(),
      catalog = researchEvidenceCatalog(saved),
      c = proposal(saved);
    const jet = {
      name: 'Jet',
      websiteUrl: 'https://jetwear.com',
      competingOffering: {
        quote: 'Jet sells clothing to small businesses in Italy.',
        evidenceId: catalog[3].id,
      },
      market: {
        quote: 'Jet sells clothing to small businesses in Italy.',
        area: 'Italy',
        country: 'IT',
        evidenceId: catalog[3].id,
      },
    };
    const rivals = [
      { ...c, ...jet },
      { ...c, ...jet, sharedNeed: 'clothing' },
      { ...c, relationship: 'indirect' },
      { ...c, relationship: 'same_business' },
      {
        ...c,
        targetOffering: { ...c.targetOffering, evidenceId: catalog[0].id },
      },
      {
        ...c,
        competingOffering: {
          ...c.competingOffering,
          quote: 'Invented inventory analytics service.',
        },
      },
      { ...c, name: 'Acme Tools', websiteUrl: 'https://help.acme.com' },
      { ...c, name: 'Unrelated' },
      { ...c, websiteUrl: 'https://other.com' },
      { ...c, websiteUrl: 'http://127.0.0.1' },
      { ...c, sharedNeed: 'analytics agency' },
      {
        ...c,
        competingOffering: {
          evidenceId: catalog[5].id,
          quote: 'Our service includes inventory analytics for shops in Italy.',
        },
        market: {
          country: 'IT',
          area: 'Italy',
          evidenceId: catalog[5].id,
          quote: 'Our service includes inventory analytics for shops in Italy.',
        },
      },
    ];
    for (const rival of rivals)
      expect(
        resolveDiscoveredCompetitors([rival], saved, target, scope),
      ).toEqual([]);
    expect(
      resolveDiscoveredCompetitors([c], saved, target, {
        ...scope,
        promptFocus: 'payroll audits',
      }),
    ).toEqual([]);
  });

  it('supports local/global availability and rejects wrong markets and headquarters-only proof', () => {
    const saved = research(),
      c = proposal(saved),
      catalog = researchEvidenceCatalog(saved);
    const onlyCanada = {
      country: 'IT',
      area: 'Canada',
      quote: 'Clearview serves shops only in Canada.',
      evidenceId: catalog[4].id,
    };
    for (const market of [
      onlyCanada,
      { ...c.market, country: 'US' },
      { ...c.market, area: 'Paris' },
      {
        ...c.market,
        area: 'Toronto',
        quote: 'Clearview serves retailers only in Toronto.',
        evidenceId: catalog[8].id,
      },
      {
        ...c.market,
        area: 'Italy',
        quote: 'serve shops in Italy',
        evidenceId: catalog[9].id,
      },
      {
        ...c.market,
        evidenceId: catalog[7].id,
        quote: 'Clearview is headquartered in Italy.',
      },
    ]) {
      expect(
        resolveDiscoveredCompetitors([{ ...c, market }], saved, target, scope),
      ).toEqual([]);
    }
    for (const market of [
      {
        country: 'IT',
        area: 'worldwide',
        evidenceId: catalog[6].id,
        quote:
          'Clearview provides inventory analytics to customers in Milan and online worldwide.',
      },
      {
        country: 'IT',
        area: 'Milan',
        evidenceId: catalog[10].id,
        quote: 'Clearview assists clients in Milan, Italy.',
      },
    ]) {
      expect(
        resolveDiscoveredCompetitors([{ ...c, market }], saved, target, scope),
      ).toHaveLength(1);
    }
  });

  it('does not choose between two independent business domains sharing an unqualified name', () => {
    const saved = research(),
      c = proposal(saved),
      catalog = researchEvidenceCatalog(saved);
    expect(
      resolveDiscoveredCompetitors(
        [
          c,
          {
            ...c,
            websiteUrl: 'https://other.com',
            competingOffering: {
              ...c.competingOffering,
              evidenceId: catalog[2].id,
            },
            market: { ...c.market, evidenceId: catalog[2].id },
          },
        ],
        saved,
        target,
        scope,
      ),
    ).toEqual([]);
  });

  it('recovers a concrete product identifier and locally served buyers without crediting unrelated publications', () => {
    const saved = capturedResearch([
      {
        id: 'primary',
        text: 'Acme files Q‑7 applications in Italy. https://acme.com/q7',
      },
      {
        id: 'firm',
        text: '1. Stockbridge Law\nThe firm provides Q7 filing services for Italian investors. https://stockbridgelaw.com/services',
      },
      {
        id: 'topic',
        text: 'Q7 forms require a local signature. https://stockbridgelaw.com/services',
      },
      {
        id: 'publisher',
        text: 'The Ledger publishes articles about Q7 for Italian investors. https://ledger.com/articles',
      },
    ]);
    const catalog = researchEvidenceCatalog(saved);
    const c = {
      name: 'Stockbridge Law',
      websiteUrl: 'https://stockbridgelaw.com',
      relationship: 'direct_alternative',
      sharedNeed: 'Comprehensive Q-7 application services for local investors',
      targetOffering: {
        evidenceId: catalog[0].id,
        quote: 'Acme files Q‑7 applications in Italy.',
      },
      competingOffering: {
        evidenceId: catalog[1].id,
        quote: 'The firm provides Q7 filing services for Italian investors.',
      },
      market: {
        country: 'IT',
        area: 'investors',
        evidenceId: catalog[2].id,
        quote: 'Q7 forms require a local signature.',
      },
    };
    const publisher = {
      ...c,
      name: 'The Ledger',
      websiteUrl: 'https://ledger.com',
      competingOffering: {
        evidenceId: catalog[3].id,
        quote: 'The Ledger publishes articles about Q7 for Italian investors.',
      },
      market: {
        area: 'Italian',
        country: 'IT',
        evidenceId: catalog[3].id,
        quote: 'The Ledger publishes articles about Q7 for Italian investors.',
      },
    };
    const accepted = resolveDiscoveredCompetitors(
      [c, publisher],
      saved,
      target,
      scope,
    );
    expect(accepted.map((x) => x.name)).toEqual(['Stockbridge Law']);
    expect(accepted[0].relevance).toMatchObject({
      sharedNeed: 'Q-7',
      market: { quote: c.competingOffering.quote },
    });
  });

  it('cannot use a shared place or a generic audience as the competing service', () => {
    const saved = capturedResearch([
      {
        id: 'primary',
        text: 'Acme provides visa help to small teams in the United States. https://acme.com/q7',
      },
      {
        id: 'rival',
        text: 'Clearview ships clothing to small teams in the United States. https://clearview.com/shop',
      },
    ]);
    const catalog = researchEvidenceCatalog(saved),
      c = proposal(research());
    const row = {
      ...c,
      targetOffering: {
        quote: 'Acme provides visa help to small teams in the United States.',
        evidenceId: catalog[0].id,
      },
      competingOffering: {
        quote: 'Clearview ships clothing to small teams in the United States.',
        evidenceId: catalog[1].id,
      },
      market: {
        quote: 'Clearview ships clothing to small teams in the United States.',
        area: 'United States',
        country: 'US',
        evidenceId: catalog[1].id,
      },
    };
    for (const sharedNeed of [
      'United States',
      'small teams',
      'Support small teams in the United States',
    ]) {
      expect(
        resolveDiscoveredCompetitors([{ ...row, sharedNeed }], saved, target, {
          country: 'US',
          language: 'en',
        }),
      ).toEqual([]);
    }
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
