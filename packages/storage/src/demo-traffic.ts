import {
  TRAFFIC_PROVIDERS,
  trafficBuckets,
  type DemoConfig,
  type Project,
  type TrafficAggregate,
  type TrafficFilters,
  type TrafficProvider,
  type TrafficRow,
} from '@citevia/core';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** October 2026 is the saved scenario's anchor month, not its first month. */
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
    visibilityAdjustment: [-.2, .2], growthCurve: [.5, 2], trafficScale: [.25, 2], monthlyGrowth: [0, .25],
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
const HOURS = [.22, .18, .16, .15, .17, .25, .45, .72, 1.05, 1.35, 1.5, 1.4,
  1.25, 1.35, 1.45, 1.5, 1.4, 1.25, 1.1, 1.05, .9, .75, .55, .35];
const WEEKDAYS = [.76, 1.08, 1.12, 1.1, 1.06, .98, .78];
const fraction = (value: number) => value - Math.floor(value);
const iso = (at: number) => new Date(at).toISOString();
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
 * Derive a modest, consistent referral scenario without storing analytics rows.
 * Each full UTC month follows the saved profile's anchor volume and growth.
 * Weighted quantiles spread those visits over the month, including providers
 * with only a few dozen referrals. Stable timestamps and dimensions mean any
 * subdivision of a date range reconciles with the same range's total.
 */
export function aggregateScenarioTraffic(project: Project, filters: TrafficFilters): TrafficAggregate {
  const config = project.demo;
  if (!config) throw new Error('Scenario traffic requires a scenario project');
  const profile = demoNumericProfile(config);
  const dimensions = config.traffic;
  const countries = clean(dimensions?.countries?.map((country) => country.toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country)), ['US', 'GB', 'DE', 'IL']);
  const pages = clean(dimensions?.pages, ['/', '/solutions/', '/products/', '/contact/']);
  const browsers = clean(dimensions?.browsers, ['Chrome', 'Safari', 'Edge', 'Firefox']);
  const devices = clean(dimensions?.devices, ['desktop', 'mobile', 'tablet']);
  const providers = TRAFFIC_PROVIDERS.filter((provider) => !filters.providers.length || filters.providers.includes(provider));
  const totals = new Map(providers.map((provider) => [provider, { provider, visits: 0, previous: 0 }]));
  const series = trafficBuckets(filters.period).map((date) => ({ date, values: {} as Partial<Record<TrafficProvider, number>> }));
  const seriesIndex = new Map(series.map((point) => [point.date, point.values]));
  const sources = new Map<string, number>(), pageCounts = new Map<string, number>(), locations = new Map<string, number>();
  const browserCounts = new Map<string, number>(), deviceCounts = new Map<string, number>(), availableCountries = new Set<string>();
  const currentStart = Date.parse(filters.period.start), currentEnd = Date.parse(filters.period.end);
  const previousStart = Date.parse(filters.previous.start), previousEnd = Date.parse(filters.previous.end);
  const from = Math.max(day(config.startDate), Math.min(previousStart, currentStart));
  const to = Math.min(day(config.endDate) + DAY - 1, Math.max(previousEnd, currentEnd));
  const step = filters.period.granularity === 'hourly' ? HOUR : DAY;
  const anchor = new Date(day(config.anchorDate));
  const anchorMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
  const first = new Date(from);
  let monthStart = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);

  while (monthStart <= to) {
    const month = new Date(monthStart);
    const nextMonth = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
    const monthNumber = month.getUTCFullYear() * 12 + month.getUTCMonth();
    const cumulative: number[] = [];
    let weight = 0;
    for (let at = monthStart; at < nextMonth; at += HOUR) {
      const date = new Date(at);
      const dailyVariation = .88 + hash(`${project.id}/${iso(at).slice(0, 10)}`) * .24;
      weight += WEEKDAYS[date.getUTCDay()] * dailyVariation * HOURS[date.getUTCHours()];
      cumulative.push(weight);
    }
    for (const provider of providers) {
      const count = Math.round(ANCHOR_VISITS[provider] * profile.trafficScale * (1 + profile.monthlyGrowth) ** (monthNumber - anchorMonth));
      const key = `${project.id}/${monthNumber}/${provider}`;
      const phase = .15 + hash(`${key}/time`) * .7;
      const countrySeed = hash(`${key}/country`), pageSeed = hash(`${key}/page`);
      const browserSeed = hash(`${key}/browser`), deviceSeed = hash(`${key}/device`);
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const position = (ordinal + phase) / count * weight;
        let low = 0, high = cumulative.length - 1;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (cumulative[middle] < position) low = middle + 1;
          else high = middle;
        }
        const priorWeight = low ? cumulative[low - 1] : 0;
        const at = monthStart + low * HOUR + Math.floor((position - priorWeight) / (cumulative[low] - priorWeight) * HOUR);
        if (at < from || at > to) continue;
        const current = at >= currentStart && at <= currentEnd;
        const previous = at >= previousStart && at <= previousEnd;
        const country = dimension(countries, ordinal, countrySeed, .6180339887498949);
        if (current) availableCountries.add(country);
        if (filters.countries.length && !filters.countries.includes(country)) continue;
        const total = totals.get(provider)!;
        if (previous) total.previous++;
        if (!current) continue;
        total.visits++;
        const bucket = seriesIndex.get(iso(Math.floor(at / step) * step));
        if (bucket) bucket[provider] = (bucket[provider] || 0) + 1;
        add(sources, HOSTS[provider]);
        add(locations, country);
        add(pageCounts, dimension(pages, ordinal, pageSeed, .4142135623730951));
        add(browserCounts, dimension(browsers, ordinal, browserSeed, .7320508075688772));
        add(deviceCounts, dimension(devices, ordinal, deviceSeed, .2360679774997897));
      }
    }
    monthStart = nextMonth;
  }
  return {
    current: [...totals.values()].reduce((sum, item) => sum + item.visits, 0),
    previous: [...totals.values()].reduce((sum, item) => sum + item.previous, 0),
    providers: [...totals.values()], series,
    sources: rows(sources), pages: rows(pageCounts), locations: rows(locations),
    devices: rows(deviceCounts), browsers: rows(browserCounts), countries: [...availableCountries].sort(),
  };
}
