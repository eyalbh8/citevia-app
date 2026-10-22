import { describe, expect, it } from 'vitest';
import { TRAFFIC_PROVIDERS, type Project, type TrafficAggregate, type TrafficFilters } from '@citevia/core';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
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

describe('modest virtual AI traffic', () => {
  it('sets ChatGPT to 2,000 and each other provider to a few dozen in the anchor month', () => {
    const traffic = aggregateScenarioTraffic(project, monthFilters(2026, 9));
    expect(traffic.providers.map((item) => [item.provider, item.visits])).toEqual([
      ['openai', 2000], ['claude', 36], ['perplexity', 54], ['gemini', 42], ['copilot', 24], ['deepseek', 18],
    ]);
    expect(traffic.current).toBe(2174);
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    reconcile(traffic);
  });

  it('grows calendar month targets by nominal 10%, independent of 28, 30 or 31 day month length', () => {
    const bases = [2000, 36, 54, 42, 24, 18];
    let previous: TrafficAggregate | undefined;
    for (let month = 4; month <= 14; month++) {
      const traffic = aggregateScenarioTraffic(project, monthFilters(2026, month));
      expect(traffic.providers.map((item) => item.visits)).toEqual(bases.map((base) => Math.round(base * 1.1 ** (month - 9))));
      if (previous) for (let provider = 0; provider < bases.length; provider++)
        expect(traffic.providers[provider].visits).toBeGreaterThan(previous.providers[provider].visits);
      previous = traffic;
      reconcile(traffic);
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
