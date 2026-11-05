import {
  aggregateTraffic,
  type DemoConfig,
  type Project,
  type TrafficAggregate,
  type TrafficFilters,
  type TrafficProvider,
  type TrafficRow,
} from '@citevia/core';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Reference monthly volumes, converted to daily rates in the anchor month. */
const ANCHOR_VISITS: Record<TrafficProvider, number> = {
  openai: 2_000, claude: 36, perplexity: 54, gemini: 42, copilot: 24, deepseek: 18,
};
const DEFAULT_PROFILE = {
  visibilityAdjustment: 0, growthCurve: 1, trafficScale: 1, monthlyGrowth: .1,
};

/** Bound variations so saved numeric settings cannot create invalid or unbounded scenarios. */
export function demoNumericProfile(config: DemoConfig): Required<NonNullable<DemoConfig['profile']>> {
  const profile = config.profile;
  if (profile !== undefined && (!profile || typeof profile !== 'object' || Array.isArray(profile)))
    throw new Error('Invalid demo numeric profile');
  const bounds = {
    visibilityAdjustment: [-.2, .2], growthCurve: [.5, 2], trafficScale: [.01, 10], monthlyGrowth: [0, .25],
  } as const;
  const result = { ...DEFAULT_PROFILE };
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = profile?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < bounds[key][0] || value > bounds[key][1])
      throw new Error(`Invalid demo numeric profile: ${key}`);
    result[key] = value;
  }
  return result;
}
const HOSTS: Record<TrafficProvider, string> = {
  openai: 'chatgpt.com', claude: 'claude.ai', perplexity: 'perplexity.ai',
  gemini: 'gemini.google.com', copilot: 'copilot.microsoft.com', deepseek: 'deepseek.com',
};
const MONTH_DAYS = 365.25 / 12;
const fraction = (value: number) => value - Math.floor(value);
const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`);

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0) / 4_294_967_296;
}

function clean(values: string[] | undefined, fallback: string[]) {
  const unique = [...new Set(values?.filter(Boolean).slice(0, 12) || fallback)];
  return unique.length ? unique : fallback;
}

/** Ranked source dimensions retain their order without rounding each tiny hourly cell. */
function dimension(labels: string[], ordinal: number, seed: number, stride: number) {
  // Give every saved dimension a stable slot before weighting the extra slots.
  if (ordinal < labels.length) return labels[ordinal];
  let position = fraction(ordinal * stride + seed) * labels.length * (labels.length + 1) / 2;
  for (let index = 0; index < labels.length; index++) {
    position -= labels.length - index;
    if (position < 0) return labels[index];
  }
  return labels[labels.length - 1];
}

function add(counts: Map<string, number>, label: string) {
  counts.set(label, (counts.get(label) || 0) + 1);
}

function rows(counts: Map<string, number>): TrafficRow[] {
  return [...counts].map(([label, visits]) => ({ label, visits }))
    .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));
}

/**
 * Derive a growing referral scenario without storing analytics rows. Daily
 * visits are nested: a later day retains every earlier slot and may add pairs.
 * Every pair has matching dimensions and timestamps mirrored around noon. This
 * keeps country/provider slices nondecreasing even when a preset ends partway
 * through today and its equally long comparison starts partway through a day.
 * A noon visit gives even niche providers a visible, stable daily baseline.
 * The saved anchor volume is a reference rate; integer daily visits, rather
 * than an exact monthly quota, avoid artificial drops at month boundaries.
 * Stable events mean arbitrary subdivisions still reconcile exactly.
 */
export function aggregateScenarioTraffic(project: Project, filters: TrafficFilters, observed = aggregateTraffic([], filters)): TrafficAggregate {
  const config = project.demo;
  if (!config) throw new Error('Scenario traffic requires a scenario project');
  const profile = demoNumericProfile(config);
  const dimensions = config.traffic;
  const countries = clean(dimensions?.countries?.map((country) => country.toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country)), ['US', 'GB', 'DE', 'IL']);
  const pages = clean(dimensions?.pages, ['/', '/solutions/', '/products/', '/contact/']);
  const browsers = clean(dimensions?.browsers, ['Chrome', 'Safari', 'Edge', 'Firefox']);
  const devices = clean(dimensions?.devices, ['desktop', 'mobile', 'tablet']);
  const providers = observed.providers.map(({ provider }) => provider);
  const totals = new Map(observed.providers.map(item => [item.provider, { ...item }]));
  const series = observed.series.map(point => ({ date: point.date, values: { ...point.values } }));
  const seriesIndex = new Map(series.map((point) => [Date.parse(point.date), point.values]));
  const counts = (items: TrafficRow[]) => new Map(items.map(item => [item.label, item.visits]));
  const sources = counts(observed.sources), pageCounts = counts(observed.pages), locations = counts(observed.locations);
  const browserCounts = counts(observed.browsers), deviceCounts = counts(observed.devices);
  const availableCountries = new Set(observed.countries);
  const currentStart = Date.parse(filters.period.start), currentEnd = Date.parse(filters.period.end);
  const previousStart = Date.parse(filters.previous.start), previousEnd = Date.parse(filters.previous.end);
  const scenarioStart = day(config.startDate);
  const from = Math.max(scenarioStart, Math.min(previousStart, currentStart));
  const to = Math.min(day(config.endDate) + DAY - 1, Math.max(previousEnd, currentEnd));
  const step = filters.period.granularity === 'hourly' ? HOUR : DAY;
  const anchor = new Date(day(config.anchorDate));
  const anchorStart = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1);
  const anchorEnd = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1);
  const anchorDays = (anchorEnd - anchorStart) / DAY;
  const anchorMiddle = (anchorStart + anchorEnd) / 2;

  for (const provider of providers) {
    const key = `${project.id}/${provider}`;
    const timeSeed = hash(`${key}/time`), countrySeed = hash(`${key}/country`), pageSeed = hash(`${key}/page`);
    const browserSeed = hash(`${key}/browser`), deviceSeed = hash(`${key}/device`);
    for (let date = Math.floor(from / DAY) * DAY; date <= to; date += DAY) {
      const months = (date + DAY / 2 - anchorMiddle) / (MONTH_DAYS * DAY);
      const rate = ANCHOR_VISITS[provider] * profile.trafficScale / anchorDays * (1 + profile.monthlyGrowth) ** months;
      // The merchant report adds one recurring morning/evening referral pair per provider
      // each day. Even a rolling 24-hour comparison includes a new visit, and the
      // actual events still reconcile across the chart, sources and page breakdowns.
      const recurringPairs = config.reportingProfile === 'merchant_payments' ? (date - scenarioStart) / DAY : 0;
      const pairs = Math.floor(rate / 2) + recurringPairs;
      for (let ordinal = -1; ordinal < pairs; ordinal++) {
        // Inclusive millisecond bounds mirror around DAY - 1. Put the singleton
        // on the earlier center millisecond so a half-day boundary cannot lose it.
        const offset = ordinal < 0 ? DAY / 2 - 1 : 1 + Math.floor(fraction((ordinal + 1) * .6180339887498949 + timeSeed) * (DAY / 2 - 2));
        const country = ordinal < 0 ? countries[0] : dimension(countries, ordinal, countrySeed, .6180339887498949);
        const page = ordinal < 0 ? pages[0] : dimension(pages, ordinal, pageSeed, .4142135623730951);
        const browser = ordinal < 0 ? browsers[0] : dimension(browsers, ordinal, browserSeed, .7320508075688772);
        const device = ordinal < 0 ? devices[0] : dimension(devices, ordinal, deviceSeed, .2360679774997897);
        for (const at of ordinal < 0 ? [date + offset] : [date + offset, date + DAY - 1 - offset]) {
          if (at < from || at > to) continue;
          const current = at >= currentStart && at <= currentEnd;
          const previous = at >= previousStart && at <= previousEnd;
          if (current) availableCountries.add(country);
          if (filters.countries.length && !filters.countries.includes(country)) continue;
          const total = totals.get(provider)!;
          if (previous) total.previous++;
          if (!current) continue;
          total.visits++;
          const bucket = seriesIndex.get(Math.floor(at / step) * step);
          if (bucket) bucket[provider] = (bucket[provider] || 0) + 1;
          add(sources, HOSTS[provider]);
          add(locations, country);
          add(pageCounts, page);
          add(browserCounts, browser);
          add(deviceCounts, device);
        }
      }
    }
  }
  return {
    current: [...totals.values()].reduce((sum, item) => sum + item.visits, 0),
    previous: [...totals.values()].reduce((sum, item) => sum + item.previous, 0),
    providers: [...totals.values()], series,
    sources: rows(sources), pages: rows(pageCounts), locations: rows(locations),
    devices: rows(deviceCounts), browsers: rows(browserCounts), countries: [...availableCountries].sort(),
  };
}
