import { describe, expect, it } from 'vitest';
import { TRAFFIC_PROVIDERS, type TrafficAggregate, type TrafficFilters } from '@citevia/core';
import { aggregateScenarioTraffic, demoNumericProfile } from '../packages/storage/src/demo-traffic.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';

function source(trafficScale: number) {
  return {
    id: 'account_traffic_scale_demo_v1', name: 'Traffic Scale Fixture', website: 'https://traffic-fixture.com/',
    country: 'US', anchorDate: '2026-10-28', industry: 'Payment services', serviceArea: 'the United States',
    audience: ['Business owners'], services: ['Online payments', 'Point of sale', 'Payment reporting', 'Payment terminals', 'Payment integrations'],
    description: 'A fixture business offering payment services for business owners in the United States.',
    competitors: Array.from({ length: 5 }, (_, index) => ({ name: `Fixture competitor ${index + 1}`, website: `https://traffic-competitor-${index + 1}.com/` })),
    sources: [{ url: 'https://traffic-fixture.com/services/', kind: 'official' },
      { url: 'https://independent-traffic-fixture.com/payments/', kind: 'independent' }],
    blogs: [{ url: 'https://traffic-fixture.com/blog/payments/', title: 'Payment services guide' }],
    profile: { trafficScale, monthlyGrowth: .1 },
    traffic: { countries: ['US', 'GB'], pages: ['/', '/services/', '/contact/'], devices: ['desktop', 'mobile'], browsers: ['Chrome', 'Safari'] },
  };
}
function range(start: string, end: string): TrafficFilters {
  return {
    period: { start, end, granularity: 'daily', timezone: 'UTC' },
    previous: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z', granularity: 'daily', timezone: 'UTC' },
    providers: [], countries: [],
  };
}
const anchorMonth = () => range('2026-09-29T00:00:00.000Z', '2026-10-28T23:59:59.999Z');
function reconcile(traffic: TrafficAggregate) {
  expect(traffic.providers.reduce((sum, provider) => sum + provider.visits, 0)).toBe(traffic.current);
  expect(traffic.providers.reduce((sum, provider) => sum + provider.previous, 0)).toBe(traffic.previous);
  expect(traffic.series.reduce((sum, point) => sum + Object.values(point.values).reduce((n, visits) => n + visits, 0), 0)).toBe(traffic.current);
  for (const rows of [traffic.sources, traffic.pages, traffic.locations, traffic.browsers, traffic.devices])
    expect(rows.reduce((sum, row) => sum + row.visits, 0)).toBe(traffic.current);
}

describe('company-size scenario traffic scales', () => {
  it.each([[10, 21_740], [.6, 1304.4]] as const)('supports a legacy scale of %s near %s total visits in its reference window', (scale, expected) => {
    const project = buildServiceDemo(source(scale), '2026-10-28T12:00:00.000Z');
    const traffic = aggregateScenarioTraffic(project, anchorMonth());
    expect(project.demo!.profile!.trafficScale).toBe(scale);
    expect(Math.abs(traffic.current - expected)).toBeLessThanOrEqual(6);
    expect(traffic.providers[0].visits).toBeGreaterThan(traffic.current * .75);
    expect(new Set(traffic.providers.map(provider => provider.visits)).size).toBe(TRAFFIC_PROVIDERS.length);
    expect(traffic.providers.every(provider => provider.visits > 0)).toBe(true);
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    expect(project.prompts).toHaveLength(50);
    expect(project.demo!.trackedUrls).toHaveLength(1);
    expect(project.demo!.trackedUrls!.every(post => [1, 3, 5].includes(new Date(post.publishedAt).getUTCDay()))).toBe(true);
    reconcile(traffic);
  });

  it.each([.009, 0, 10.01, NaN, Infinity])('rejects invalid traffic scale %s at creation and at runtime', scale => {
    expect(() => buildServiceDemo(source(scale))).toThrow();
    const project = buildServiceDemo(source(1));
    project.demo!.profile!.trafficScale = scale;
    expect(() => aggregateScenarioTraffic(project, anchorMonth())).toThrow('Invalid demo numeric profile: trafficScale');
  });

  it.each([0, -1, .5, 100001, NaN, Infinity])('rejects invalid explicit monthly volume %s at creation and runtime', monthlyVisits => {
    const input = { ...source(1), traffic: { ...source(1).traffic, monthlyVisits } };
    expect(() => buildServiceDemo(input)).toThrow();
    const project = buildServiceDemo(source(1));
    project.demo!.traffic = { ...project.demo!.traffic, monthlyVisits };
    expect(() => aggregateScenarioTraffic(project, anchorMonth())).toThrow('monthly traffic volume');
  });

  it.each([-.001, .251, NaN, Infinity])('rejects invalid traffic-only monthly growth %s at creation and runtime', monthlyGrowth => {
    const input = { ...source(1), traffic: { ...source(1).traffic, monthlyVisits: 550, monthlyGrowth } };
    expect(() => buildServiceDemo(input)).toThrow();
    const project = buildServiceDemo(source(1));
    project.demo!.traffic = { ...project.demo!.traffic, monthlyGrowth };
    expect(() => aggregateScenarioTraffic(project, anchorMonth())).toThrow('monthly traffic growth');
  });

  it('retains the .01 lower bound and original default profile', () => {
    const project = buildServiceDemo(source(.01));
    expect(demoNumericProfile(project.demo!).trafficScale).toBe(.01);
    delete project.demo!.profile;
    expect(demoNumericProfile(project.demo!)).toEqual({ visibilityAdjustment: 0, growthCurve: 1, trafficScale: 1, monthlyGrowth: .1 });
    expect(Math.abs(aggregateScenarioTraffic(project, anchorMonth()).current - 2174)).toBeLessThanOrEqual(6);
  });

  it('reconciles a large full-year scenario across date subdivisions, providers and countries without mutating its configuration', () => {
    const project = buildServiceDemo(source(10)), before = JSON.stringify(project);
    const fullYear = range('2026-04-28T00:00:00.000Z', '2027-04-28T23:59:59.999Z');
    const traffic = aggregateScenarioTraffic(project, fullYear);
    expect(traffic.current).toBeGreaterThan(250_000);
    reconcile(traffic);
    const halves = [range(fullYear.period.start, '2026-10-27T23:59:59.999Z'), range('2026-10-28T00:00:00.000Z', fullYear.period.end)];
    expect(halves.reduce((sum, filters) => sum + aggregateScenarioTraffic(project, filters).current, 0)).toBe(traffic.current);
    const byProvider = TRAFFIC_PROVIDERS.map(provider => aggregateScenarioTraffic(project, { ...fullYear, providers: [provider] }));
    expect(byProvider.reduce((sum, report) => sum + report.current, 0)).toBe(traffic.current);
    const byCountry = ['US', 'GB'].map(country => aggregateScenarioTraffic(project, { ...fullYear, countries: [country] }));
    expect(byCountry.reduce((sum, report) => sum + report.current, 0)).toBe(traffic.current);
    expect(byCountry.reduce((sum, report) => sum + report.previous, 0)).toBe(traffic.previous);
    for (const report of [...byProvider, ...byCountry]) reconcile(report);
    expect(JSON.stringify(project)).toBe(before);
  });
});
