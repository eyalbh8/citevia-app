import type {
  Analysis,
  CapturedAnswer,
  Metrics,
  PromptResult,
  RunSnapshot,
  RunSummary,
  ScanRun,
  SourceRow,
} from './types.js';
import { domainForUrl, isOwnedDomain, normalizeUrl, sourceId } from './urls.js';
import { brandRank, brandSentimentScore } from './scoring.js';

export function emptyMetrics(): Metrics {
  return {
    visibility: { value: null, numerator: 0, denominator: 0 },
    averageRank: { value: null, numerator: 0, denominator: 0 },
    sentimentScore: { value: null, numerator: 0, denominator: 0 },
    captured: 0,
    analyzed: 0,
    mentioned: 0,
    ranked: 0,
    citations: 0,
    uniqueDomains: 0,
    uniqueUrls: 0,
    sentiment: {
      positive: 0,
      neutral: 0,
      negative: 0,
      mixed: 0,
      unknown: 0,
      not_applicable: 0,
    },
  };
}

export function metricsFromResults(results: PromptResult[]): Metrics {
  const metrics = emptyMetrics();
  for (const result of results) {
    if (result.capturedAt) metrics.captured++;
    if (result.status !== 'succeeded' || !result.target) continue;
    metrics.analyzed++;
    const target = result.target;
    if (target.mentioned) metrics.mentioned++;
    metrics.sentiment[target.mentioned ? target.sentiment : 'not_applicable']++;
    const score = brandSentimentScore(target);
    if (score !== null) {
      metrics.sentimentScore.numerator += score;
      metrics.sentimentScore.denominator++;
    }
    const rank = brandRank(target);
    if (rank !== null && rank > 0) {
      metrics.ranked++;
      metrics.averageRank.numerator += rank;
    }
  }
  metrics.visibility = {
    value: metrics.analyzed
      ? (100 * metrics.mentioned) / metrics.analyzed
      : null,
    numerator: metrics.mentioned,
    denominator: metrics.analyzed,
  };
  metrics.averageRank.denominator = metrics.ranked;
  metrics.averageRank.value = metrics.ranked
    ? metrics.averageRank.numerator / metrics.ranked
    : null;
  metrics.sentimentScore.value = metrics.sentimentScore.denominator
    ? Math.round(
        metrics.sentimentScore.numerator / metrics.sentimentScore.denominator,
      )
    : null;
  return metrics;
}

export function sameMethod(a: RunSnapshot, b: RunSnapshot): boolean {
  return (
    (a.provider ?? 'openai') === (b.provider ?? 'openai') &&
    a.generationModel === b.generationModel &&
    a.extractionModel === b.extractionModel &&
    a.parserVersion === b.parserVersion &&
    a.country === b.country &&
    a.language === b.language &&
    JSON.stringify(a.brand) === JSON.stringify(b.brand) &&
    JSON.stringify(a.competitors) === JSON.stringify(b.competitors)
  );
}

export function sameCohort(a: RunSnapshot, b: RunSnapshot): boolean {
  const key = (snapshot: RunSnapshot) =>
    snapshot.prompts
      .map((p) => `${p.id}:${p.version}`)
      .sort()
      .join('|');
  return sameMethod(a, b) && key(a) === key(b);
}

export interface SummaryDetail {
  result: PromptResult;
  answer: CapturedAnswer | null;
  analysis: Analysis | null;
}
export function buildSummary(
  run: ScanRun,
  results: PromptResult[],
  details: SummaryDetail[],
): RunSummary {
  const metrics = metricsFromResults(results);
  const captured = details.filter(
    (item) => !!item.result.capturedAt && item.answer?.status === 'completed',
  );
  metrics.captured = captured.length;
  function aggregate(kind: 'cited' | 'consulted'): {
    domains: SourceRow[];
    urls: SourceRow[];
  } {
    const urls = new Map<
      string,
      { title: string; responses: Set<string>; occurrences: number }
    >();
    for (const item of captured) {
      const sources =
        kind === 'cited' ? item.answer!.citations : item.answer!.sources;
      for (const source of sources) {
        const url = normalizeUrl(source.url);
        if (!url) continue;
        const current = urls.get(url) || {
          title: source.title || url,
          responses: new Set<string>(),
          occurrences: 0,
        };
        current.responses.add(item.result.responseId);
        current.occurrences++;
        urls.set(url, current);
      }
    }
    const urlRows: SourceRow[] = [...urls.entries()].map(([url, item]) => ({
      id: sourceId(`${kind}:${url}`),
      domain: domainForUrl(url)!,
      url,
      title: item.title,
      kind,
      owned: isOwnedDomain(domainForUrl(url)!, run.snapshot.brand.domains),
      answerCount: item.responses.size,
      citationCount: kind === 'cited' ? item.occurrences : 0,
      uniqueUrlCount: 1,
      coverage: captured.length
        ? (100 * item.responses.size) / captured.length
        : null,
      responseIds: [...item.responses].sort(),
    }));
    const domains = new Map<
      string,
      { responses: Set<string>; occurrences: number; urls: number }
    >();
    for (const row of urlRows) {
      const current = domains.get(row.domain) || {
        responses: new Set<string>(),
        occurrences: 0,
        urls: 0,
      };
      row.responseIds.forEach((id) => current.responses.add(id));
      current.occurrences += row.citationCount;
      current.urls++;
      domains.set(row.domain, current);
    }
    const domainRows: SourceRow[] = [...domains.entries()].map(
      ([domain, item]) => ({
        id: sourceId(`${kind}:${domain}`),
        domain,
        kind,
        owned: isOwnedDomain(domain, run.snapshot.brand.domains),
        answerCount: item.responses.size,
        citationCount: item.occurrences,
        uniqueUrlCount: item.urls,
        coverage: captured.length
          ? (100 * item.responses.size) / captured.length
          : null,
        responseIds: [...item.responses].sort(),
      }),
    );
    const sort = (a: SourceRow, b: SourceRow) =>
      b.answerCount - a.answerCount ||
      b.citationCount - a.citationCount ||
      a.id.localeCompare(b.id);
    return { domains: domainRows.sort(sort), urls: urlRows.sort(sort) };
  }
  const cited = aggregate('cited'),
    consulted = aggregate('consulted');
  metrics.citations = cited.urls.reduce(
    (sum, row) => sum + row.citationCount,
    0,
  );
  metrics.uniqueDomains = cited.domains.length;
  metrics.uniqueUrls = cited.urls.length;
  return {
    metrics,
    domains: cited.domains,
    urls: cited.urls,
    consultedDomains: consulted.domains,
    consultedUrls: consulted.urls,
    createdAt: new Date().toISOString(),
    resultVersion: run.resultVersion,
  };
}
