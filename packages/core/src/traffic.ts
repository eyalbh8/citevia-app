/** Website referrals have their own provider list, independent of scan providers. */
export const TRAFFIC_PROVIDERS = [
  'openai',
  'claude',
  'perplexity',
  'gemini',
  'copilot',
  'deepseek',
] as const;
export type TrafficProvider = (typeof TRAFFIC_PROVIDERS)[number];
export const TRAFFIC_LABELS: Record<TrafficProvider, string> = {
  openai: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  copilot: 'Copilot',
  deepseek: 'DeepSeek',
};
const domains: Record<TrafficProvider, string[]> = {
  openai: ['chatgpt.com', 'openai.com'],
  claude: ['claude.ai', 'claude.com'],
  perplexity: ['perplexity.ai'],
  gemini: ['gemini.google.com', 'bard.google.com'],
  copilot: ['copilot.microsoft.com', 'copilot.com'],
  deepseek: ['deepseek.com'],
};
const aliases: Record<string, TrafficProvider> = {
  chatgpt: 'openai',
  'chat-gpt': 'openai',
  openai: 'openai',
  claude: 'claude',
  anthropic: 'claude',
  perplexity: 'perplexity',
  gemini: 'gemini',
  copilot: 'copilot',
  deepseek: 'deepseek',
};
export function trafficProvider(
  referrer: string | null,
  utmSource?: string | null,
): TrafficProvider | null {
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.toLowerCase();
      for (const provider of TRAFFIC_PROVIDERS)
        if (
          domains[provider].some(
            (domain) => host === domain || host.endsWith(`.${domain}`),
          )
        )
          return provider;
    } catch {
      /* UTM attribution is checked separately. */
    }
  }
  const source = (utmSource || '').toLowerCase().trim();
  if (Object.hasOwn(aliases, source)) return aliases[source];
  for (const provider of TRAFFIC_PROVIDERS)
    if (domains[provider].includes(source)) return provider;
  return null;
}
export function trafficBrowser(ua: string): string {
  return /edg(e|a|ios)?\//i.test(ua)
    ? 'Edge'
    : /opr\/|opera/i.test(ua)
      ? 'Opera'
      : /firefox|fxios/i.test(ua)
        ? 'Firefox'
        : /chrome|crios/i.test(ua)
          ? 'Chrome'
          : /safari/i.test(ua)
            ? 'Safari'
            : 'Other';
}
export function trafficDevice(ua: string): string {
  return /ipad|tablet|android(?!.*mobile)/i.test(ua)
    ? 'tablet'
    : /mobile|iphone|ipod|android/i.test(ua)
      ? 'mobile'
      : 'desktop';
}
export interface TrafficEvent {
  id: string;
  projectId: string;
  timestamp: string;
  url: string;
  path: string;
  referrer: string | null;
  provider: TrafficProvider;
  userAgent: string;
  browser: string;
  device: string;
  country: string | null;
  testId: string | null;
}
export interface TrafficPeriod {
  start: string;
  end: string;
  granularity: 'hourly' | 'daily';
  timezone: string;
}
export interface TrafficFilters {
  period: TrafficPeriod;
  previous: TrafficPeriod;
  providers: TrafficProvider[];
  countries: string[];
}
export interface TrafficRow {
  label: string;
  visits: number;
}
export interface TrafficAggregate {
  current: number;
  previous: number;
  providers: { provider: TrafficProvider; visits: number; previous: number }[];
  series: { date: string; values: Partial<Record<TrafficProvider, number>> }[];
  sources: TrafficRow[];
  pages: TrafficRow[];
  locations: TrafficRow[];
  devices: TrafficRow[];
  browsers: TrafficRow[];
  countries: string[];
}
export interface TrafficStatus {
  hasEvents: boolean;
  lastReceivedAt: string | null;
  testReceived: boolean;
}
export interface TrafficDashboard extends TrafficAggregate {
  period: TrafficPeriod;
  previousPeriod: TrafficPeriod;
  status: TrafficStatus;
}
/** Zero means unchanged; no previous baseline is shown as New rather than a fabricated percentage. */
export function trafficChange(
  current: number,
  previous: number,
): number | null {
  return previous === 0
    ? current > 0
      ? null
      : 0
    : Math.round(((current - previous) / previous) * 100);
}
export function trafficBuckets(period: TrafficPeriod): string[] {
  const step = period.granularity === 'hourly' ? 3600000 : 86400000;
  const first = Math.floor(Date.parse(period.start) / step) * step;
  const buckets: string[] = [];
  for (let at = first; at <= Date.parse(period.end); at += step)
    buckets.push(new Date(at).toISOString());
  return buckets;
}
/** Memory repository aggregation also provides a reference implementation for SQL parity tests. */
export function aggregateTraffic(
  events: TrafficEvent[],
  filters: TrafficFilters,
): TrafficAggregate {
  const inPeriod = (e: TrafficEvent, p: TrafficPeriod) =>
    e.timestamp >= p.start && e.timestamp <= p.end;
  const byProvider = events.filter(
    (e) =>
      !e.testId &&
      (!filters.providers.length || filters.providers.includes(e.provider)),
  );
  const countries = [
    ...new Set(
      byProvider
        .filter((e) => inPeriod(e, filters.period))
        .map((e) => e.country || 'ZZ'),
    ),
  ].sort();
  const filtered = byProvider.filter(
    (e) =>
      !filters.countries.length ||
      filters.countries.includes(e.country || 'ZZ'),
  );
  const current = filtered.filter((e) => inPeriod(e, filters.period));
  const previous = filtered.filter((e) => inPeriod(e, filters.previous));
  const rows = (key: (e: TrafficEvent) => string): TrafficRow[] => {
    const counts = new Map<string, number>();
    for (const event of current) {
      const value = key(event);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts]
      .map(([label, visits]) => ({ label, visits }))
      .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));
  };
  const series = trafficBuckets(filters.period).map((date) => ({
    date,
    values: {} as Partial<Record<TrafficProvider, number>>,
  }));
  const bucketMap = new Map(series.map((point) => [point.date, point.values]));
  const step = filters.period.granularity === 'hourly' ? 3600000 : 86400000;
  for (const event of current) {
    const bucket = bucketMap.get(
      new Date(
        Math.floor(Date.parse(event.timestamp) / step) * step,
      ).toISOString(),
    );
    if (bucket) bucket[event.provider] = (bucket[event.provider] || 0) + 1;
  }
  return {
    current: current.length,
    previous: previous.length,
    providers: TRAFFIC_PROVIDERS.filter(
      (p) => !filters.providers.length || filters.providers.includes(p),
    ).map((provider) => ({
      provider,
      visits: current.filter((e) => e.provider === provider).length,
      previous: previous.filter((e) => e.provider === provider).length,
    })),
    series,
    countries,
    sources: rows((e) =>
      e.referrer
        ? new URL(e.referrer).hostname
        : `${TRAFFIC_LABELS[e.provider]} (UTM)`,
    ),
    pages: rows((e) => e.path),
    locations: rows((e) => e.country || 'ZZ'),
    devices: rows((e) => e.device),
    browsers: rows((e) => e.browser),
  };
}
