import { describe, expect, it } from 'vitest';
import { TRAFFIC_PROVIDERS, type DemoConfig, type Project, type TrafficDashboard, type TrafficFilters } from '@citevia/core';
import { aggregateScenarioTraffic } from '../../../packages/storage/src/demo-traffic';
import { monitoringPeriod } from '../../api/src/monitoring';
import budgets from '../../../scripts/scenario-traffic-budgets.json';
import { trafficChartSeries } from './traffic-trend';

const config = (monthlyVisits = 545, monthlyGrowth = .008): DemoConfig => ({
  version: 1, source: 'website-demo', sourceAccountId: 'website:example.com', sourceCopiedAt: '2026-11-11T00:00:00.000Z',
  startDate: '2026-05-05', anchorDate: '2026-11-05', endDate: '2027-05-05',
  traffic: { monthlyVisits, monthlyGrowth, countries: ['US', 'GB'] },
});
function selection(days: string, time = '12:00:00.000', custom?: { start: string; end: string }): TrafficFilters {
  const period = monitoringPeriod(new URLSearchParams({ days, ...custom }), new Date(`2026-11-11T${time}Z`));
  const duration = Date.parse(period.end) - Date.parse(period.start) + 1;
  return { period, previous: { ...period, start: new Date(Date.parse(period.start) - duration).toISOString(),
    end: new Date(Date.parse(period.start) - 1).toISOString() }, providers: [], countries: [] };
}
function dashboard(demo = config(), filters = selection('90'), id = 'account_dr_roof_demo_v1'): TrafficDashboard {
  return { ...aggregateScenarioTraffic({ id, demo } as Project, filters), period: filters.period, previousPeriod: filters.previous,
    status: { installed: false, hasEvents: false, sites: [], lastReceivedAt: null, testReceived: false } };
}

describe('demo traffic chart trends', () => {
  it.each(budgets)('draws rising lines for $name across presets, custom dates and the full year, including partial days', budget => {
    const demo = config(budget.monthlyVisits, budget.monthlyGrowth);
    for (const time of ['00:00:00.000', '12:00:00.000', '23:59:59.999']) {
      const ranges = ['1', '7', '14', '30', '90'].map(days => selection(days, time));
      ranges.push(selection('custom', time, { start: '2026-08-14', end: '2026-11-11' }),
        selection('custom', time, { start: demo.startDate, end: demo.endDate }));
      for (const filters of ranges) {
        const report = dashboard(demo, filters, budget.id), snapshot = structuredClone(report);
        const series = trafficChartSeries(report, demo);
        expect(series.map(point => point.date)).toEqual(report.series.map(point => point.date));
        for (const { provider, visits } of report.providers) {
          const values = series.map(point => point.values[provider] || 0);
          expect(values.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
          expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(visits, 8);
          if (visits && values.length > 1) {
            expect(values.every((value, index) => !index || value > values[index - 1])).toBe(true);
            expect((values.at(-1)! / values[0] - 1) * 100).toBeCloseTo(report.growth!.providers[provider]!, 8);
          }
        }
        expect(report).toEqual(snapshot);
      }
    }
  });

  it('keeps provider and country filters additive without changing the trend percentages', () => {
    const demo = config(), filters = selection('30');
    const full = trafficChartSeries(dashboard(demo, filters), demo);
    for (const provider of TRAFFIC_PROVIDERS) {
      const single = trafficChartSeries(dashboard(demo, { ...filters, providers: [provider] }), demo);
      const regions = ['US', 'GB'].map(country => trafficChartSeries(dashboard(demo,
        { ...filters, providers: [provider], countries: [country] }), demo));
      single.forEach((point, index) => {
        expect(Object.keys(point.values)).toEqual([provider]);
        expect(point.values[provider]).toBe(full[index].values[provider]);
        expect(regions.reduce((sum, series) => sum + (series[index].values[provider] || 0), 0)).toBeCloseTo(point.values[provider]!, 8);
      });
    }
  });

  it('supports older demo configurations without explicit traffic budgets or trend metadata', () => {
    const demo = config();
    delete demo.traffic!.monthlyVisits;
    delete demo.traffic!.monthlyGrowth;
    const report = dashboard(demo), series = trafficChartSeries(report, demo);
    expect(report.growth).toBeUndefined();
    expect(series.at(-1)!.values.openai).toBeGreaterThan(series[0].values.openai!);
    expect(series.reduce((sum, point) => sum + point.values.openai!, 0)).toBeCloseTo(report.providers[0].visits, 8);
  });

  it('leaves measured accounts, reporting-only demos, explicit zero growth and empty ranges untouched', () => {
    const demo = config(), report = dashboard(demo);
    expect(trafficChartSeries(report)).toBe(report.series);
    expect(trafficChartSeries(report, { ...demo, presentation: { label: 'Visibility only', targetRank: 1, mentionCount: 50, reportingOnly: true } })).toBe(report.series);
    expect(trafficChartSeries(report, { ...demo, traffic: { ...demo.traffic, monthlyGrowth: 0 } })).toBe(report.series);
    const empty = dashboard(demo, selection('custom', undefined, { start: '2027-06-01', end: '2027-06-30' }));
    expect(trafficChartSeries(empty, demo)).toBe(empty.series);
    const one = { ...report, series: report.series.slice(0, 1) };
    expect(trafficChartSeries(one, demo)).toBe(one.series);
  });

  it('keeps the chart within the saved scenario when a custom range crosses its boundaries', () => {
    const demo = config(), report = dashboard(demo, selection('custom', undefined, { start: '2026-04-01', end: '2026-05-31' }));
    const series = trafficChartSeries(report, demo);
    expect(series[0].date.slice(0, 10)).toBe(demo.startDate);
    expect(series.at(-1)!.date.slice(0, 10)).toBe('2026-05-31');
    expect(series.reduce((sum, point) => sum + point.values.openai!, 0)).toBeCloseTo(report.providers[0].visits, 8);
  });
});
