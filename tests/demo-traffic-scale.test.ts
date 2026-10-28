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
const anchorMonth = () => range('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z');
function reconcile(traffic: TrafficAggregate) {
  expect(traffic.providers.reduce((sum, provider) => sum + provider.visits, 0)).toBe(traffic.current);
  expect(traffic.providers.reduce((sum, provider) => sum + provider.previous, 0)).toBe(traffic.previous);
  expect(traffic.series.reduce((sum, point) => sum + Object.values(point.values).reduce((n, visits) => n + visits, 0), 0)).toBe(traffic.current);
  for (const rows of [traffic.sources, traffic.pages, traffic.locations, traffic.browsers, traffic.devices])
    expect(rows.reduce((sum, row) => sum + row.visits, 0)).toBe(traffic.current);
}

describe('company-size scenario traffic scales', () => {
  it.each([[10, 20_000], [.6, 1_200]] as const)('supports a scale of %s with %s ChatGPT visits in the anchor month', (scale, expected) => {
    const project = buildServiceDemo(source(scale), '2026-10-28T12:00:00.000Z');
    const traffic = aggregateScenarioTraffic(project, anchorMonth());
    expect(project.demo!.profile!.trafficScale).toBe(scale);
    expect(traffic.providers.find(provider => provider.provider === 'openai')!.visits).toBe(expected);
    expect(traffic.providers.map(provider => provider.visits)).toEqual([2000, 36, 54, 42, 24, 18].map(count => Math.round(count * scale)));
    expect(traffic.current).toBeGreaterThan(traffic.previous);
    expect(project.prompts).toHaveLength(50);
    expect(project.demo!.trackedUrls).toHaveLength(157);
    expect(project.demo!.trackedUrls!.every(post => [1, 3, 5].includes(new Date(post.publishedAt).getUTCDay()))).toBe(true);
    reconcile(traffic);
  });

  it.each([.009, 0, 10.01, NaN, Infinity])('rejects invalid traffic scale %s at creation and at runtime', scale => {
    expect(() => buildServiceDemo(source(scale))).toThrow();
    const project = buildServiceDemo(source(1));
    project.demo!.profile!.trafficScale = scale;
    expect(() => aggregateScenarioTraffic(project, anchorMonth())).toThrow('Invalid demo numeric profile: trafficScale');
  });

  it('retains the .01 lower bound and original default profile', () => {
    const project = buildServiceDemo(source(.01));
    expect(demoNumericProfile(project.demo!).trafficScale).toBe(.01);
    delete project.demo!.profile;
    expect(demoNumericProfile(project.demo!)).toEqual({ visibilityAdjustment: 0, growthCurve: 1, trafficScale: 1, monthlyGrowth: .1 });
    expect(aggregateScenarioTraffic(project, anchorMonth()).providers.find(provider => provider.provider === 'openai')!.visits).toBe(2000);
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
