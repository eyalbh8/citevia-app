import {
  buildSummary,
  projectProviders,
  TRAFFIC_PROVIDERS,
  trafficBuckets,
  type Analysis,
  type BrandAnalysis,
  type CapturedAnswer,
  type Citation,
  type DemoConfig,
  type Project,
  type Prompt,
  type PromptHistory,
  type PromptResult,
  type ScanProvider,
  type ScanRun,
  type TrafficAggregate,
  type TrafficFilters,
  type TrafficProvider,
  type TrafficRow,
} from '@citevia/core';
import type { Repository, Runtime, SavedAnalysisRef } from './contracts.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = DAY * 7;
const PREFIX = 'demo/v1/';
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const iso = (at: number) => new Date(at).toISOString();
const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`);

/** The persisted fixture is small; a year of measurements is derived, never inserted. */
function configFor(project: Project): DemoConfig | null {
  const config = project.demo;
  if (!config) return null;
  if (config.version !== 1 || config.source !== 'igeo-nayax' ||
      !Number.isFinite(day(config.startDate)) || !Number.isFinite(day(config.endDate)) ||
      day(config.endDate) < day(config.startDate) ||
      day(config.endDate) - day(config.startDate) > 366 * DAY)
    throw new Error('Invalid demo scenario configuration');
  return config;
}

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

const promptCache = new WeakMap<Project, Prompt[]>();
function activePrompts(project: Project) {
  let prompts = promptCache.get(project);
  if (!prompts) { prompts = project.prompts.filter((prompt) => prompt.active).slice(0, 50); promptCache.set(project, prompts); }
  return prompts;
}

const scanTimeCache = new WeakMap<Project, number[]>();
/** UTC week starts Monday, matching the fleet's persisted slotsUtcMinutes contract. */
function scanTimes(project: Project): number[] {
  const cached = scanTimeCache.get(project);
  if (cached) return cached;
  const config = configFor(project)!;
  const start = day(config.startDate), end = day(config.endDate) + DAY - 1;
  const startOfWeek = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY;
  const requested = project.scanSchedule?.slotsUtcMinutes || [600, 5640];
  const slots = [...new Set(requested)].sort((a, b) => a - b);
  if (slots.length !== 2 || slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= 10080))
    throw new Error('A demo requires two distinct weekly scan slots');
  const times: number[] = [];
  for (let week = startOfWeek; week <= end; week += WEEK)
    for (const slot of slots) {
      const at = week + slot * 60_000;
      if (at >= start && at <= end) times.push(at);
    }
  scanTimeCache.set(project, times);
  return times;
}

function progress(project: Project, at: number) {
  const config = configFor(project)!;
  return Math.max(0, Math.min(1,
    (at - day(config.startDate)) / Math.max(DAY, day(config.endDate) - day(config.startDate)),
  ));
}

function runId(at: number, provider: ScanProvider) {
  return `run_demo_${iso(at).slice(0, 16).replace(/[-:]/g, '')}_${provider}`;
}

function artifactKey(project: Project, run: ScanRun, prompt: Prompt, kind: 'capture' | 'analysis') {
  return `${PREFIX}${encodeURIComponent(project.id)}/${run.id}/${encodeURIComponent(prompt.id)}/${kind}.json`;
}

function createRun(project: Project, at: number, provider: ScanProvider): ScanRun {
  const prompts = activePrompts(project);
  const model = projectProviders(project).find((item) => item.provider === provider)!.model;
  const createdAt = iso(at);
  return {
    projectId: project.id,
    id: runId(at, provider),
    groupId: `demo_${iso(at)}`,
    scheduledAt: createdAt,
    createdAt,
    startedAt: createdAt,
    completedAt: iso(at + 120_000),
    status: 'completed',
    trigger: 'scheduled',
    snapshot: {
      projectId: project.id,
      projectName: project.name,
      brand: project.brand,
      competitors: project.competitors,
      prompts,
      country: project.country,
      language: project.language,
      timezone: project.timezone,
      generationModel: model,
      extractionModel: project.extractionModel,
      parserVersion: project.parserVersion,
      configVersion: project.version,
      provider,
      scanProviders: projectProviders(project),
    },
    totalCount: prompts.length,
    terminalCount: prompts.length,
    succeededCount: prompts.length,
    capturedCount: prompts.length,
    resultVersion: prompts.length,
    summaryVersion: prompts.length,
    summaryKey: `${PREFIX}${encodeURIComponent(project.id)}/${runId(at, provider)}/summary.json`,
    deadlineAt: iso(at + HOUR),
    expiresAt: Math.floor((day(configFor(project)!.endDate) + 366 * DAY) / 1000),
  };
}

const runIndexCache = new WeakMap<Project, Map<string, { at: number; provider: ScanProvider }>>();
function findRun(project: Project, id: string): ScanRun | null {
  let index = runIndexCache.get(project);
  if (!index) {
    index = new Map();
    for (const at of scanTimes(project))
      for (const { provider } of projectProviders(project)) index.set(runId(at, provider), { at, provider });
    runIndexCache.set(project, index);
  }
  const item = index.get(id);
  return item ? createRun(project, item.at, item.provider) : null;
}

const measurementPlans = new WeakMap<Project, Map<ScanProvider, {
  promptOrder: Map<string, number>;
  scans: Map<number, { phase: number; mentionCount: number; positiveCount: number }>;
}>>();

function measurementPlan(project: Project, provider: ScanProvider) {
  let providers = measurementPlans.get(project);
  if (!providers) { providers = new Map(); measurementPlans.set(project, providers); }
  const cached = providers.get(provider);
  if (cached) return cached;
  const prompts = activePrompts(project);
  const ordered = [...prompts].sort((a, b) =>
    hash(`${provider}:${a.id}`) - hash(`${provider}:${b.id}`) || a.id.localeCompare(b.id),
  );
  const plan = { promptOrder: new Map(ordered.map((prompt, index) => [prompt.id, index])),
    scans: new Map<number, { phase: number; mentionCount: number; positiveCount: number }>() };
  let previousCount = 0, previousPositive = 0;
  for (const at of scanTimes(project)) {
    const phase = progress(project, at);
    const mentionCount = Math.min(prompts.length, Math.floor(prompts.length * (0.32 + 0.64 * phase)));
    // Preserve the previous positive share when a new prompt starts mentioning
    // the brand; otherwise rounding could create small misleading downward ticks.
    const positiveCount = Math.min(mentionCount, Math.max(
      Math.ceil(mentionCount * (0.3 + 0.66 * phase)),
      previousCount ? Math.ceil(mentionCount * previousPositive / previousCount - 1e-10) : 0,
    ));
    plan.scans.set(at, { phase, mentionCount, positiveCount });
    previousCount = mentionCount;
    previousPositive = positiveCount;
  }
  providers.set(provider, plan);
  return plan;
}

const companyPoolCache = new WeakMap<Project, string[]>();
function sourceCompanies(project: Project) {
  let pool = companyPoolCache.get(project);
  if (pool) return pool;
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const trackedNames = [project.brand, ...project.competitors]
    .flatMap((brand) => [brand.name, ...brand.aliases]).map(normalize).filter(Boolean);
  const candidates = (configFor(project)!.samples || []).flatMap((sample) => sample.companies || []);
  // A filler must not silently introduce a tracked brand whose measurement says
  // it was absent, including a source name that merely expands a known alias.
  pool = [...new Map(candidates.filter((name) => {
    const key = normalize(name);
    return key && name.length <= 120 && !trackedNames.some((alias) => key.includes(alias) || alias.includes(key));
  }).map((name) => [normalize(name), name])).values()];
  companyPoolCache.set(project, pool);
  return pool;
}

/** A stable threshold preserves each prompt's gains as the scenario advances. */
function brandMeasurements(project: Project, run: ScanRun, prompt: Prompt): BrandAnalysis[] {
  const plan = measurementPlan(project, run.snapshot.provider!);
  const { phase, mentionCount, positiveCount } = plan.scans.get(Date.parse(run.scheduledAt))!;
  const index = plan.promptOrder.get(prompt.id)!;
  const mentioned = index < mentionCount;
  // Every mentioned answer improves from neutral to positive. The positive share
  // increases as well; the target remains imperfect at the end of the scenario.
  const visibleCompetitors = project.competitors.filter((brand, competitorIndex) => {
    const threshold = (hash(`${prompt.id}:${brand.id}:${run.snapshot.provider}`) % 1000) / 1000;
    return threshold < 0.50 - 0.18 * phase - competitorIndex * 0.025;
  });
  // All earlier ordinal positions must have a company in the simulated answer.
  // Sparse fixtures without source alternatives use the highest supportable rank.
  const rank = Math.min(1 + visibleCompetitors.length + sourceCompanies(project).length,
    Math.max(1, 7 - Math.floor(phase * 5.8)));
  const target: BrandAnalysis = {
    brandId: project.brand.id,
    mentioned,
    explicitRank: mentioned ? rank : null,
    appearanceRank: mentioned ? rank : null,
    mentionOrder: mentioned ? rank : null,
    sentiment: mentioned ? index < positiveCount ? 'positive' : 'neutral' : 'not_applicable',
    evidence: [],
    rankEvidence: null,
    sentimentEvidence: null,
  };
  let nextPosition = 1;
  return [target, ...project.competitors.map((brand): BrandAnalysis => {
    // Competitors remain credible references while Nayax overtakes their share.
    const visible = visibleCompetitors.includes(brand);
    if (mentioned && nextPosition === rank) nextPosition++;
    const position = nextPosition;
    if (visible) nextPosition++;
    return {
      brandId: brand.id,
      mentioned: visible,
      explicitRank: visible ? position : null,
      appearanceRank: visible ? position : null,
      mentionOrder: visible ? position : null,
      sentiment: visible ? 'neutral' : 'not_applicable',
      evidence: [], rankEvidence: null, sentimentEvidence: null,
    };
  })];
}

function sampleFor(project: Project, prompt: Prompt) {
  const samples = configFor(project)!.samples || [];
  return samples.find((sample) => sample.promptId === prompt.id) ||
    samples.find((sample) => sample.promptText === prompt.text) ||
    samples[hash(prompt.id) % Math.max(1, samples.length)];
}

const citationPoolCache = new WeakMap<Project, Map<string, { url: string; title?: string }[]>>();
function citationsFor(project: Project, run: ScanRun, prompt: Prompt): Citation[] {
  let pools = citationPoolCache.get(project);
  if (!pools) { pools = new Map(); citationPoolCache.set(project, pools); }
  let unique = pools.get(prompt.id);
  if (!unique) {
    const sample = sampleFor(project, prompt);
    const domains = [project.brand, ...project.competitors].flatMap((brand) => brand.domains);
    const fallback = domains.map((domain) => ({ url: `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`, title: domain }));
    const candidates = [...(sample?.citations || []),
      ...(configFor(project)!.samples || []).flatMap((item) => item.citations || []), ...fallback].filter((citation) => {
      try { return ['http:', 'https:'].includes(new URL(citation.url).protocol); } catch { return false; }
    });
    unique = [...new Map(candidates.map((citation) => [citation.url, citation])).values()];
    pools.set(prompt.id, unique);
  }
  const size = Math.min(unique.length, 1 + Math.floor(progress(project, Date.parse(run.scheduledAt)) * 5));
  return unique.slice(0, size).map((citation, index) => ({
    id: `citation_${index + 1}`, blockId: 'answer', url: citation.url,
    title: citation.title || new URL(citation.url).hostname, start: null, end: null,
  }));
}

function resultFor(project: Project, run: ScanRun, prompt: Prompt): PromptResult {
  const brands = brandMeasurements(project, run, prompt);
  const citations = citationsFor(project, run, prompt);
  const index = activePrompts(project).findIndex((item) => item.id === prompt.id);
  return {
    projectId: project.id, runId: run.id, promptId: prompt.id,
    responseId: `${run.id}~${prompt.id}`, prompt,
    status: 'succeeded', version: 1, attempts: 0,
    collectionAttempts: 0, analysisAttempts: 0,
    captureKey: artifactKey(project, run, prompt, 'capture'),
    analysisKey: artifactKey(project, run, prompt, 'analysis'),
    target: brands[0], brands,
    citationCount: citations.length,
    sourceCount: new Set(citations.map((citation) => citation.url)).size,
    capturedAt: iso(Date.parse(run.scheduledAt) + index * 1000),
    completedAt: iso(Date.parse(run.scheduledAt) + index * 1000 + 1000),
    model: run.snapshot.generationModel,
    usage: emptyUsage(), extractionUsage: emptyUsage(), expiresAt: run.expiresAt,
  };
}

function evidenceFor(project: Project, run: ScanRun, prompt: Prompt) {
  const result = resultFor(project, run, prompt);
  const sample = sampleFor(project, prompt);
  const names = new Map([project.brand, ...project.competitors].map((brand) => [brand.id, brand.name]));
  const companies = result.brands!.filter((brand) => brand.mentioned).map((brand) => ({
    name: names.get(brand.brandId)!, rank: brand.appearanceRank!,
    sentiment: brand.sentiment === 'not_applicable' ? 'unknown' as const : brand.sentiment,
    brandId: brand.brandId,
  }));
  const available = sourceCompanies(project);
  const lastRank = Math.max(0, ...companies.map((company) => company.rank), Math.min(3, companies.length + available.length));
  let fillerIndex = 0;
  for (let rank = 1; rank <= lastRank; rank++)
    if (!companies.some((company) => company.rank === rank) && fillerIndex < available.length)
      companies.push({ name: available[fillerIndex++], rank, sentiment: 'neutral', brandId: '' });
  companies.sort((a, b) => a.rank - b.rank);
  const sentences = companies.map((company) =>
    `${company.rank}. ${company.name}${company.sentiment === 'positive' ? ' is a strong choice with growing adoption and a comprehensive payment platform.' : ' is an established option to evaluate for this use case.'}`,
  );
  const selection = sentences.join('\n');
  // The source excerpt is a reusable illustration, not a second provider call.
  const excerpt = result.target?.mentioned ? sample?.answerText?.trim().slice(0, 1800) : undefined;
  const text = [
    'Synthetic demo scenario. Projected measurements and example answers are illustrative.',
    selection || 'Compare payment platforms by integration coverage, support, and total cost.',
    excerpt ? `Saved source example:\n${excerpt}` : '',
  ].filter(Boolean).join('\n\n');
  const companySpans = companies.map((company, index) => ({
    blockId: 'answer', quote: sentences[index],
    start: text.indexOf(sentences[index]), end: text.indexOf(sentences[index]) + sentences[index].length,
  }));
  const brands = result.brands!.map((brand) => ({
    ...brand,
    evidence: brand.mentioned ? [companySpans[companies.findIndex((company) => company.brandId === brand.brandId)]] : [],
    rankEvidence: brand.mentioned ? companySpans[companies.findIndex((company) => company.brandId === brand.brandId)] : null,
    sentimentEvidence: brand.mentioned ? companySpans[companies.findIndex((company) => company.brandId === brand.brandId)] : null,
  }));
  const citations = citationsFor(project, run, prompt);
  const answer: CapturedAnswer = {
    provider: run.snapshot.provider,
    providerResponseId: `demo_${result.responseId}`,
    model: run.snapshot.generationModel,
    status: 'completed',
    blocks: [{ id: 'answer', text }], text, citations,
    sources: citations.map(({ url, title }) => ({ url, title })),
    usage: emptyUsage(), createdAt: result.capturedAt!,
    raw: { demo: true, source: configFor(project)!.source, projection: result.capturedAt! > `${configFor(project)!.anchorDate}T23:59:59.999Z` },
  };
  const analysis: Analysis = {
    brands,
    companies: companies.map((company, index) => ({
      name: company.name, rank: company.rank, evidence: companySpans[index],
      sentiment: company.sentiment,
      sentimentEvidence: companySpans[index],
    })),
    parserVersion: project.parserVersion,
    model: project.extractionModel,
    createdAt: result.completedAt!, usage: emptyUsage(),
  };
  return { result, answer, analysis };
}

function historyFor(project: Project, start: string, end: string, promptId?: string): PromptHistory {
  const from = Date.parse(start), to = Date.parse(end);
  const results: PromptResult[] = [], runs: ScanRun[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return { runs, results };
  const prompts = activePrompts(project).filter((prompt) => !promptId || prompt.id === promptId);
  for (const at of scanTimes(project)) {
    if (at + 50_000 < from || at > to) continue;
    for (const { provider } of projectProviders(project)) {
      const run = createRun(project, at, provider);
      const measured = prompts.map((prompt) => resultFor(project, run, prompt)).filter((result) =>
        Date.parse(result.capturedAt!) >= from && Date.parse(result.capturedAt!) <= to,
      );
      if (measured.length) { runs.push(run); results.push(...measured); }
    }
  }
  return { runs, results };
}

function add(counts: Map<string, number>, label: string, visits: number) {
  if (visits) counts.set(label, (counts.get(label) || 0) + visits);
}

function rows(counts: Map<string, number>): TrafficRow[] {
  return [...counts].map(([label, visits]) => ({ label, visits }))
    .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));
}

/** Integer partitions reconcile every traffic panel without visitor-level rows. */
function partition(total: number, labels: string[], counts: Map<string, number>) {
  const denominator = labels.length * (labels.length + 1) / 2;
  let consumed = 0;
  for (let index = 0; index < labels.length; index++) {
    const cumulative = ((index + 1) * (2 * labels.length - index)) / 2;
    const next = Math.floor(total * cumulative / denominator);
    add(counts, labels[index], next - consumed);
    consumed = next;
  }
}

function trafficFor(project: Project, filters: TrafficFilters): TrafficAggregate {
  const config = configFor(project)!;
  const dimensions = config.traffic;
  const clean = (values: string[] | undefined, fallback: string[]) => [...new Set(values?.filter(Boolean).slice(0, 12) || fallback)];
  const countries = clean(dimensions?.countries?.map((country) => country.toUpperCase()).filter((country) => /^[A-Z]{2}$/.test(country)), ['US', 'GB', 'DE', 'IL']);
  if (!countries.length) countries.push('US');
  const pages = clean(dimensions?.pages, ['/', '/solutions/', '/products/', '/contact/']);
  const browsers = clean(dimensions?.browsers, ['Chrome', 'Safari', 'Edge', 'Firefox']);
  const devices = clean(dimensions?.devices, ['desktop', 'mobile', 'tablet']);
  if (!pages.length) pages.push('/');
  if (!browsers.length) browsers.push('Chrome');
  if (!devices.length) devices.push('desktop');
  const providers = TRAFFIC_PROVIDERS.filter((provider) => !filters.providers.length || filters.providers.includes(provider));
  const totals = new Map(providers.map((provider) => [provider, { provider, visits: 0, previous: 0 }]));
  const series = trafficBuckets(filters.period).map((date) => ({ date, values: {} as Partial<Record<TrafficProvider, number>> }));
  const seriesIndex = new Map(series.map((point) => [point.date, point.values]));
  const sources = new Map<string, number>(), pageCounts = new Map<string, number>(), locations = new Map<string, number>();
  const browserCounts = new Map<string, number>(), deviceCounts = new Map<string, number>();
  const hosts: Record<TrafficProvider, string> = {
    openai: 'chatgpt.com', claude: 'claude.ai', perplexity: 'perplexity.ai',
    gemini: 'gemini.google.com', copilot: 'copilot.microsoft.com', deepseek: 'deepseek.com',
  };
  const scales: Record<TrafficProvider, number> = { openai: 1, perplexity: 0.61, gemini: 0.47, claude: 0.32, copilot: 0.23, deepseek: 0.12 };
  const currentStart = Date.parse(filters.period.start), currentEnd = Date.parse(filters.period.end);
  const previousStart = Date.parse(filters.previous.start), previousEnd = Date.parse(filters.previous.end);
  const from = Math.max(day(config.startDate), Math.min(previousStart, currentStart));
  const to = Math.min(day(config.endDate) + DAY - 1, Math.max(previousEnd, currentEnd));
  const step = filters.period.granularity === 'hourly' ? HOUR : DAY;
  for (let at = Math.floor(from / DAY) * DAY; at <= to; at += DAY) {
    const phase = progress(project, at);
    for (const provider of providers) {
      const daily = Math.round((52 + 590 * phase + 340 * phase * phase) * scales[provider]);
      const perCountry = new Map<string, number>();
      partition(daily, countries, perCountry);
      for (const [country, count] of perCountry) {
        if (filters.countries.length && !filters.countries.includes(country)) continue;
        for (let hour = 0; hour < 24; hour++) {
          const timestamp = at + hour * HOUR;
          const hourly = Math.floor(count * (hour + 1) / 24) - Math.floor(count * hour / 24);
          const amount = (start: number, end: number) => {
            const begin = Math.max(timestamp, start), finish = Math.min(timestamp + HOUR - 1, end);
            if (begin > finish) return 0;
            return Math.floor(hourly * (finish - timestamp + 1) / HOUR) - Math.floor(hourly * (begin - timestamp) / HOUR);
          };
          const visits = amount(currentStart, currentEnd), previous = amount(previousStart, previousEnd);
          const total = totals.get(provider)!;
          total.visits += visits;
          total.previous += previous;
          if (!visits) continue;
          const bucket = seriesIndex.get(iso(Math.floor(timestamp / step) * step));
          if (bucket) bucket[provider] = (bucket[provider] || 0) + visits;
          add(sources, hosts[provider], visits);
          add(locations, country, visits);
        }
      }
    }
  }
  const current = [...totals.values()].reduce((sum, item) => sum + item.visits, 0);
  // Partition the complete filtered total: rounding tiny hourly counts would
  // otherwise send most visits to the last category and reverse source order.
  partition(current, pages, pageCounts);
  partition(current, browsers, browserCounts);
  partition(current, devices, deviceCounts);
  return {
    current,
    previous: [...totals.values()].reduce((sum, item) => sum + item.previous, 0),
    providers: [...totals.values()], series,
    sources: rows(sources), pages: rows(pageCounts), locations: rows(locations),
    devices: rows(deviceCounts), browsers: rows(browserCounts),
    countries: to >= currentStart ? [...countries].sort() : [],
  };
}

/**
 * Scope virtual reads to an explicitly marked saved project. Authentication and
 * membership stay on the real repository; ordinary projects pass through.
 */
export function withDemoRuntime(runtime: Runtime, now: () => Date = () => new Date()): Runtime {
  const projects = new Map<string, { until: number; value: Promise<Project | null> }>();
  async function demoProject(id: string) {
    const cached = projects.get(id);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = runtime.repository.getProject(id).then((project) => project && configFor(project) ? project : null);
    if (projects.size >= 128) projects.delete(projects.keys().next().value!);
    projects.set(id, { value, until: Date.now() + 30_000 });
    return value;
  }
  async function keyDetails(key: string) {
    if (!key.startsWith(PREFIX)) return null;
    const pieces = key.slice(PREFIX.length).split('/');
    if (pieces.length !== 3 && pieces.length !== 4) return null;
    let id: string, promptId: string | undefined;
    try { id = decodeURIComponent(pieces[0]); promptId = pieces.length === 4 ? decodeURIComponent(pieces[2]) : undefined; }
    catch { return null; }
    const project = await demoProject(id);
    if (!project) return null;
    const run = findRun(project, pieces[1]);
    if (!run) return null;
    const prompt = promptId ? activePrompts(project).find((item) => item.id === promptId) : undefined;
    const kind = pieces.at(-1);
    if (pieces.length === 3 && kind === 'summary.json') return { project, run, kind };
    if (!prompt || (kind !== 'capture.json' && kind !== 'analysis.json')) return null;
    // Reject alternate encodings rather than creating aliases for artifact keys.
    if (artifactKey(project, run, prompt, kind === 'capture.json' ? 'capture' : 'analysis') !== key) return null;
    return { project, run, prompt, kind };
  }
  const overrides: Partial<Repository> = {
    async listRuns(projectId, limit = 60) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listRuns(projectId, limit);
      return scanTimes(project).filter((at) => at <= now().getTime()).reverse()
        .flatMap((at) => projectProviders(project).map(({ provider }) => createRun(project, at, provider)))
        .slice(0, Math.max(0, limit));
    },
    async getRun(projectId, id) {
      const project = await demoProject(projectId);
      return project ? findRun(project, id) : runtime.repository.getRun(projectId, id);
    },
    async listResults(projectId, id) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listResults(projectId, id);
      const run = findRun(project, id);
      return run ? activePrompts(project).map((prompt) => resultFor(project, run, prompt)) : [];
    },
    async getResult(projectId, id, promptId) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.getResult(projectId, id, promptId);
      const run = findRun(project, id), prompt = activePrompts(project).find((item) => item.id === promptId);
      return run && prompt ? resultFor(project, run, prompt) : null;
    },
    async listPromptHistory(projectId, start, end, promptId) {
      const project = await demoProject(projectId);
      return project ? historyFor(project, start, end, promptId) : runtime.repository.listPromptHistory(projectId, start, end, promptId);
    },
    async listPromptAnswerPage(projectId, options) {
      const project = await demoProject(projectId);
      return project ? null : runtime.repository.listPromptAnswerPage?.(projectId, options) ?? null;
    },
    async listNativeCitations(projectId, captureKeys) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listNativeCitations(projectId, captureKeys);
      const items: { captureKey: string; citations: Citation[] }[] = [];
      for (const captureKey of new Set(captureKeys)) {
        const provider = captureKey.slice(0, captureKey.indexOf(':'));
        const key = captureKey.slice(captureKey.indexOf(':') + 1);
        const details = await keyDetails(key);
        if (details?.project.id === projectId && details.prompt && details.kind === 'capture.json' && details.run.snapshot.provider === provider)
          items.push({ captureKey, citations: citationsFor(project, details.run, details.prompt) });
      }
      return items;
    },
    async listSavedAnalyses(projectId, refs: SavedAnalysisRef[]) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listSavedAnalyses(projectId, refs);
      const items = [];
      for (const ref of refs) {
        const details = await keyDetails(ref.captureKey);
        if (details?.project.id !== projectId || !details.prompt || details.kind !== 'capture.json') continue;
        const evidence = evidenceFor(project, details.run, details.prompt);
        if (evidence.result.responseId !== ref.responseId || evidence.result.analysisKey !== ref.analysisKey) continue;
        items.push({ responseId: ref.responseId, analysis: evidence.analysis });
      }
      return items;
    },
    async aggregateTraffic(projectId, filters) {
      const project = await demoProject(projectId);
      return project ? trafficFor(project, filters) : runtime.repository.aggregateTraffic(projectId, filters);
    },
    async trafficStatus(projectId, testId) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.trafficStatus(projectId, testId);
      const config = configFor(project)!;
      const last = iso(Math.max(day(config.startDate), Math.min(now().getTime(), day(config.endDate) + DAY - 1)));
      return {
        installed: true, hasEvents: now().getTime() >= day(config.startDate), lastReceivedAt: last,
        testReceived: false,
        sites: project.brand.domains.slice(0, 3).flatMap((domain) => {
          try { return [{ origin: new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain}`).origin,
            firstSeenAt: iso(day(config.startDate)), lastSeenAt: last, trackerVersion: 'demo-v1' }]; }
          catch { return []; }
        }),
      };
    },
  };
  const repository = new Proxy(runtime.repository, {
    get(target, property, receiver) {
      const override = overrides[property as keyof Repository];
      if (override) return override;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    repository,
    queue: runtime.queue,
    artifacts: {
      async get<T>(key: string): Promise<T | null> {
        if (!key.startsWith(PREFIX)) return runtime.artifacts.get<T>(key);
        const details = await keyDetails(key);
        if (!details) return null;
        const { project, run, prompt } = details;
        if (prompt) {
          const evidence = evidenceFor(project, run, prompt);
          return (details.kind === 'capture.json' ? evidence.answer : evidence.analysis) as T;
        }
        const evidence = activePrompts(project).map((item) => evidenceFor(project, run, item));
        return buildSummary(run, evidence.map((item) => item.result), evidence.map((item) => ({ ...item, run }))) as T;
      },
      put: (key, value) => runtime.artifacts.put(key, value),
    },
  };
}
