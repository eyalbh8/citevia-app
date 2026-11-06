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
/** Shares of one business budget, rather than a growing baseline per provider. */
const PROVIDER_SHARES: Record<TrafficProvider, number> = {
  openai: .81, claude: .032, perplexity: .08, gemini: .048, copilot: .02, deepseek: .01,
};
const LEGACY_MONTHLY_VISITS = 2_174;
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
  if (ordinal >= 0 && ordinal < labels.length) return labels[ordinal];
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
 * Integrate a business-sized referral rate into stable, integer visits. The
 * budget describes the 30 days ending on the anchor date; the saved monthly
 * growth controls earlier and later dates. Inverting the cumulative rate gives
 * every visit a fixed timestamp and dimension assignment, independent of the
 * requested range or filter. Small providers can have days without a visit;
 * their totals must not be inflated to force a daily increase.
 */
export function aggregateScenarioTraffic(project: Project, filters: TrafficFilters, observed = aggregateTraffic([], filters)): TrafficAggregate {
  const config = project.demo;
  if (!config) throw new Error('Scenario traffic requires a scenario project');
  const profile = demoNumericProfile(config);
  const dimensions = config.traffic;
  const monthlyVisits = dimensions?.monthlyVisits === undefined ? Math.round(LEGACY_MONTHLY_VISITS * profile.trafficScale) : dimensions.monthlyVisits;
  if (typeof monthlyVisits !== 'number' || !Number.isSafeInteger(monthlyVisits) || monthlyVisits < 1 || monthlyVisits > 100_000)
    throw new Error('Invalid scenario monthly traffic volume');
  const monthlyGrowth = dimensions?.monthlyGrowth === undefined ? profile.monthlyGrowth : dimensions.monthlyGrowth;
  if (typeof monthlyGrowth !== 'number' || !Number.isFinite(monthlyGrowth) || monthlyGrowth < 0 || monthlyGrowth > .25)
    throw new Error('Invalid scenario monthly traffic growth');
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
  const anchorEnd = day(config.anchorDate) + DAY;
  const growth = Math.log1p(monthlyGrowth) / MONTH_DAYS;
  // The exponential's integral over the reference 30 days is monthlyVisits.
  const anchorRate = monthlyVisits * (growth ? growth / -Math.expm1(-30 * growth) : 1 / 30);
  // A shared phase keeps nearby low-volume streams ordered at the reference
  // boundary, without rounding or changing any requested window afterwards.
  const timeSeed = hash(`${project.id}/traffic/time`);

  for (const provider of providers) {
    const key = `${project.id}/${provider}`;
    const countrySeed = hash(`${key}/country`), pageSeed = hash(`${key}/page`);
    const browserSeed = hash(`${key}/browser`), deviceSeed = hash(`${key}/device`);
    const rate = anchorRate * PROVIDER_SHARES[provider];
    const cumulative = (at: number) => {
      const elapsed = (at - anchorEnd) / DAY;
      return rate * (growth ? Math.expm1(growth * elapsed) / growth : elapsed);
    };
    // Include one guard event on either side before applying exact millisecond
    // bounds, so rounding the inverse cannot lose a boundary visit.
    const first = Math.floor(cumulative(from) + timeSeed) - 1;
    const last = Math.ceil(cumulative(to + 1) + timeSeed);
    for (let ordinal = first; ordinal <= last; ordinal++) {
      const threshold = ordinal + 1 - timeSeed;
      if (growth && threshold * growth / rate <= -1) continue;
      const elapsed = growth ? Math.log1p(threshold * growth / rate) / growth : threshold / rate;
      const at = Math.floor(anchorEnd + elapsed * DAY);
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
      const bucket = seriesIndex.get(Math.floor(at / step) * step);
      if (bucket) bucket[provider] = (bucket[provider] || 0) + 1;
      add(sources, HOSTS[provider]);
      add(locations, country);
      add(pageCounts, dimension(pages, ordinal, pageSeed, .4142135623730951));
      add(browserCounts, dimension(browsers, ordinal, browserSeed, .7320508075688772));
      add(deviceCounts, dimension(devices, ordinal, deviceSeed, .2360679774997897));
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
