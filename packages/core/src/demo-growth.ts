import type { DemoConfig, ScanProvider } from './types.js';

const DAY = 86_400_000;
const promptSeed: Record<NonNullable<DemoConfig['reportingProfile']>, string> = {
  merchant_payments: ':payments', residential_roofing: ':roofing', unattended_payments: ':unattended', uk_investing: '', home_bedding: ':bedding',
  yacht_chartering: ':yachts', hair_restoration: ':hair',
  luxury_hospitality: ':hospitality', immigration_law: ':immigration', fertility_care: ':fertility',
  luxury_real_estate: ':property', dental_care: ':dental', locksmith_services: ':locksmith',
  gutter_protection: ':gutters', solar_and_storage: ':solar', replacement_windows: ':windows',
};
const providerOffset: Record<ScanProvider, number> = { openai: 1, perplexity: .5, gemini: 0 };

export function usesDetailedReporting(
  config: DemoConfig | undefined,
): config is DemoConfig & { reportingProfile: Exclude<NonNullable<DemoConfig['reportingProfile']>, 'uk_investing'> } {
  const profile = config?.reportingProfile;
  return !!profile && profile !== 'uk_investing' && Object.hasOwn(promptSeed, profile);
}

export function usesModeledReporting(
  config: DemoConfig | undefined,
): config is DemoConfig & { reportingProfile: NonNullable<DemoConfig['reportingProfile']> } {
  return config?.reportingProfile === 'uk_investing' || usesDetailedReporting(config);
}

function fraction(value: string) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** The same expected rate drives the simulated answers and the growth reported between two dates. */
export function investingVisibilityRate(demo: DemoConfig, promptId: string, provider: ScanProvider, at: number) {
  const anchor = Date.parse(demo.anchorDate) + DAY;
  const daysBeforeAnchor = (anchor - at) / DAY;
  // Sector-specific seeds disperse sequential prompt IDs across the cohort.
  const strength = fraction(promptId + (demo.reportingProfile ? promptSeed[demo.reportingProfile] : ''));
  const pace = (strength + providerOffset[provider]) / 2;
  const anchorRate = .59 + .17 * strength + .07 * providerOffset[provider];
  if (daysBeforeAnchor <= 0) {
    // As visibility approaches 100%, leave room for a progressively smaller gain.
    return anchorRate + (.97 - anchorRate) * -Math.expm1(daysBeforeAnchor / 130);
  }
  // Relative increases to the anchor, interpolated for custom dates as well as presets.
  const week = .021 + .018 * pace, month = .072 + .026 * pace, quarter = .205 + .09 * pace;
  let increase: number;
  if (daysBeforeAnchor <= 7) increase = week * daysBeforeAnchor / 7;
  else if (daysBeforeAnchor <= 30) increase = week + (month - week) * (daysBeforeAnchor - 7) / 23;
  else increase = month + (quarter - month) * (daysBeforeAnchor - 30) / 60;
  return anchorRate / (1 + increase);
}

// Peer mentions can grow alongside the target: one answer may name several providers.
export function modeledBrandRate(targetRate: number, peerIndex: number) {
  return peerIndex < 0 ? targetRate : .04 + targetRate * (.60 - .06 * peerIndex);
}

export type InvestingCohort = { promptId: string; provider: ScanProvider };

/** First place predominates around the anchor, while some answers still rank another brand ahead. */
export function investingExpectedRank(visibility: number) {
  return 1 + 1.5 * (1 - visibility) ** 2;
}

/** Use complete UTC calendar days for calendar presets and respect the scenario's bounds. */
export function investingComparisonPeriod(demo: DemoConfig, start: string, end: string) {
  const from = Math.max(Date.parse(start), Date.parse(demo.startDate));
  const dayEnd = Date.parse(end.slice(0, 10)) + DAY;
  const isRollingDay = Date.parse(end) - Date.parse(start) + 1 === DAY;
  const to = Math.min(isRollingDay ? Date.parse(end) + 1 : dayEnd, Date.parse(demo.endDate) + DAY);
  return { start: new Date(from).toISOString(), end: new Date(to - 1).toISOString() };
}

export function investingTrend(demo: DemoConfig, cohorts: InvestingCohort[], period: { start: string; end: string }) {
  const start = Date.parse(period.start), end = Date.parse(period.end) + 1;
  if (!cohorts.length || end <= start) return null;
  let before = 0, after = 0, priorRank = 0, currentRank = 0;
  for (const { promptId, provider } of cohorts) {
    const first = investingVisibilityRate(demo, promptId, provider, start);
    const last = investingVisibilityRate(demo, promptId, provider, end);
    before += first;
    after += last;
    priorRank += investingExpectedRank(first);
    currentRank += investingExpectedRank(last);
  }
  before /= cohorts.length;
  after /= cohorts.length;
  const round = (value: number) => Number(value.toFixed(2));
  // Target sentiment is positive with probability p (otherwise neutral).
  return {
    before, after,
    visibility: round(100 * (after - before) / before),
    sentiment: round(100 * (after - before) / (1 + before)),
    rank: round(100 * (priorRank - currentRank) / priorRank),
  };
}
