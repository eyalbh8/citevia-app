import { describe, expect, it } from 'vitest';
import { type Analysis, type CapturedAnswer, type DemoConfig, type Page, type Project, type PromptResult, type SourceRow } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = () => new Date('2026-10-25T12:00:00.000Z');
const services = [
  { id: 'gutter', name: 'All American Gutter Protection', domain: 'allamericangutterprotection.com', keyword: 'gutter',
    industry: { label: 'gutter protection', audience: 'homeowners', services: ['gutter guards', 'gutter installation'], criteria: ['guard materials', 'installation', 'warranty terms'] },
    profile: { visibilityAdjustment: -.01, growthCurve: .97, trafficScale: 1.08, monthlyGrowth: .105 } },
  { id: 'locksmith', name: 'Acme Locksmith', domain: 'acmelocksmith.com', keyword: 'lock',
    industry: { label: 'locksmith services', audience: 'homeowners and businesses', services: ['lock repair', 'rekeying', 'access control'], criteria: ['service availability', 'security needs', 'pricing'] },
    profile: { visibilityAdjustment: -.04, growthCurve: 1.04, trafficScale: .78, monthlyGrowth: .09 } },
  { id: 'electricity', name: 'Freedom Power', domain: 'gofreedompower.com', keyword: 'electricity',
    industry: { label: 'electricity plans', audience: 'Texas electricity customers', services: ['electricity plan comparisons', 'account service'], criteria: ['rates', 'contract terms', 'usage', 'customer support'] },
    profile: { visibilityAdjustment: .01, growthCurve: .94, trafficScale: 1.03, monthlyGrowth: .11 } },
  { id: 'windows', name: 'WindowWorks', domain: 'mywindowworks.com', keyword: 'window',
    industry: { label: 'window replacement', audience: 'homeowners', services: ['window replacement', 'professional installation'], criteria: ['frame materials', 'energy efficiency', 'installation', 'warranties'] },
    profile: { visibilityAdjustment: -.02, growthCurve: 1.1, trafficScale: .88, monthlyGrowth: .1 } },
] satisfies { id: string; name: string; domain: string; keyword: string; industry: NonNullable<DemoConfig['industry']>; profile: NonNullable<DemoConfig['profile']> }[];

function fixture(service = services[0]): Project {
  const id = `account_${service.id}_demo_v1`;
  const project = newProject({ id, name: service.name, brand: service.name, domain: service.domain,
    now: new Date('2026-10-25T00:00:00.000Z'),
    prompts: Array.from({ length: 50 }, (_, index) => `How should I compare ${service.industry.label} for service need ${index + 1}?`) });
  const official = `https://${service.domain}/public-resource`;
  return {
    ...project, enabled: false, timezone: 'UTC',
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    scanProviders: [{ provider: 'openai', model: 'saved-openai' }, { provider: 'perplexity', model: 'saved-perplexity' }, { provider: 'gemini', model: 'saved-gemini' }],
    demo: {
      version: 1, source: 'website-demo', startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25',
      sourceAccountId: service.domain, sourceCopiedAt: '2026-10-25T00:00:00.000Z', industry: service.industry, profile: service.profile,
      samples: [{ answerText: `${service.name}: ${service.industry.services.join(', ')}.`,
        companies: Array.from({ length: 8 }, (_, index) => `Independent source alternative ${index + 1}`),
        citations: [{ url: official, title: `${service.name} public resource` },
          { url: 'https://www.bbb.org/all/consumer-resources', title: 'Independent consumer resources' },
          { url: 'https://www.ftc.gov/business-guidance', title: 'Independent business guidance' }] }],
      trackedUrls: Array.from({ length: 156 }, (_, index) => {
        const publishedAt = new Date(Date.UTC(2026, 3, 27, 8) + (Math.floor(index / 3) * 7 + index % 3 * 2) * 86400000).toISOString();
        return { url: `https://app.citevia.io/demo-content/${id}/${service.id}-guide-${index + 1}`,
          title: `${service.name} service guide ${index + 1}`, publishedAt, createdAt: publishedAt, contentType: 'BLOG' as const,
          demoPost: true as const, body: `A demonstration guide to ${service.industry.label}. Compare ${service.industry.criteria.join(', ')}.`,
          provenance: { kind: 'demo-draft' as const, sourceUrls: [official] } };
      }),
    },
  };
}
async function setup(project = fixture()) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const base = { repository, artifacts, queue };
  return { project, base, runtime: withDemoRuntime(base, now) };
}
function month(month: number) {
  const start = new Date(Date.UTC(2026, month, 1)).toISOString(), end = new Date(Date.UTC(2026, month + 1, 1) - 1).toISOString();
  return { period: { start, end, granularity: 'daily' as const, timezone: 'UTC' },
    previous: { start: new Date(Date.UTC(2026, month - 1, 1)).toISOString(), end: new Date(Date.UTC(2026, month, 1) - 1).toISOString(), granularity: 'daily' as const, timezone: 'UTC' },
    providers: [], countries: [] };
}

describe('public website service scenarios', () => {
  it.each(services)('uses $name industry copy, varied growth and native evidence without paid work', async service => {
    const { project, base, runtime } = await setup(fixture(service));
    const history = await runtime.repository.listPromptHistory(project.id, '2027-03-01T00:00:00.000Z', '2027-03-31T23:59:59.999Z');
    const result = history.results.find(result => result.target?.sentiment === 'positive')!;
    const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
    const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
    expect(answer.text.toLowerCase()).toContain(service.keyword);
    expect(answer.text).toContain(service.name);
    expect(answer.text).not.toMatch(/unattended retail|payment platform|roof inspections|roofing contractors/);
    for (const company of analysis.companies || [])
      expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
    const anchor = aggregateScenarioTraffic(project, month(9));
    expect(anchor.providers[0].visits).toBe(Math.round(2000 * service.profile.trafficScale));
    let previous = 0;
    for (let calendarMonth = 5; calendarMonth <= 14; calendarMonth++) {
      const traffic = aggregateScenarioTraffic(project, month(calendarMonth));
      expect(traffic.current).toBeGreaterThan(previous); previous = traffic.current;
    }
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect((await base.repository.aggregateTraffic(project.id, month(9))).current).toBe(0);
    expect(base.artifacts.values.size).toBe(0);
    expect(base.queue.messages).toEqual([]);
  });

  it('preserves two scans and three posts weekly, including native first pickup for demo-only articles', async () => {
    const { project, runtime, base } = await setup();
    const history = await runtime.repository.listPromptHistory(project.id, '2026-04-25T00:00:00.000Z', '2027-04-25T23:59:59.999Z');
    const times = [...new Set(history.runs.map(run => run.scheduledAt))].sort();
    expect(times).toHaveLength(104);
    expect(history.runs).toHaveLength(312);
    expect(project.demo!.trackedUrls).toHaveLength(156);
    const urls = await runtime.repository.listTrackedUrls(project.id), matches = await runtime.repository.listTrackingMatches(project.id);
    for (const url of urls.filter(url => url.publishedAt <= now().toISOString())) {
      const first = times.find(at => at >= url.publishedAt)!;
      if (first > now().toISOString()) continue;
      expect(matches.some(match => match.trackedUrlId === url.id && match.capture.mentioned &&
        match.capture.capturedAt >= first && Date.parse(match.capture.capturedAt) < Date.parse(first) + 50_000)).toBe(true);
    }
    expect(await base.repository.listTrackingMatches(project.id)).toEqual([]);
  });

  it('populates Sources domains, URLs and linked answers from the same native captures', async () => {
    const { project, base } = await setup();
    const identity = testIdentity('website-demo-owner');
    await base.repository.syncUser(identity);
    await base.repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    const api = createApi(base, { mode: 'live', now, providerConfigured: true });
    const call = async <T,>(tail: string): Promise<T> => {
      const response = await api(new Request(`https://test/v1/projects/${project.id}/${tail}`), identity);
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json() as Promise<T>;
    };
    const domains = await call<Page<SourceRow>>('sources?kind=cited&groupBy=domain');
    expect(domains.items.some(source => source.owned && source.domain === services[0].domain)).toBe(true);
    expect(domains.items.some(source => source.domain === 'bbb.org' && !source.owned)).toBe(true);
    const urls = await call<Page<SourceRow>>('sources?kind=cited&groupBy=url&limit=100');
    expect(urls.items.some(source => source.url?.startsWith('https://app.citevia.io/demo-content/'))).toBe(true);
    const source = urls.items.find(source => source.url === `https://${services[0].domain}/public-resource`)!;
    expect(source.citationCount).toBeGreaterThan(0);
    const responses = await call<Page<PromptResult>>(`sources/${source.id}/responses?limit=100`);
    expect(responses.total).toBe(source.answerCount);
    expect(responses.items.every(result => source.responseIds.includes(result.responseId))).toBe(true);
    const selected = responses.items[0];
    const detail = await call<{ answer: CapturedAnswer }>(`responses/${encodeURIComponent(selected.responseId)}`);
    expect(detail.answer.citations.some(citation => citation.url === source.url)).toBe(true);
    const consulted = await call<Page<SourceRow>>('sources?kind=consulted&groupBy=domain');
    expect(consulted.total).toBeGreaterThan(0);
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect(base.artifacts.values.size).toBe(0);
  });

  it('allows explicit account copy and rejects absent industry or forged demo draft ownership', async () => {
    const project = fixture();
    project.demo!.copy = { introduction: 'Compare local gutter services by installation and maintenance.',
      positiveCompany: ' offers an option for gutter protection and maintenance.', fallback: 'Compare gutter service options.' };
    const { runtime } = await setup(project);
    const result = (await runtime.repository.listPromptHistory(project.id, '2027-03-01T00:00:00Z', '2027-03-31T23:59:59Z')).results.find(result => result.target?.sentiment === 'positive')!;
    expect((await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!.text).toContain('offers an option for gutter protection');
    const invalid = fixture(); delete invalid.demo!.industry;
    await expect((await setup(invalid)).runtime.repository.listRuns(invalid.id)).rejects.toThrow('industry context');
    const forged = fixture(); forged.demo!.trackedUrls![0].url = 'https://app.citevia.io/demo-content/another-account/service-guide';
    await expect((await setup(forged)).runtime.repository.listRuns(forged.id)).rejects.toThrow('draft metadata');
  });
});
