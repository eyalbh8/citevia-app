import { describe, expect, it } from 'vitest';
import { TRAFFIC_PROVIDERS, aggregateTraffic, type Project, type TrafficAggregate, type TrafficFilters, type TrafficEvent } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
import { monitoringPeriod } from '../apps/api/src/monitoring.js';
import { newProject } from './fixtures/scanner.js';

const project: Project = {
  ...newProject({ id: 'modest-nayax', brand: 'Nayax', domain: 'nayax.com' }),
  demo: {
    version: 1, source: 'igeo-nayax', anchorDate: '2026-10-23',
    startDate: '2026-04-23', endDate: '2027-04-23',
    sourceAccountId: 'source', sourceCopiedAt: '2026-10-23T00:00:00.000Z',
    traffic: { monthlyVisits: 2500, countries: ['US', 'GB', 'IL'], pages: ['/', '/products/', '/blog/', '/contact/'],
      browsers: ['Chrome', 'Safari', 'Edge', 'Firefox'], devices: ['desktop', 'mobile', 'tablet'] },
  },
};
function filters(start: string, end: string, granularity: 'hourly' | 'daily' = 'daily'): TrafficFilters {
  return {
    period: { start, end, granularity, timezone: 'UTC' },
    previous: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z', granularity, timezone: 'UTC' },
    providers: [], countries: [],
  };
}
function monthFilters(year: number, month: number) {
  return filters(new Date(Date.UTC(year, month, 1)).toISOString(), new Date(Date.UTC(year, month + 1, 1) - 1).toISOString());
}
function reconcile(traffic: TrafficAggregate) {
  expect(traffic.providers.reduce((sum, item) => sum + item.visits, 0)).toBe(traffic.current);
  expect(traffic.providers.reduce((sum, item) => sum + item.previous, 0)).toBe(traffic.previous);
  expect(traffic.series.reduce((sum, point) => sum + Object.values(point.values).reduce((n, visits) => n + visits, 0), 0)).toBe(traffic.current);
  for (const dimension of [traffic.sources, traffic.pages, traffic.locations, traffic.browsers, traffic.devices])
    expect(dimension.reduce((sum, item) => sum + item.visits, 0)).toBe(traffic.current);
}

describe('volume-scaled AI traffic', () => {
  const localBusinesses = [
    { name: 'Dr. Roof', id: 'account_dr_roof_demo_v1', domain: 'drroof.com', monthlyVisits: 545 },
    { name: 'WindowWorks', id: 'account_windowworks_demo_v1', domain: 'mywindowworks.com', monthlyVisits: 550 },
    { name: 'All American Gutter Protection', id: 'account_all_american_gutter_demo_v1', domain: 'allamericangutterprotection.com', monthlyVisits: 560 },
    { name: 'ACME Locksmith', id: 'account_acme_locksmith_demo_v1', domain: 'acmelocksmith.com', monthlyVisits: 535 },
    { name: 'Tend Dental', id: 'account_tend_nyc_demo_v1', domain: 'hellotend.com', monthlyVisits: 555 },
  ];
  const anchorRange = filters('2026-09-24T00:00:00.000Z', '2026-10-23T23:59:59.999Z');

  it.each(localBusinesses)('keeps $name near its monthly budget with ChatGPT dominant and different provider volumes', ({ id, name, domain, monthlyVisits }) => {
    const saved: Project = { ...project, ...newProject({ id, name, brand: name, domain }), demo: {
      ...project.demo!, traffic: { ...project.demo!.traffic!, monthlyVisits, monthlyGrowth: .008 },
    } };
    const report = aggregateScenarioTraffic(saved, anchorRange);
    expect(Math.abs(report.current - monthlyVisits)).toBeLessThanOrEqual(6);
    expect(report.current).toBeGreaterThanOrEqual(400);
    expect(report.current).toBeLessThanOrEqual(600);
    const chatgpt = report.providers.find(row => row.provider === 'openai')!;
    expect(chatgpt.visits).toBeGreaterThanOrEqual(400);
    expect(chatgpt.visits).toBeGreaterThan(3 * Math.max(...report.providers.filter(row => row !== chatgpt).map(row => row.visits)));
    expect(new Set(report.providers.map(row => row.visits)).size).toBe(TRAFFIC_PROVIDERS.length);
    expect(report.providers.every(row => row.visits > 0)).toBe(true);
    reconcile(report);
    for (const days of [7, 14, 30, 90]) {
      const range = filters(new Date(Date.parse(anchorRange.period.end) + 1 - days * 86400000).toISOString(), anchorRange.period.end);
      const window = aggregateScenarioTraffic(saved, range);
      expect(window.providers[0].visits).toBeGreaterThan(Math.max(...window.providers.slice(1).map(row => row.visits)));
      expect(new Set(window.providers.map(row => row.visits)).size).toBe(TRAFFIC_PROVIDERS.length);
      reconcile(window);
    }
  });

  it.each(['merchant_payments', 'residential_roofing', 'unattended_payments', 'home_bedding', 'yacht_chartering', 'hair_restoration',
    'luxury_hospitality', 'immigration_law', 'fertility_care', 'luxury_real_estate', 'dental_care', 'locksmith_services',
    'gutter_protection', 'solar_and_storage', 'replacement_windows'] as const)('uses the saved %s traffic budget without growth proportional to the age of the account', reportingProfile => {
    const scenario: Project = { ...project, demo: { ...project.demo!, reportingProfile,
      profile: { trafficScale: 8, monthlyGrowth: .09 }, traffic: { ...project.demo!.traffic!, monthlyVisits: 550 } } };
    const report = aggregateScenarioTraffic(scenario, anchorRange);
    expect(Math.abs(report.current - 550)).toBeLessThanOrEqual(6);
    const longerHistory = structuredClone(scenario);
    longerHistory.demo!.startDate = '2025-04-23';
    expect(aggregateScenarioTraffic(longerHistory, anchorRange)).toEqual(report);
    reconcile(report);
  });

  it('keeps a local business near 400–600 total visits with ChatGPT above 400 throughout the reporting year', () => {
    const scenario: Project = { ...project, demo: { ...project.demo!,
      traffic: { ...project.demo!.traffic!, monthlyVisits: 550, monthlyGrowth: .008 } } };
    for (let month = 5; month <= 15; month++) {
      const end = new Date(Date.UTC(2026, month, 15));
      const range = filters(new Date(end.getTime() - 30 * 86400000).toISOString(), new Date(end.getTime() - 1).toISOString());
      const report = aggregateScenarioTraffic(scenario, range);
      expect(report.current).toBeGreaterThanOrEqual(400);
      expect(report.current).toBeLessThanOrEqual(600);
      expect(report.providers[0].visits).toBeGreaterThanOrEqual(400);
      reconcile(report);
    }
  });

  it('uses traffic-only growth without changing the saved visibility settings', () => {
    const scenario: Project = { ...project, demo: { ...project.demo!, profile: { monthlyGrowth: .2 },
      traffic: { ...project.demo!.traffic!, monthlyVisits: 550, monthlyGrowth: 0 } } };
    const snapshot = JSON.stringify(scenario);
    for (const month of [5, 8, 11, 14]) {
      const end = new Date(Date.UTC(2026, month, 15));
      const range = filters(new Date(end.getTime() - 30 * 86400000).toISOString(), new Date(end.getTime() - 1).toISOString());
      expect(Math.abs(aggregateScenarioTraffic(scenario, range).current - 550)).toBeLessThanOrEqual(6);
    }
    expect(JSON.stringify(scenario)).toBe(snapshot);
  });

  it('allows sparse providers to have zero days without adding a daily visit floor', () => {
    const niche: Project = { ...project, demo: { ...project.demo!, profile: { trafficScale: .035, monthlyGrowth: .065 },
      traffic: { ...project.demo!.traffic!, monthlyVisits: 80 } } };
    const report = aggregateScenarioTraffic(niche, anchorRange);
    expect(Math.abs(report.current - 80)).toBeLessThanOrEqual(6);
    expect(report.providers[0].visits).toBeGreaterThan(report.current * .7);
    expect(report.series.some(row => !row.values.deepseek)).toBe(true);
    expect(report.providers.find(row => row.provider === 'deepseek')!.visits).toBeLessThan(10);
    reconcile(report);
    const splits = [filters(anchorRange.period.start, '2026-10-05T23:59:59.999Z'),
      filters('2026-10-06T00:00:00.000Z', anchorRange.period.end)];
    expect(splits.reduce((sum, range) => sum + aggregateScenarioTraffic(niche, range).current, 0)).toBe(report.current);
  });

  it('grows comparable monthly windows and keeps each provider distinct across month boundaries', () => {
    let previous: TrafficAggregate | undefined;
    for (let month = 4; month <= 14; month++) {
      const report = aggregateScenarioTraffic(project, filters(new Date(Date.UTC(2026, month, 1)).toISOString(), new Date(Date.UTC(2026, month, 29) - 1).toISOString()));
      if (previous) expect(report.current).toBeGreaterThan(previous.current);
      expect(report.providers[0].visits).toBeGreaterThan(Math.max(...report.providers.slice(1).map(row => row.visits)));
      expect(new Set(report.providers.map(row => row.visits)).size).toBe(TRAFFIC_PROVIDERS.length);
      previous = report;
      reconcile(report);
    }
  });

  it.each([80, 550, 20000])('reconciles present and previous visits independently at monthly volume %s, including small country slices', monthlyVisits => {
    const saved: Project = { ...project, demo: { ...project.demo!, traffic: { ...project.demo!.traffic!, monthlyVisits, monthlyGrowth: .008 }, profile: { monthlyGrowth: .055 } } };
    for (const date of ['2026-11-04', '2027-03-01']) for (const time of ['00:00:00.000', '12:00:00.000', '17:23:45.678']) {
      for (const days of ['1', '7', '30', '90']) {
        const period = monitoringPeriod(new URLSearchParams({ days }), new Date(`${date}T${time}Z`));
        const duration = Date.parse(period.end) - Date.parse(period.start) + 1;
        const previous = { ...period, start: new Date(Date.parse(period.start) - duration).toISOString(), end: new Date(Date.parse(period.start) - 1).toISOString() };
        const queries = { period, previous, countries: [] as string[], providers: [] };
        const whole = aggregateScenarioTraffic(saved, queries);
        const parts = [[], ['US'], ['GB'], ['IL']].map(countries => {
          const traffic = aggregateScenarioTraffic(saved, { ...queries, countries });
          const previousReport = aggregateScenarioTraffic(saved, { ...queries, period: previous, countries });
          expect(traffic.previous).toBe(previousReport.current);
          traffic.providers.forEach((row, i) => expect(row.previous).toBe(previousReport.providers[i].visits));
          reconcile(traffic);
          return traffic;
        });
        expect(parts.slice(1).reduce((sum, part) => sum + part.current, 0)).toBe(whole.current);
        expect(parts.slice(1).reduce((sum, part) => sum + part.previous, 0)).toBe(whole.previous);
      }
    }
  });

  it('preserves saved source dimension priorities and shows visits throughout the month', () => {
    const traffic = aggregateScenarioTraffic(project, monthFilters(2026, 9));
    const days = traffic.series.filter(point => (point.values.openai || 0) > 0);
    expect(days).toHaveLength(31);
    expect(traffic.pages[0].label).toBe('/');
    expect(traffic.browsers[0].label).toBe('Chrome');
    expect(traffic.devices[0].label).toBe('desktop');
    expect(traffic.locations[0].label).toBe('US');
    reconcile(traffic);
  });

  it('adds the scenario to observed visits without changing the observed aggregate', () => {
    const range = filters('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z');
    const event: TrafficEvent = { id: 'real-visit', projectId: project.id, timestamp: '2026-10-10T14:07:08.123Z',
      provider: 'claude', url: 'https://nayax.com/observed-only', path: '/observed-only', referrer: 'https://claude.ai/',
      browser: 'Observed Browser', device: 'desktop', country: 'CA', userAgent: 'Observed Browser', testId: null };
    const observed = aggregateTraffic([event, { ...event, id: 'previous-real-visit', timestamp: '2026-09-10T14:07:08.123Z' }], range);
    const before = structuredClone(observed), model = aggregateScenarioTraffic(project, range);
    const combined = aggregateScenarioTraffic(project, range, observed);
    expect(observed).toEqual(before);
    expect(combined.current).toBe(model.current + 1);
    expect(combined.previous).toBe(model.previous + 1);
    expect(combined.pages.find(row => row.label === '/observed-only')?.visits).toBe(1);
    expect(combined.browsers.find(row => row.label === 'Observed Browser')?.visits).toBe(1);
    expect(combined.locations.find(row => row.label === 'CA')?.visits).toBe(1);
    reconcile(combined);
  });

  it('reconciles partial hours and country/provider filters against the same underlying visits', () => {
    const range = filters('2026-10-22T12:37:00.000Z', '2026-10-23T12:36:59.999Z', 'hourly');
    const total = aggregateScenarioTraffic(project, range);
    expect(total.current).toBeGreaterThan(0);
    reconcile(total);
    const splits = [
      filters(range.period.start, '2026-10-22T23:59:59.999Z', 'hourly'),
      filters('2026-10-23T00:00:00.000Z', range.period.end, 'hourly'),
    ].map((query) => aggregateScenarioTraffic(project, query));
    expect(splits.reduce((sum, item) => sum + item.current, 0)).toBe(total.current);
    const byCountry = ['US', 'GB', 'IL'].map((country) => aggregateScenarioTraffic(project, { ...range, countries: [country] }));
    expect(byCountry.reduce((sum, item) => sum + item.current, 0)).toBe(total.current);
    expect(byCountry.reduce((sum, item) => sum + item.previous, 0)).toBe(total.previous);
    for (let index = 0; index < byCountry.length; index++) {
      reconcile(byCountry[index]);
      expect(byCountry[index].countries).toEqual(total.countries);
      expect(byCountry[index].locations.every((row) => row.label === ['US', 'GB', 'IL'][index])).toBe(true);
    }
    const byProvider = TRAFFIC_PROVIDERS.map((provider) => aggregateScenarioTraffic(project, { ...range, providers: [provider] }));
    expect(byProvider.reduce((sum, item) => sum + item.current, 0)).toBe(total.current);
    for (const traffic of byProvider) reconcile(traffic);
  });

  it('leaves an ordinary account’s collected visits unchanged', async () => {
    const ordinary = newProject({ id: 'live-account', brand: 'Live business', domain: 'live.example' });
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    await repository.saveProject(ordinary, null);
    const event: TrafficEvent = { id: 'live-event', projectId: ordinary.id, timestamp: '2026-10-10T14:07:08.123Z',
      provider: 'claude', url: 'https://live.example/pricing', path: '/pricing', referrer: 'https://claude.ai/',
      browser: 'Safari', device: 'mobile', country: 'GB', userAgent: 'Safari', testId: null };
    await repository.collectTrafficEvent(event);
    const query = filters('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z');
    const observed = await repository.aggregateTraffic(ordinary.id, query);
    const runtime = withDemoRuntime({ repository, artifacts, queue }, () => new Date('2026-10-23T12:00:00Z'));
    expect(await runtime.repository.aggregateTraffic(ordinary.id, query)).toEqual(observed);
    expect(observed.current).toBe(1);
    expect(observed.providers.find(row => row.provider === 'openai')?.visits).toBe(0);
    expect(observed.providers.find(row => row.provider === 'claude')?.visits).toBe(1);
    expect(queue.messages).toHaveLength(0);
    expect(artifacts.values.size).toBe(0);
  });

  it('clips precisely to scenario dates, remains deterministic and mutates no project data', () => {
    const snapshot = JSON.stringify(project);
    const before = aggregateScenarioTraffic(project, filters('2026-04-01T00:00:00.000Z', '2026-04-22T23:59:59.999Z'));
    const after = aggregateScenarioTraffic(project, filters('2027-04-24T00:00:00.000Z', '2027-04-30T23:59:59.999Z'));
    expect(before.current).toBe(0);
    expect(after.current).toBe(0);
    expect(before.countries).toEqual([]);
    expect(after.countries).toEqual([]);
    const range = filters('2026-04-23T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    const first = aggregateScenarioTraffic(project, range);
    expect(aggregateScenarioTraffic(structuredClone(project), range)).toEqual(first);
    expect(JSON.stringify(project)).toBe(snapshot);
    reconcile(first);
  });
});
