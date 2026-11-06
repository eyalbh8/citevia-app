import { describe, expect, it } from 'vitest';
import { aggregateTraffic, trafficChange, TRAFFIC_PROVIDERS, type Project, type TrafficAggregate, type TrafficEvent, type TrafficFilters } from '@citevia/core';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
import { monitoringPeriod } from '../apps/api/src/monitoring.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';
import budgets from '../scripts/scenario-traffic-budgets.json';

const now = new Date('2026-11-06T06:00:00.000Z');
function scenario(budget = budgets[0]): Project {
  return buildServiceDemo({
    id: budget.id, name: budget.name, website: `https://${budget.domain}/`, country: 'US',
    anchorDate: '2026-11-05', industry: 'Business services', serviceArea: 'the United States',
    audience: ['Business owners'], services: ['Consultation', 'Planning', 'Installation', 'Maintenance', 'Support'],
    description: 'A fixture business providing consultation, planning and support services in the United States.',
    competitors: Array.from({ length: 5 }, (_, index) => ({ name: `Fixture competitor ${index + 1}`, website: `https://traffic-competitor-${index + 1}.com/` })),
    sources: [{ url: `https://${budget.domain}/services/`, kind: 'official' },
      { url: 'https://independent-traffic-fixture.com/services/', kind: 'independent' }],
    blogs: [{ url: `https://${budget.domain}/blog/services/`, title: 'Services guide' }],
    profile: { trafficScale: budget.monthlyVisits / 2174, monthlyGrowth: budget.monthlyGrowth },
    traffic: { monthlyVisits: budget.monthlyVisits, monthlyGrowth: budget.monthlyGrowth,
      countries: ['US', 'GB'], pages: ['/', '/services/', '/contact/'], devices: ['desktop', 'mobile'], browsers: ['Chrome', 'Safari'] },
  }, now.toISOString());
}
function filters(query: { days: string; start?: string; end?: string }, at = now): TrafficFilters {
  const params = new URLSearchParams({ days: query.days });
  if (query.start) params.set('start', query.start);
  if (query.end) params.set('end', query.end);
  const period = monitoringPeriod(params, at);
  const duration = Date.parse(period.end) - Date.parse(period.start) + 1;
  return {
    period,
    previous: { ...period, start: new Date(Date.parse(period.start) - duration).toISOString(), end: new Date(Date.parse(period.start) - 1).toISOString() },
    providers: [], countries: [],
  };
}
function reconcile(report: TrafficAggregate) {
  expect(report.providers.reduce((sum, row) => sum + row.visits, 0)).toBe(report.current);
  expect(report.providers.reduce((sum, row) => sum + row.previous, 0)).toBe(report.previous);
  expect(report.series.reduce((sum, row) => sum + Object.values(row.values).reduce((n, visits) => n + visits, 0), 0)).toBe(report.current);
  for (const rows of [report.sources, report.pages, report.locations, report.devices, report.browsers])
    expect(rows.reduce((sum, row) => sum + row.visits, 0)).toBe(report.current);
}
function positiveTrend(report: TrafficAggregate, low = 0, high = Infinity) {
  expect(report.growth?.basis).toBe('trend');
  const percentages = [report.growth!.percent, ...Object.values(report.growth!.providers)];
  for (const percent of percentages) {
    expect(Number.isFinite(percent)).toBe(true);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeGreaterThanOrEqual(low);
    expect(percent).toBeLessThanOrEqual(high);
  }
  reconcile(report);
}

describe('configured AI traffic trends', () => {
  it.each(budgets)('keeps $name in every requested growth band without changing its traffic counts', budget => {
    const project = scenario(budget), snapshot = structuredClone(project);
    const legacy = structuredClone(project);
    delete legacy.demo!.traffic!.monthlyVisits;
    for (const [days, low, high] of [[7, 2, 3], [30, 6, 8], [90, 10, 15]]) {
      const selection = filters({ days: String(days) });
      const report = aggregateScenarioTraffic(project, selection);
      positiveTrend(report, low, high);
      expect(Object.keys(report.growth!.providers).sort()).toEqual([...TRAFFIC_PROVIDERS].sort());
      expect(new Set(Object.values(report.growth!.providers)).size).toBe(TRAFFIC_PROVIDERS.length);
      const { growth: _growth, ...counts } = report;
      expect(counts).toEqual(aggregateScenarioTraffic(legacy, selection));
      expect(aggregateScenarioTraffic(project, selection)).toEqual(report);
    }
    expect(project).toEqual(snapshot);
  });

  it.each([7, 30, 90])('retains the %i-day trend at midnight, midday and the end of the day', days => {
    const project = scenario(budgets.find(row => row.name === 'WindowWorks')!);
    const reports = ['00:00:00.000', '12:00:00.000', '23:59:59.999'].map(time =>
      aggregateScenarioTraffic(project, filters({ days: String(days) }, new Date(`2026-11-06T${time}Z`))));
    expect(reports[0].growth).toEqual(reports[1].growth);
    expect(reports[1].growth).toEqual(reports[2].growth);
  });

  it('keeps sparse daily providers positive without adding visits and supports intermediate, custom and annual ranges', () => {
    const project = scenario(budgets.find(row => row.name === 'WindowWorks')!);
    const day = aggregateScenarioTraffic(project, filters({ days: '1' }));
    positiveTrend(day);
    expect(day.providers.some(row => row.visits === 0)).toBe(true);
    expect(day.providers.some(row => row.visits <= row.previous)).toBe(true);
    for (const query of [
      { days: '14' },
      { days: 'custom', start: '2026-09-12', end: '2026-10-26' },
      { days: 'custom', start: '2026-05-05', end: '2027-05-05' },
    ]) positiveTrend(aggregateScenarioTraffic(project, filters(query)));
  });

  it('keeps provider trends stable through provider and region filters while counts remain additive', () => {
    const project = scenario(budgets.find(row => row.name === 'All American Gutter Protection')!);
    const selection = filters({ days: '30' }), full = aggregateScenarioTraffic(project, selection);
    const singles = TRAFFIC_PROVIDERS.map(provider => {
      const single = aggregateScenarioTraffic(project, { ...selection, providers: [provider] });
      positiveTrend(single, 6, 8);
      expect(single.growth!.providers).toEqual({ [provider]: full.growth!.providers[provider] });
      expect(single.growth!.percent).toBe(full.growth!.providers[provider]);
      return single;
    });
    expect(singles.reduce((sum, report) => sum + report.current, 0)).toBe(full.current);
    const regions = ['US', 'GB'].map(country => {
      const region = aggregateScenarioTraffic(project, { ...selection, countries: [country] });
      positiveTrend(region, 6, 8);
      expect(region.growth!.providers).toEqual(full.growth!.providers);
      return region;
    });
    expect(regions.reduce((sum, report) => sum + report.current, 0)).toBe(full.current);
  });

  it('omits trend metadata outside the reporting window or for unsupported regions', () => {
    const project = scenario(), selection = filters({ days: '30' });
    for (const query of [
      { days: 'custom', start: '2026-01-01', end: '2026-01-30' },
      { days: 'custom', start: '2027-06-01', end: '2027-06-30' },
    ]) {
      const report = aggregateScenarioTraffic(project, filters(query));
      expect(report.current).toBe(0);
      expect(report.growth).toBeUndefined();
    }
    const unsupported = aggregateScenarioTraffic(project, { ...selection, countries: ['JP'] });
    expect(unsupported.current).toBe(0);
    expect(unsupported.growth).toBeUndefined();
  });

  it('respects an explicit zero growth configuration and leaves measured aggregates unchanged', () => {
    const project = scenario(), selection = filters({ days: '30' });
    project.demo!.traffic!.monthlyGrowth = 0;
    expect(aggregateScenarioTraffic(project, selection).growth).toBeUndefined();
    expect(aggregateTraffic([], selection).growth).toBeUndefined();
    const event: TrafficEvent = { id: 'current-visit', projectId: 'measured-account', timestamp: selection.period.start,
      provider: 'openai', url: 'https://traffic-fixture.com/', path: '/', referrer: 'https://chatgpt.com/',
      browser: 'Chrome', device: 'desktop', country: 'US', userAgent: 'Chrome', testId: null };
    const measured = aggregateTraffic([event,
      { ...event, id: 'previous-visit-1', timestamp: selection.previous.start },
      { ...event, id: 'previous-visit-2', timestamp: selection.previous.end }], selection);
    expect(measured.growth).toBeUndefined();
    expect(trafficChange(measured.current, measured.previous, 1)).toBe(-50);
    reconcile(measured);
  });
});
