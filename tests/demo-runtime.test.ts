import { describe, expect, it, vi } from 'vitest';
import {
  aggregateDashboardOverview,
  brandSentimentScore,
  promptPeriodMetrics,
  type Analysis,
  type CapturedAnswer,
  type Project,
  type RunSummary,
  type TrafficFilters,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime, type Runtime } from '@citevia/storage';
import { buildNayaxDemo } from '../scripts/create-nayax-demo.js';
import { newProject } from './fixtures/scanner.js';

const now = () => new Date('2026-10-23T12:00:00.000Z');
async function setup() {
  const project: Project = {
    ...newProject({ id: 'nayax-demo', name: 'Nayax Demo', brand: 'Nayax', domain: 'nayax.com' }),
    enabled: false,
    scanProviders: [
      { provider: 'openai', model: 'synthetic-demo-v1' },
      { provider: 'perplexity', model: 'synthetic-demo-v1' },
      { provider: 'gemini', model: 'synthetic-demo-v1' },
    ],
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source: 'igeo-nayax', anchorDate: '2026-10-23',
      startDate: '2026-04-23', endDate: '2027-04-23',
      sourceAccountId: 'source-nayax', sourceCopiedAt: now().toISOString(),
      samples: [{
        answerText: 'Nayax offers a comprehensive unattended payment solution.',
        companies: ['PayRange', 'Cantaloupe', 'Clover', 'Ingenico', 'Worldpay', 'Adyen', 'PayPal', 'SumUp', 'Nayax Ltd'],
        citations: Array.from({ length: 7 }, (_, index) => ({ url: `https://source-${index}.example/guide`, title: `Payment guide ${index}` })),
      }],
      traffic: { countries: ['US', 'GB', 'IL'], pages: ['/', '/products', '/contact'], devices: ['desktop', 'mobile', 'tablet'], browsers: ['Chrome', 'Safari', 'Edge'] },
    },
  };
  const repository = new MemoryRepository();
  await repository.saveProject(project, null);
  const artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  const base: Runtime = { repository, artifacts, queue };
  return { project, base, demo: withDemoRuntime(base, now) };
}

function trafficFilters(start: string, end: string, granularity: 'daily' | 'hourly' = 'daily'): TrafficFilters {
  const duration = Date.parse(end) - Date.parse(start) + 1;
  return {
    period: { start, end, granularity, timezone: 'UTC' },
    previous: { start: new Date(Date.parse(start) - duration).toISOString(), end: new Date(Date.parse(start) - 1).toISOString(), granularity, timezone: 'UTC' },
    countries: [], providers: [],
  };
}

describe('virtual demo measurements', () => {
  it('generates two weekly scan groups, fifty prompts and three providers without saving observations', async () => {
    const { project, base, demo } = await setup();
    const history = await demo.repository.listPromptHistory(project.id, '2026-04-23T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    const weeks = new Map<string, Set<string>>();
    const perRun = new Map<string, number>();
    for (const run of history.runs) {
      const date = new Date(run.scheduledAt);
      const monday = new Date(date);
      monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const week = monday.toISOString().slice(0, 10);
      const dates = weeks.get(week) || new Set<string>();
      dates.add(run.scheduledAt); weeks.set(week, dates);
      const minute = ((date.getUTCDay() + 6) % 7) * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes();
      expect(project.scanSchedule!.slotsUtcMinutes).toContain(minute);
    }
    for (const result of history.results) perRun.set(result.runId, (perRun.get(result.runId) || 0) + 1);
    expect(history.runs.length).toBeGreaterThanOrEqual(104 * 3);
    expect(history.results.length).toBe(history.runs.length * 50);
    expect([...perRun.values()].every((count) => count === 50)).toBe(true);
    expect([...weeks.values()].slice(1, -1).every((dates) => dates.size === 2)).toBe(true);
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect(await base.repository.listPromptHistory(project.id, '2020-01-01', '2030-01-01')).toEqual({ runs: [], results: [] });
    expect(base.queue).toBe(demo.queue);
    expect((base.queue as MemoryQueue).messages).toHaveLength(0);
  });

  it('is deterministic across runtimes and keeps latest scans in the past while exposing future projections explicitly', async () => {
    const { project, base, demo } = await setup();
    const recent = await demo.repository.listRuns(project.id, 180);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((run) => run.scheduledAt <= now().toISOString())).toBe(true);
    const future = await demo.repository.listPromptHistory(project.id, '2027-03-01T00:00:00.000Z', '2027-03-07T23:59:59.999Z');
    expect(future.results).toHaveLength(2 * 50 * 3);
    const other = withDemoRuntime(base, now);
    expect(await other.repository.listPromptHistory(project.id, '2027-03-01T00:00:00.000Z', '2027-03-07T23:59:59.999Z')).toEqual(future);
    const sample = future.results[0];
    expect(sample.responseId.split('~')).toEqual([sample.runId, sample.promptId]);
    expect(await demo.repository.getRun(project.id, sample.runId)).toEqual(future.runs[0]);
    expect(await demo.repository.getResult(project.id, sample.runId, sample.promptId)).toEqual(sample);
  });

  it('preserves target growth at every scan and improves comparable prompt periods', async () => {
    const { project, demo } = await setup();
    const history = await demo.repository.listPromptHistory(project.id, '2026-04-23T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    const measurements = history.runs.filter((run) => run.snapshot.provider === 'openai').map((run) => {
      const results = history.results.filter((result) => result.runId === run.id);
      const mentions = results.filter((result) => result.target!.mentioned);
      return {
        visibility: mentions.length,
        sentiment: mentions.reduce((sum, result) => sum + brandSentimentScore(result.target)!, 0) / mentions.length,
        rank: mentions.reduce((sum, result) => sum + result.target!.appearanceRank!, 0) / mentions.length,
        citations: results.reduce((sum, result) => sum + result.citationCount, 0),
      };
    });
    for (let index = 1; index < measurements.length; index++) {
      expect(measurements[index].visibility).toBeGreaterThanOrEqual(measurements[index - 1].visibility);
      expect(measurements[index].sentiment + 1e-8).toBeGreaterThanOrEqual(measurements[index - 1].sentiment);
      expect(measurements[index].rank).toBeLessThanOrEqual(measurements[index - 1].rank);
      expect(measurements[index].citations).toBeGreaterThanOrEqual(measurements[index - 1].citations);
    }
    expect(measurements.at(-1)!.visibility).toBeGreaterThan(measurements[0].visibility * 2);
    expect(measurements.at(-1)!.sentiment).toBeGreaterThan(measurements[0].sentiment + 20);
    expect(measurements.at(-1)!.rank).toBeLessThan(measurements[0].rank);
    expect(measurements.at(-1)!.citations).toBeGreaterThan(measurements[0].citations);
    const metrics = promptPeriodMetrics(project, history, '2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z');
    expect(metrics.items).toHaveLength(50);
    expect(metrics.items.every((item) => item.measurementCount > 0 && item.previousMeasurementCount > 0)).toBe(true);
    expect(metrics.items.every((item) => item.visibilityChange === null || item.visibilityChange >= 0)).toBe(true);
  });

  it('keeps Nayax in the dashboard top five with positive growth across the default history and full year', async () => {
    const tracked = [
      ['Cantaloupe', 'cantaloupe.com'], ['Crane Payment Innovations', 'cranepi.com'],
      ['Ingenico', 'ingenico.com'], ['PayRange', 'payrange.com'], ['365 Retail Markets', '365retailmarkets.com'],
    ];
    const alternatives = ['Adyen', 'Worldpay', 'Stripe', 'Square', 'Clover', 'PayPal', 'SumUp',
      'Verifone', 'PAX Technology', 'Fiserv', 'FIS', 'NMI', 'ID TECH', 'Castles Technology'];
    const project = buildNayaxDemo({
      brand: { name: 'Nayax', aliases: [], domains: ['nayax.com'] },
      competitors: [...tracked, ...alternatives.map((name, index) => [name, `payment-${index}.example`])]
        .map(([name, domain]) => ({ name, aliases: [], domains: [domain] })),
      prompts: Array.from({ length: 50 }, (_, index) => ({ text: `Which payment platform fits unattended retail use case ${index + 1}?` })),
      brandbook: { companyCountry: 'US', language: 'en' },
      samples: [{ text: 'Nayax provides cashless payments for unattended retail.' }],
    }, '2026-10-23', now().toISOString());
    const repository = new MemoryRepository();
    await repository.saveProject(project, null);
    const demo = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, now);
    for (const end of ['2026-10-22', '2027-04-23']) {
      const period = { start: '2026-04-23T00:00:00.000Z', end: `${end}T23:59:59.999Z`, granularity: 'daily' as const, timezone: 'UTC' as const };
      const history = await demo.repository.listPromptHistory(project.id, period.start, period.end);
      const runs = new Map(history.runs.map((run) => [run.id, run]));
      const overview = aggregateDashboardOverview(project, period,
        { providers: [], region: '', tag: '', branded: '', intent: '', search: '' },
        history.results.map((result) => ({ result, run: runs.get(result.runId)! })),
      );
      expect(overview.ranking).toHaveLength(5);
      const target = overview.ranking.find((brand) => brand.isTarget);
      expect(target, `Nayax is visible in the top five through ${end}`).toBeDefined();
      expect(target!.rankChange).toBeGreaterThan(0);
      expect(target!.mentionChange).toBeGreaterThan(0);
      expect(target!.sentimentChange).toBeGreaterThan(0);
    }
  });

  it('serves response evidence, indexed citations, cached analyses and summaries without touching the base artifact store', async () => {
    const { project, base, demo } = await setup();
    const reads = vi.spyOn(base.artifacts, 'get');
    const [run] = await demo.repository.listRuns(project.id);
    const results = await demo.repository.listResults(project.id, run.id);
    const result = results.find((item) => item.target!.mentioned)!;
    const answer = await demo.artifacts.get<CapturedAnswer>(result.captureKey!);
    expect(answer?.text).not.toMatch(/demo|synthetic|Saved source example:/i);
    expect(answer?.text).toContain('Nayax offers a comprehensive unattended payment solution.');
    expect(answer?.citations).toHaveLength(result.citationCount);
    const citations = await demo.repository.listNativeCitations(project.id, [`${run.snapshot.provider}:${result.captureKey}`]);
    expect(citations).toEqual([{ captureKey: `${run.snapshot.provider}:${result.captureKey}`, citations: answer!.citations }]);
    const saved = await demo.repository.listSavedAnalyses(project.id, [result as Required<typeof result>]);
    expect(saved).toHaveLength(1);
    expect(await demo.artifacts.get<Analysis>(result.analysisKey!)).toEqual(saved[0].analysis);
    const summary = await demo.artifacts.get<RunSummary>(run.summaryKey!);
    expect(summary?.metrics.analyzed).toBe(50);
    expect(summary?.metrics.captured).toBe(50);
    const omitted = results.find((item) => !item.target!.mentioned)!;
    expect((await demo.artifacts.get<CapturedAnswer>(omitted.captureKey!))!.text).not.toContain('Nayax');
    expect(reads).not.toHaveBeenCalled();
    expect(await demo.artifacts.get('demo/v1/nayax-demo/bad/summary.json')).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it('matches ordinal ranks and exact company evidence to the complete simulated answer ordering', async () => {
    const { project, demo } = await setup();
    const history = await demo.repository.listPromptHistory(project.id, '2026-04-23T00:00:00.000Z', '2026-04-30T23:59:59.999Z');
    let checkedTarget = false, checkedAbsent = false;
    const knownNames = new Set([project.brand.name, ...project.competitors.map((brand) => brand.name), ...project.demo!.samples!.flatMap((sample) => sample.companies || [])]);
    for (const result of history.results.slice(0, 150)) {
      const analysis = (await demo.artifacts.get<Analysis>(result.analysisKey!))!;
      const answer = (await demo.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const measuredText = answer.text;
      expect(analysis.companies!.map((company) => company.rank)).toEqual(analysis.companies!.map((_, index) => index + 1));
      expect(new Set(analysis.companies!.map((company) => company.name)).size).toBe(analysis.companies!.length);
      for (const company of analysis.companies!) {
        expect(knownNames.has(company.name)).toBe(true);
        expect(measuredText).toContain(`${company.rank}. ${company.name} is `);
        expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
        expect(company.evidence.quote).toContain(company.name);
      }
      for (const brand of analysis.brands) {
        const identity = [project.brand, ...project.competitors].find((item) => item.id === brand.brandId)!;
        const ordinal = analysis.companies!.findIndex((company) => company.name === identity.name) + 1;
        expect(brand.appearanceRank).toBe(brand.mentioned ? ordinal : null);
        expect(brand.mentionOrder).toBe(brand.mentioned ? ordinal : null);
        if (brand.mentioned) expect(brand.evidence[0].quote).toContain(identity.name);
      }
      if (result.target!.mentioned) {
        checkedTarget = true;
        expect(result.target!.appearanceRank).toBe(7);
      } else {
        checkedAbsent = true;
        expect(answer.text).not.toContain('Nayax');
      }
    }
    expect(checkedTarget && checkedAbsent).toBe(true);
  });

  it('reconciles growing traffic across every panel, provider filters, countries and hourly windows', async () => {
    const { project, demo } = await setup();
    const filters = trafficFilters('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z');
    const traffic = await demo.repository.aggregateTraffic(project.id, filters);
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    expect(traffic.providers.every((item) => item.visits > item.previous)).toBe(true);
    expect(traffic.series.reduce((sum, item) => sum + Object.values(item.values).reduce((total, visits) => total + visits, 0), 0)).toBe(traffic.current);
    for (const dimension of [traffic.sources, traffic.pages, traffic.locations, traffic.devices, traffic.browsers])
      expect(dimension.reduce((sum, item) => sum + item.visits, 0)).toBe(traffic.current);
    for (const [dimension, first, last] of [
      [traffic.pages, '/', '/contact'], [traffic.browsers, 'Chrome', 'Edge'], [traffic.devices, 'desktop', 'tablet'],
    ] as const)
      expect(dimension.find((row) => row.label === first)!.visits).toBeGreaterThan(dimension.find((row) => row.label === last)!.visits);
    const selected = await demo.repository.aggregateTraffic(project.id, { ...filters, providers: ['openai'], countries: ['IL'] });
    expect(selected.providers.map((item) => item.provider)).toEqual(['openai']);
    expect(selected.locations).toEqual([{ label: 'IL', visits: selected.current }]);
    expect(selected.countries).toEqual(['GB', 'IL', 'US']);
    const hourly = await demo.repository.aggregateTraffic(project.id,
      trafficFilters('2026-10-22T12:37:00.000Z', '2026-10-23T12:36:59.999Z', 'hourly'));
    expect(hourly.current).toBeGreaterThan(0);
    expect(hourly.series.reduce((sum, item) => sum + Object.values(item.values).reduce((total, visits) => total + visits, 0), 0)).toBe(hourly.current);
    expect((await demo.repository.trafficStatus(project.id)).sites[0].trackerVersion).toBe('citevia-v1');
  });

  it('preserves source traffic category ordering across small hourly country and provider counts', async () => {
    const { project, base, demo } = await setup();
    const pages = Array.from({ length: 12 }, (_, index) => `/source-page-${index + 1}/`);
    await base.repository.saveProject({ ...project, version: 2, demo: { ...project.demo!, traffic: {
      countries: ['US', 'CA', 'GB', 'AU', 'IL', 'DE', 'FR', 'BR', 'NL', 'IT', 'ES', 'MX'],
      pages, browsers: ['Chrome', 'Safari', 'Firefox', 'Other'], devices: ['desktop', 'mobile'],
    } } }, 1);
    const traffic = await demo.repository.aggregateTraffic(project.id,
      trafficFilters('2026-04-23T00:00:00.000Z', '2026-10-22T23:59:59.999Z'));
    for (const [dimension, first, last] of [
      [traffic.pages, pages[0], pages.at(-1)!], [traffic.browsers, 'Chrome', 'Other'], [traffic.devices, 'desktop', 'mobile'],
    ] as const) {
      expect(dimension.reduce((sum, row) => sum + row.visits, 0)).toBe(traffic.current);
      expect(dimension[0].label).toBe(first);
      expect(dimension.find((row) => row.label === first)!.visits).toBeGreaterThan(dimension.find((row) => row.label === last)!.visits);
    }
  });

  it('passes real accounts through and rejects artifacts and references from another project', async () => {
    const { project, base, demo } = await setup();
    const real = newProject({ id: 'real', prompts: ['Real question?'] });
    await base.repository.saveProject(real, null);
    const getRun = vi.spyOn(base.repository, 'getRun');
    const history = vi.spyOn(base.repository, 'listPromptHistory');
    expect(await demo.repository.getRun(real.id, 'real-run')).toBeNull();
    expect(getRun).toHaveBeenCalledWith(real.id, 'real-run');
    await demo.repository.listPromptHistory(real.id, '2026-01-01', '2026-12-31');
    expect(history).toHaveBeenCalledWith(real.id, '2026-01-01', '2026-12-31', undefined);
    await base.artifacts.put('real/capture', { real: true });
    expect(await demo.artifacts.get('real/capture')).toEqual({ real: true });
    const [run] = await demo.repository.listRuns(project.id);
    const [result] = await demo.repository.listResults(project.id, run.id);
    const forged = result.captureKey!.replace('nayax-demo', 'real');
    expect(await demo.artifacts.get(forged)).toBeNull();
    expect(await demo.repository.getResult(real.id, run.id, result.promptId)).toBeNull();
    expect(await demo.repository.listSavedAnalyses(project.id, [{ responseId: 'forged', captureKey: result.captureKey!, analysisKey: result.analysisKey }])).toEqual([]);
    expect(await demo.repository.listNativeCitations(real.id, [`openai:${result.captureKey}`])).toEqual([]);
  });
});
