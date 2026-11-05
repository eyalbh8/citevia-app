import { describe, expect, it } from 'vitest';
import { TRAFFIC_PROVIDERS, trafficChange, type Project, type TrafficAggregate, type TrafficFilters } from '@citevia/core';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
import { monitoringPeriod } from '../apps/api/src/monitoring.js';
import { newProject } from './fixtures/scanner.js';

const project: Project = {
  ...newProject({ id: 'modest-nayax', brand: 'Nayax', domain: 'nayax.com' }),
  demo: {
    version: 1, source: 'igeo-nayax', anchorDate: '2026-10-23',
    startDate: '2026-04-23', endDate: '2027-04-23',
    sourceAccountId: 'source', sourceCopiedAt: '2026-10-23T00:00:00.000Z',
    traffic: { countries: ['US', 'GB', 'IL'], pages: ['/', '/products/', '/blog/', '/contact/'],
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

describe('growing virtual AI traffic', () => {
  it.each(['merchant_payments', 'residential_roofing', 'unattended_payments', 'home_bedding', 'yacht_chartering', 'hair_restoration',
  'luxury_hospitality', 'immigration_law', 'fertility_care', 'luxury_real_estate', 'dental_care', 'locksmith_services',
  'gutter_protection', 'solar_and_storage', 'replacement_windows'] as const)('reconciles positive %s referral growth over rolling and calendar windows', reportingProfile => {
    const scenario: Project = { ...project, demo: { ...project.demo!, reportingProfile,
      profile: { trafficScale: 8, monthlyGrowth: .09 } } };
    for (const days of [1, 7, 14, 30, 90]) {
      const period = monitoringPeriod(new URLSearchParams({ days: String(days) }), new Date('2026-11-05T15:30:00Z'));
      const start = Date.parse(period.start), duration = Date.parse(period.end) - start + 1;
      const previous = { ...period, start: new Date(start - duration).toISOString(), end: new Date(start - 1).toISOString() };
      const traffic = aggregateScenarioTraffic(scenario, { period, previous, providers: [], countries: [] });
      expect(traffic.providers.every(row => (trafficChange(row.visits, row.previous, 1) ?? 0) > 0)).toBe(true);
      reconcile(traffic);
    }
  });

  it('keeps niche providers visible with a daily baseline without losing reconciliation', () => {
    const niche: Project = { ...project, demo: { ...project.demo!, profile: { trafficScale: .035, monthlyGrowth: .065 } } };
    const traffic = aggregateScenarioTraffic(niche, monthFilters(2026, 9));
    expect(traffic.current).toBeGreaterThanOrEqual(31 * TRAFFIC_PROVIDERS.length);
    expect(traffic.current).toBeLessThan(300);
    expect(traffic.providers.every(provider => provider.visits >= 31)).toBe(true);
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    reconcile(traffic);
    const splits = [filters('2026-10-01T00:00:00.000Z', '2026-10-15T23:59:59.999Z'),
      filters('2026-10-16T00:00:00.000Z', '2026-10-31T23:59:59.999Z')];
    expect(splits.reduce((sum, range) => sum + aggregateScenarioTraffic(niche, range).current, 0)).toBe(traffic.current);
  });

  it('keeps ChatGPT near its anchor reference and other providers at a modest daily baseline', () => {
    const traffic = aggregateScenarioTraffic(project, monthFilters(2026, 9));
    expect(Math.abs(traffic.providers[0].visits - 2000)).toBeLessThan(31);
    for (const provider of traffic.providers.slice(1)) {
      expect(provider.visits).toBeGreaterThanOrEqual(31);
      expect(provider.visits).toBeLessThan(100);
    }
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    reconcile(traffic);
  });

  it('keeps equal-length windows and every daily provider series nondecreasing across month boundaries', () => {
    let previous: TrafficAggregate | undefined;
    for (let month = 4; month <= 14; month++) {
      const traffic = aggregateScenarioTraffic(project, filters(new Date(Date.UTC(2026, month, 1)).toISOString(), new Date(Date.UTC(2026, month, 29) - 1).toISOString()));
      if (previous) for (let provider = 0; provider < TRAFFIC_PROVIDERS.length; provider++)
        expect(traffic.providers[provider].visits).toBeGreaterThanOrEqual(previous.providers[provider].visits);
      previous = traffic;
      reconcile(traffic);
    }
    const year = aggregateScenarioTraffic(project, filters(`${project.demo!.startDate}T00:00:00.000Z`, `${project.demo!.endDate}T23:59:59.999Z`));
    for (let index = 1; index < year.series.length; index++) for (const provider of TRAFFIC_PROVIDERS)
      expect(year.series[index].values[provider] || 0).toBeGreaterThanOrEqual(year.series[index - 1].values[provider] || 0);
  });

  it.each([.035, 1, 10])('never declines for presets and country slices at scale %s, including partial-day comparisons', scale => {
    const saved: Project = { ...project, demo: { ...project.demo!, profile: { trafficScale: scale, monthlyGrowth: .055 } } };
    for (const date of ['2026-11-04', '2027-03-01']) for (const time of ['00:00:00.000', '11:59:59.999', '12:00:00.000', '17:23:45.678', '23:59:59.999']) {
      for (const days of ['1', '7', '14', '30', '90']) {
        const period = monitoringPeriod(new URLSearchParams({ days }), new Date(`${date}T${time}Z`));
        const duration = Date.parse(period.end) - Date.parse(period.start) + 1;
        const previous = { ...period, start: new Date(Date.parse(period.start) - duration).toISOString(), end: new Date(Date.parse(period.start) - 1).toISOString() };
        for (const countries of [[], ['US'], ['GB'], ['IL']]) {
          const traffic = aggregateScenarioTraffic(saved, { period, previous, countries, providers: [] });
          expect(traffic.current).toBeGreaterThanOrEqual(traffic.previous);
          expect(traffic.providers.every(provider => provider.visits >= provider.previous)).toBe(true);
          reconcile(traffic);
        }
      }
    }
  });

  it('spreads even the lowest volume provider throughout the month and preserves source dimension weighting', () => {
    const traffic = aggregateScenarioTraffic(project, monthFilters(2026, 9));
    const deepseekDays = traffic.series.filter((point) => (point.values.deepseek || 0) > 0);
    expect(deepseekDays.length).toBeGreaterThanOrEqual(15);
    expect(Date.parse(deepseekDays[0].date)).toBeLessThan(Date.parse('2026-10-04T00:00:00.000Z'));
    expect(Date.parse(deepseekDays.at(-1)!.date)).toBeGreaterThan(Date.parse('2026-10-27T00:00:00.000Z'));
    expect(traffic.pages[0].label).toBe('/');
    expect(traffic.browsers[0].label).toBe('Chrome');
    expect(traffic.devices[0].label).toBe('desktop');
    expect(traffic.locations[0].label).toBe('US');
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
