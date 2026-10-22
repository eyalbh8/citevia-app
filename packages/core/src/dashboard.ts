import type {
  BrandAnalysis,
  CapturedAnswer,
  Project,
  PromptResult,
  ScanProvider,
  ScanRun,
} from './types.js';
import { projectProviders, snapshotProvider } from './providers.js';
import { brandSentimentScore } from './scoring.js';
import { isOwnedDomain, normalizeDomain } from './urls.js';
import {
  matchesMonitoringFilters,
  trackedUrlKey,
  type MonitoringFilters,
  type MonitoringPeriod,
} from './tracking.js';

export interface DashboardOverview {
  period: MonitoringPeriod;
  filters: MonitoringFilters & { topic?: string };
  analyzed: number;
  providers: { provider: ScanProvider; count: number; change: number | null }[];
  stages: {
    key: string;
    promptCount: number;
    measuredPromptCount: number;
    visibility: number;
  }[];
  ranking: {
    brandId: string;
    name: string;
    domain: string | null;
    isTarget: boolean;
    rank: number | null;
    rankChange: number | null;
    mentions: number;
    mentionChange: number | null;
    sentiment: number | null;
    sentimentChange: number | null;
  }[];
  /** Daily UTC mention counts. Missing capture days are not fabricated. */
  trend: { date: string; mentions: Record<string, number> }[];
  sources: {
    domain: string;
    pageCount: number;
    citationCount: number;
    owned: boolean;
  }[];
  comparison: 'first_to_last_observed_day';
}

export interface DashboardObservation {
  result: PromptResult;
  run: ScanRun;
  answer?: Pick<CapturedAnswer, 'citations'> | null;
}

/** Defense in depth for projections, in addition to repository project scoping. */
export function dashboardObservations(
  project: Project,
  period: MonitoringPeriod,
  filters: DashboardOverview['filters'],
  observations: DashboardObservation[],
) {
  const enabled = projectProviders(project).map((item) => item.provider);
  return observations.filter(({ result, run }) => {
    const provider = snapshotProvider(run.snapshot);
    const at = Date.parse(result.capturedAt || '');
    return (
      result.projectId === project.id &&
      run.projectId === project.id &&
      result.runId === run.id &&
      !run.reportingExcludedAt &&
      ['completed', 'partial'].includes(run.status) &&
      result.status === 'succeeded' &&
      enabled.includes(provider) &&
      at >= Date.parse(period.start) &&
      at <= Date.parse(period.end) &&
      matchesMonitoringFilters(
        result.prompt,
        provider,
        run.snapshot.country,
        filters,
      ) &&
      (!filters.topic || result.prompt.topic === filters.topic)
    );
  });
}

const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const rounded = (value: number | null, digits = 2) =>
  value === null ? null : Number(value.toFixed(digits));
function dailyChange(
  values: Map<string, number>,
  observedDays: Iterable<string>,
): number | null {
  const dates = [...observedDays].sort();
  if (!dates.length) return null;
  const first = values.get(dates[0]) || 0,
    last = values.get(dates.at(-1)!) || 0;
  return rounded(first ? ((last - first) / first) * 100 : last ? 100 : 0);
}

/** iGEO overview projection of deduplicated original captures, never synthetic data. */
export function aggregateDashboardOverview(
  project: Project,
  period: MonitoringPeriod,
  filters: DashboardOverview['filters'],
  input: DashboardObservation[],
): DashboardOverview {
  const observations = dashboardObservations(project, period, filters, input);
  const enabled = projectProviders(project).map((item) => item.provider);
  const providers = enabled.filter(
    (provider) =>
      !filters.providers.length || filters.providers.includes(provider),
  );
  const brands = [project.brand, ...project.competitors];
  const days = new Set<string>();
  const providerDays = new Map<ScanProvider, Set<string>>();
  const activePrompts = new Map(
    project.prompts
      .filter((prompt) => prompt.active)
      .map((prompt) => [prompt.id, prompt]),
  );
  // A mention is a distinct prompt text / provider / scan, matching iGEO's dashboard.
  const mentions = new Map<
    string,
    Map<
      string,
      { day: string; sentiment: number | null; provider: ScanProvider }
    >
  >();
  const promptResults = new Map<
    string,
    { analyzed: number; mentioned: number }
  >();
  const sourceRows = new Map<
    string,
    { pages: Set<string>; citationCount: number }
  >();
  for (const { result, run, answer } of observations) {
    const provider = snapshotProvider(run.snapshot);
    const day = result.capturedAt!.slice(0, 10);
    days.add(day);
    const observed = providerDays.get(provider) || new Set<string>();
    observed.add(day);
    providerDays.set(provider, observed);
    const currentPrompt = activePrompts.get(result.promptId);
    // Saved answers remain in historical totals, but cannot measure an edited question.
    if (
      currentPrompt &&
      currentPrompt.version === result.prompt.version &&
      currentPrompt.text === result.prompt.text
    ) {
      const prompt = promptResults.get(result.promptId) || {
        analyzed: 0,
        mentioned: 0,
      };
      prompt.analyzed++;
      if (result.target?.mentioned) prompt.mentioned++;
      promptResults.set(result.promptId, prompt);
    }
    const measured = new Map<string, BrandAnalysis>(
      (result.brands || []).map((brand) => [brand.brandId, brand]),
    );
    if (result.target) measured.set(result.target.brandId, result.target);
    for (const brand of brands) {
      const measurement = measured.get(brand.id);
      if (!measurement?.mentioned) continue;
      const events = mentions.get(brand.id) || new Map();
      // Reanalysis retains the original capture; it cannot create a new mention.
      const key = JSON.stringify([
        run.reanalysisOf || run.id,
        provider,
        result.prompt.text,
      ]);
      events.set(key, {
        day,
        provider,
        sentiment: brandSentimentScore(measurement),
      });
      mentions.set(brand.id, events);
    }
    for (const citation of answer?.citations || []) {
      const page = trackedUrlKey(citation.url);
      if (!page) continue;
      const domain = new URL(citation.url).hostname.toLowerCase();
      const source = sourceRows.get(domain) || {
        pages: new Set<string>(),
        citationCount: 0,
      };
      source.pages.add(page);
      source.citationCount++;
      sourceRows.set(domain, source);
    }
  }

  const daily = new Map<string, Map<string, number>>();
  const sentiments = new Map<string, Map<string, number[]>>();
  for (const [brandId, events] of mentions) {
    const counts = new Map<string, number>(),
      scores = new Map<string, number[]>();
    for (const event of events.values()) {
      counts.set(event.day, (counts.get(event.day) || 0) + 1);
      if (event.sentiment !== null)
        scores.set(event.day, [
          ...(scores.get(event.day) || []),
          event.sentiment,
        ]);
    }
    daily.set(brandId, counts);
    sentiments.set(brandId, scores);
  }
  const ranks = new Map<string, Map<string, number>>();
  for (const day of days) {
    const leaders = brands
      .map((brand) => ({
        id: brand.id,
        count: daily.get(brand.id)?.get(day) || 0,
      }))
      .filter((item) => {
        const firstMention = [...(daily.get(item.id)?.keys() || [])].sort()[0];
        return firstMention && day >= firstMention;
      });
    for (const item of leaders) {
      const scores = ranks.get(item.id) || new Map();
      // Competition ranking preserves ties: 1, 1, 3 rather than arbitrary ordering.
      scores.set(
        day,
        1 + leaders.filter((other) => other.count > item.count).length,
      );
      ranks.set(item.id, scores);
    }
  }
  const observedDays = [...days].sort();
  const ranking: DashboardOverview['ranking'] = brands
    .filter((brand) => mentions.has(brand.id))
    .map((brand) => {
      const brandRanks = ranks.get(brand.id) || new Map<string, number>();
      const rankDates = [...brandRanks.keys()].sort();
      const scores = sentiments.get(brand.id) || new Map<string, number[]>();
      const firstSentiment = mean(scores.get(observedDays[0]) || []);
      const lastSentiment = mean(scores.get(observedDays.at(-1)!) || []);
      return {
        brandId: brand.id,
        name: brand.name,
        domain: brand.domains[0] || null,
        isTarget: brand.id === project.brand.id,
        rank: rounded(mean([...brandRanks.values()]), 1),
        rankChange: rankDates.length
          ? brandRanks.get(rankDates[0])! - brandRanks.get(rankDates.at(-1)!)!
          : null,
        mentions: mentions.get(brand.id)?.size || 0,
        mentionChange: dailyChange(daily.get(brand.id) || new Map(), days),
        sentiment: rounded(mean([...scores.values()].flat()), 0),
        sentimentChange:
          firstSentiment !== null && lastSentiment !== null
            ? Math.round(lastSentiment) - Math.round(firstSentiment)
            : null,
      };
    })
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        Number(b.isTarget) - Number(a.isTarget) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 5);

  const stages = new Map<
    string,
    { promptCount: number; measuredPromptCount: number; visibility: number }
  >();
  for (const prompt of project.prompts) {
    if (
      !prompt.active ||
      !matchesMonitoringFilters(
        prompt,
        providers[0] || enabled[0],
        project.country,
        { ...filters, providers: [] },
      ) ||
      (filters.topic && prompt.topic !== filters.topic)
    )
      continue;
    const key = prompt.stage || 'unassigned';
    const stage = stages.get(key) || {
      promptCount: 0,
      measuredPromptCount: 0,
      visibility: 0,
    };
    const measured = promptResults.get(prompt.id);
    stage.promptCount++;
    if (measured?.analyzed) {
      stage.measuredPromptCount++;
      stage.visibility += Math.round(
        (100 * measured.mentioned) / measured.analyzed,
      );
    }
    stages.set(key, stage);
  }
  return {
    period,
    filters,
    analyzed: observations.length,
    providers: providers.map((provider) => {
      const counts = new Map<string, number>();
      const events = [
        ...(mentions.get(project.brand.id)?.values() || []),
      ].filter((event) => event.provider === provider);
      for (const event of events)
        counts.set(event.day, (counts.get(event.day) || 0) + 1);
      return {
        provider,
        count: events.length,
        change: dailyChange(counts, providerDays.get(provider) || []),
      };
    }),
    stages: [...stages]
      .map(([key, row]) => ({
        ...row,
        key,
        visibility: Math.round(row.visibility / row.promptCount),
      }))
      .sort(
        (a, b) => b.visibility - a.visibility || a.key.localeCompare(b.key),
      ),
    ranking,
    trend: observedDays.map((date) => ({
      date,
      mentions: Object.fromEntries(
        ranking.map((brand) => [
          brand.brandId,
          daily.get(brand.brandId)?.get(date) || 0,
        ]),
      ),
    })),
    sources: [...sourceRows]
      .map(([domain, row]) => ({
        domain,
        pageCount: row.pages.size,
        citationCount: row.citationCount,
        owned: isOwnedDomain(
          normalizeDomain(domain) || domain,
          project.brand.domains,
        ),
      }))
      .sort(
        (a, b) =>
          b.citationCount - a.citationCount ||
          b.pageCount - a.pageCount ||
          a.domain.localeCompare(b.domain),
      )
      .slice(0, 5),
    comparison: 'first_to_last_observed_day',
  };
}
