import type { DemoConfig, TrafficDashboard } from '@citevia/core';

const DAY = 86_400_000;
const MIN_DEMO_TREND_RATIO = 2.5;

/** Demo charts show the configured trend; the report retains its integer visit counts. */
export function trafficChartSeries(report: TrafficDashboard, demo?: DemoConfig): TrafficDashboard['series'] {
  if (!demo || demo.presentation?.reportingOnly || !report.current) return report.series;
  const monthlyGrowth = demo.traffic?.monthlyGrowth ?? demo.profile?.monthlyGrowth ?? .1;
  if (!Number.isFinite(monthlyGrowth) || monthlyGrowth <= 0) return report.series;
  const start = Date.parse(`${demo.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${demo.endDate}T00:00:00.000Z`) + DAY;
  const points = report.series.filter(point => Date.parse(point.date) >= start && Date.parse(point.date) < end);
  if (points.length < 2) return report.series;

  const days = Math.max(1, (Date.parse(report.period.end) - Date.parse(report.period.start) + 1) / DAY);
  const fallback = Math.expm1(Math.log1p(monthlyGrowth) * days / (365.25 / 12)) * 100;
  const series: TrafficDashboard['series'] = points.map(point => ({ date: point.date, values: {} }));
  for (const { provider, visits } of report.providers) {
    const configured = report.growth?.basis === 'trend' ? report.growth.providers[provider] : undefined;
    const percent = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : fallback;
    // Give demo curves a pronounced rise on the shared, zero-based visit axis.
    // This controls the chart shape, separately from the period-growth badges.
    const growth = Math.log(Math.max(MIN_DEMO_TREND_RATIO, 1 + percent / 100));
    const weights = points.map((_, index) => Math.exp(growth * index / (points.length - 1)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    series.forEach((point, index) => { point.values[provider] = visits * weights[index] / totalWeight; });
  }
  // Normalizing the continuous trend to each provider's total keeps sparse
  // streams from rounding into flat lines or dropping on the current partial day.
  return series;
}
