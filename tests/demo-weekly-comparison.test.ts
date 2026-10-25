import { describe, expect, it } from 'vitest';
import {
  type Analysis, type CapturedAnswer, type DashboardOverview, type DemoConfig, type Project,
  type PromptHistory, type ScanProvider,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = () => new Date('2026-10-25T12:00:00.000Z');
const period = ['2026-10-19T00:00:00.000Z', '2026-10-25T23:59:59.999Z'] as const;
const providers: ScanProvider[] = ['openai', 'perplexity', 'gemini'];
const scenarios = [
  { id: 'account_dr_roof_demo_v1', name: 'Dr. Roof', domain: 'drroof.com', source: 'igeo-dr-roof',
    profile: { visibilityAdjustment: -.03, growthCurve: 1.06, trafficScale: .92, monthlyGrowth: .095 } },
  { id: 'account_all_american_gutter_demo_v1', name: 'All American Gutter Protection', domain: 'allamericangutterprotection.com', source: 'website-demo',
    profile: { visibilityAdjustment: -.01, growthCurve: 1.03, trafficScale: 1.24, monthlyGrowth: .085 } },
  { id: 'account_acme_locksmith_demo_v1', name: 'ACME Locksmith', domain: 'acmelocksmith.com', source: 'website-demo',
    profile: { visibilityAdjustment: .02, growthCurve: 1.12, trafficScale: .74, monthlyGrowth: .092 } },
  { id: 'account_freedom_power_demo_v1', name: 'Freedom Power', domain: 'gofreedompower.com', source: 'website-demo',
    profile: { visibilityAdjustment: -.04, growthCurve: 1.08, trafficScale: 1.09, monthlyGrowth: .118 } },
  { id: 'account_windowworks_demo_v1', name: 'WindowWorks', domain: 'mywindowworks.com', source: 'website-demo',
    profile: { visibilityAdjustment: .01, growthCurve: .98, trafficScale: .86, monthlyGrowth: .104 } },
] satisfies { id: string; name: string; domain: string; source: DemoConfig['source']; profile: NonNullable<DemoConfig['profile']> }[];

function fixture(scenario: typeof scenarios[number]): Project {
  const project = newProject({ id: scenario.id, name: scenario.name, brand: scenario.name, domain: scenario.domain,
    now: now(), prompts: Array.from({ length: 50 }, (_, index) => `Which service provider fits customer need ${index + 1}?`) });
  const prefix = scenario.source === 'igeo-dr-roof' ? 'dr-roof-demo' : scenario.id;
  project.brand.aliases = [];
  project.prompts = project.prompts.map((prompt, index) => ({ ...prompt, id: `${prefix}-p${String(index + 1).padStart(2, '0')}` }));
  project.competitors = Array.from({ length: 5 }, (_, index) => ({ id: `${prefix}-competitor-${index + 1}`,
    name: `Comparable Service ${index + 1}`, aliases: [], domains: [`service-${index + 1}.example`] }));
  project.enabled = false;
  project.timezone = 'UTC';
  project.scanSchedule = { version: 1, slotsUtcMinutes: [600, 5640] };
  project.scanProviders = providers.map(provider => ({ provider, model: `saved-${provider}` }));
  project.demo = {
    version: 1, source: scenario.source, startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25',
    sourceAccountId: `website:${scenario.domain}`, sourceCopiedAt: now().toISOString(), profile: scenario.profile,
    industry: { label: 'local services', audience: 'customers', services: ['service comparisons'], criteria: ['scope', 'availability', 'support'] },
    samples: [{ answerText: `${scenario.name} offers services for customers.`,
      companies: Array.from({ length: 8 }, (_, index) => `Source Alternative ${index + 1}`),
      citations: [{ url: `https://${scenario.domain}/services/`, title: 'Service information' }] }],
    trackedUrls: ['2026-10-19', '2026-10-21', '2026-10-23'].map(date => ({
      url: `https://${scenario.domain}/blog/service-guide-${date}`, title: `Service guide ${date}`, contentType: 'BLOG',
      publishedAt: `${date}T08:00:00.000Z`, createdAt: `${date}T08:00:00.000Z`,
    })),
  };
  return project;
}

async function setup(project: Project) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const base = { repository, artifacts, queue };
  return { base, runtime: withDemoRuntime(base, now) };
}
const rounded = (value: number) => Number(value.toFixed(2));
function percentChange(first: number, last: number) {
  return rounded(first ? (last - first) * 100 / first : last ? 100 : 0);
}
function dailyMeasurements(project: Project, history: PromptHistory) {
  const daily = new Map<string, Map<string, { mentions: number; sentiment: number[] }>>();
  for (const result of history.results) {
    const date = result.capturedAt!.slice(0, 10), brands = daily.get(date) || new Map();
    for (const brand of result.brands || []) {
      const value = brands.get(brand.brandId) || { mentions: 0, sentiment: [] };
      if (brand.mentioned) {
        value.mentions++;
        value.sentiment.push(brand.sentiment === 'positive' ? 100 : brand.sentiment === 'negative' ? 0 : 50);
      }
      brands.set(brand.brandId, value);
    }
    daily.set(date, brands);
  }
  const dates = [...daily.keys()].sort();
  expect(dates).toEqual(['2026-10-19', '2026-10-22']);
  const target = dates.map(date => daily.get(date)!.get(project.brand.id)!);
  return { daily, dates, target };
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe('seven-day compact demo comparisons', () => {
  it.each(scenarios)('derives $name provider and industry changes from its two actual weekly captures', async scenario => {
    const project = fixture(scenario), before = structuredClone(project), { base, runtime } = await setup(project);
    const history = await runtime.repository.listPromptHistory(project.id, ...period);
    expect(history.runs).toHaveLength(6);
    expect(history.results).toHaveLength(300);
    const identity = testIdentity(`weekly-${project.id}`);
    await base.repository.syncUser(identity);
    await base.repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    const api = createApi(base, { mode: 'live', now, providerConfigured: true });
    const response = await api(new Request(`https://test/v1/projects/${project.id}/dashboard/overview?days=7`), identity);
    expect(response.status, await response.clone().text()).toBe(200);
    const overview = await response.json() as DashboardOverview;
    expect(overview.comparison).toBe('first_to_last_observed_day');
    expect(overview.analyzed).toBe(history.results.length);
    for (const provider of providers) {
      const runs = history.runs.filter(run => run.snapshot.provider === provider).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      const counts = runs.map(run => history.results.filter(result => result.runId === run.id && result.target!.mentioned).length);
      expect(counts[1], `${scenario.name} ${provider} gains mentions within the week`).toBeGreaterThan(counts[0]);
      expect(overview.providers.find(item => item.provider === provider)).toEqual({ provider, count: counts[0] + counts[1], change: percentChange(counts[0], counts[1]) });
    }
    const { daily, dates, target } = dailyMeasurements(project, history);
    const targetRow = overview.ranking.find(row => row.isTarget)!;
    expect(targetRow.mentionChange).toBe(percentChange(target[0].mentions, target[1].mentions));
    expect(targetRow.mentionChange).toBeGreaterThan(0);
    expect(targetRow.sentimentChange).toBe(Math.round(mean(target[1].sentiment)) - Math.round(mean(target[0].sentiment)));
    expect(targetRow.sentimentChange).toBeGreaterThan(0);
    for (const row of overview.ranking) {
      const first = daily.get(dates[0])!.get(row.brandId)!, last = daily.get(dates[1])!.get(row.brandId)!;
      const rank = (date: string, count: number) => 1 + [...daily.get(date)!.values()].filter(brand => brand.mentions > count).length;
      expect(row.mentionChange).toBe(percentChange(first.mentions, last.mentions));
      expect(row.rankChange).toBe(rank(dates[0], first.mentions) - rank(dates[1], last.mentions));
      expect(row.sentimentChange).toBe(Math.round(mean(last.sentiment)) - Math.round(mean(first.sentiment)));
    }
    const competitors = overview.ranking.filter(row => !row.isTarget);
    expect(competitors.some(row => row.mentionChange !== 0)).toBe(true);
    expect(competitors.some(row => row.sentimentChange !== 0)).toBe(true);

    // The change is in the captures themselves, so every downstream screen sees
    // the same company order and sentiment rather than a dashboard-only badge.
    const samples = history.runs.map(run => history.results.find(result => result.runId === run.id && result.target!.mentioned)!);
    for (const result of samples) {
      const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      for (const brand of analysis.brands) {
        const measured = result.brands!.find(item => item.brandId === brand.brandId)!;
        expect({ mentioned: brand.mentioned, rank: brand.appearanceRank, sentiment: brand.sentiment })
          .toEqual({ mentioned: measured.mentioned, rank: measured.appearanceRank, sentiment: measured.sentiment });
        for (const span of brand.evidence) expect(answer.text.slice(span.start, span.end)).toBe(span.quote);
      }
      for (const company of analysis.companies || []) {
        expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
        expect(company.evidence.quote).toContain(`${company.rank}. ${company.name}`);
        expect(company.evidence.quote).toContain(company.sentiment === 'positive' ? 'is a strong option' : 'is an established');
      }
    }
    const another = withDemoRuntime(base, now);
    expect(await another.repository.listPromptHistory(project.id, ...period)).toEqual(history);
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect(await base.repository.listPromptHistory(project.id, ...period)).toEqual({ runs: [], results: [] });
    expect(base.artifacts.values.size).toBe(0);
    expect(base.queue.messages).toEqual([]);
    expect(await base.repository.getProject(project.id)).toEqual(before);
  });

  it('allows competitors to exchange industry positions without forcing every rank delta away from zero', async () => {
    const project = fixture(scenarios.find(scenario => scenario.name === 'Freedom Power')!);
    const { base } = await setup(project), identity = testIdentity('weekly-industry-ranks');
    await base.repository.syncUser(identity);
    await base.repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    const api = createApi(base, { mode: 'live', now, providerConfigured: true });
    const response = await api(new Request(`https://test/v1/projects/${project.id}/dashboard/overview?days=7`), identity);
    expect(response.status).toBe(200);
    const overview = await response.json() as DashboardOverview;
    expect(overview.ranking.some(row => !row.isTarget && row.rankChange !== 0)).toBe(true);
  });
});
