import {
  usesDetailedReporting,
  buildSummary,
  domainForUrl,
  investingExpectedRank,
  usesModeledReporting,
  investingVisibilityRate,
  modeledBrandRate,
  projectProviders,
  trackedUrlKey,
  trackedArticleUrl,
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
} from '@citevia/core';
import type { Repository, Runtime, SavedAnalysisRef } from './contracts.js';
import { aggregateScenarioTraffic, demoNumericProfile } from './demo-traffic.js';
import { createScenarioTracking, reportingPublications } from './demo-tracking.js';
import { industrySources } from './demo-investing-sources.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = DAY * 7;
const PREFIX = 'demo/v1/';
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const iso = (at: number) => new Date(at).toISOString();
const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`);
const checkedMetadata = new WeakMap<DemoConfig, string>();

function validateMetadata(config: DemoConfig, project: Project) {
  const projectId = project.id;
  if (checkedMetadata.get(config) === projectId) return;
  if (config.companyDiscovery !== undefined && config.companyDiscovery !== true)
    throw new Error('Invalid company discovery scenario');
  const validText = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
  if (config.presentation) {
    const { label, targetRank, mentionCount, reportingOnly } = config.presentation;
    const rivals = project.competitors.slice(0, targetRank - 1);
    if (!validText(label, 160) || !Number.isInteger(targetRank) || targetRank < 2 || targetRank > 10 ||
      !Number.isInteger(mentionCount) || mentionCount < 1 || mentionCount > 50 || reportingOnly !== true ||
      rivals.length !== targetRank - 1 || new Set(rivals.map(brand => brand.id)).size !== rivals.length ||
      new Set(rivals.map(brand => brand.name.trim().toLowerCase())).size !== rivals.length ||
      rivals.some(brand => brand.id === project.brand.id || brand.name.trim().toLowerCase() === project.brand.name.trim().toLowerCase()))
      throw new Error('Invalid illustrative presentation configuration');
  }
  if (config.industry && (!validText(config.industry.label, 120) || !validText(config.industry.audience, 160) ||
    [config.industry.services, config.industry.criteria].some(items => !Array.isArray(items) || !items.length ||
      items.length > 10 || items.some(item => !validText(item, 160)))))
    throw new Error('Invalid demo industry context');
  if (config.copy && (!validText(config.copy.introduction, 1500) || !validText(config.copy.fallback, 1500) ||
    !validText(config.copy.positiveCompany, 800) || !/^\s/.test(config.copy.positiveCompany) ||
    config.copy.neutralCompany !== undefined && (!validText(config.copy.neutralCompany, 800) || !/^\s/.test(config.copy.neutralCompany))))
    throw new Error('Invalid demo answer copy');
  if (config.source === 'website-demo' && !config.industry && !config.copy)
    throw new Error('A website demo requires industry context or answer copy');
  for (const item of config.trackedUrls || []) {
    if (!item.demoPost) continue;
    let validUrl = false;
    try {
      const url = new URL(item.url), prefix = `/demo-content/${encodeURIComponent(projectId)}/`;
      validUrl = url.origin === 'https://app.citevia.io' && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.startsWith(prefix) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname.slice(prefix.length));
    } catch { /* invalid draft URL */ }
    const references = item.provenance?.sourceUrls;
    if (!validUrl || !validText(item.body, 1200) || item.provenance?.kind !== 'demo-draft' ||
      !Array.isArray(references) || !references.length || references.length > 10 || references.some(value => {
        try { const url = new URL(value); return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password; }
        catch { return true; }
      })) throw new Error('Invalid demo draft metadata');
  }
  checkedMetadata.set(config, projectId);
}

/** The persisted fixture is small; a year of measurements is derived, never inserted. */
function configFor(project: Project): DemoConfig | null {
  const config = project.demo;
  if (!config) return null;
  if (checkedMetadata.get(config) === project.id) return config;
  if (config.version !== 1 || !['igeo-nayax', 'igeo-dr-roof', 'website-demo'].includes(config.source) ||
      !Number.isFinite(day(config.startDate)) || !Number.isFinite(day(config.endDate)) ||
      !Number.isFinite(day(config.anchorDate)) || day(config.anchorDate) < day(config.startDate) ||
      day(config.anchorDate) > day(config.endDate) ||
      day(config.endDate) < day(config.startDate) ||
      day(config.endDate) - day(config.startDate) > 366 * DAY)
    throw new Error('Invalid demo scenario configuration');
  demoNumericProfile(config);
  validateMetadata(config, project);
  return config;
}

const answerCopyCache = new WeakMap<Project, Required<NonNullable<DemoConfig['copy']>>>();
function answerCopy(project: Project): Required<NonNullable<DemoConfig['copy']>> {
  const cached = answerCopyCache.get(project);
  if (cached) return cached;
  const config = configFor(project)!;
  const join = (values: string[]) => values.length < 3 ? values.join(' and ')
    : `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
  const industry = config.industry;
  const defaults = industry ? {
    introduction: `For ${industry.audience}, compare ${industry.label} providers by ${join(industry.criteria)}.`,
    positiveCompany: ` is a strong option for ${industry.audience} seeking ${join(industry.services)}.`,
    neutralCompany: ` is an established ${industry.label} provider to evaluate for ${join(industry.criteria)}.`,
    fallback: `Compare ${industry.label} providers by ${join(industry.criteria)}.`,
  } : config.source === 'igeo-dr-roof' ? {
    introduction: 'When comparing local roofing contractors, consider inspection quality, repair and replacement options, materials, warranty coverage, and local service.',
    positiveCompany: ' is a strong choice for homeowners seeking roof inspections, reliable repairs, and clear warranty coverage.',
    neutralCompany: ' is an established option to evaluate for this use case.',
    fallback: 'Compare roofing contractors by inspection quality, repair options, materials, warranty coverage, and local service.',
  } : {
    introduction: 'For unattended retail, compare payment acceptance, integration coverage, remote management, and support when selecting a platform.',
    positiveCompany: ' is a strong choice with growing adoption and a comprehensive payment platform.',
    neutralCompany: ' is an established option to evaluate for this use case.',
    fallback: 'Compare payment platforms by integration coverage, support, and total cost.',
  };
  const copy = { ...defaults, ...config.copy, neutralCompany: config.copy?.neutralCompany ?? defaults.neutralCompany };
  answerCopyCache.set(project, copy);
  return copy;
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
  if (usesModeledReporting(config) && times[0] !== start) times.unshift(start);
  scanTimeCache.set(project, times);
  return times;
}

interface CaptureSchedule {
  times: Map<string, number>;
  last: number;
}
const captureScheduleCache = new WeakMap<Project, Map<ScanProvider, Map<number, CaptureSchedule>>>();

function captureRotation(project: Project, provider: ScanProvider) {
  if (!usesDetailedReporting(project.demo)) return 'openai';
  const profile = project.demo.reportingProfile;
  return profile === 'merchant_payments' || profile === 'residential_roofing' ? 'openai' : provider;
}

/** Collect each prompt once per run, with answers arriving throughout its UTC collection window. */
function captureSchedule(project: Project, at: number, provider: ScanProvider = 'openai'): CaptureSchedule {
  const rotation = captureRotation(project, provider);
  let providers = captureScheduleCache.get(project);
  if (!providers) {
    providers = new Map();
    captureScheduleCache.set(project, providers);
  }
  let schedules = providers.get(rotation);
  if (!schedules) {
    schedules = new Map();
    providers.set(rotation, schedules);
  }
  const cached = schedules.get(at);
  if (cached) return cached;
  const prompts = activePrompts(project);
  const times = new Map<string, number>();
  let last = at;
  if (usesModeledReporting(project.demo)) {
    const starts = scanTimes(project);
    const until = starts[starts.indexOf(at) + 1] ?? day(project.demo.endDate) + DAY;
    const ordered = [...prompts].sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
    if (usesDetailedReporting(project.demo)) {
      // Interleave the funnel stages so a short collection window samples each stage.
      const byStage = new Map<Prompt['stage'], Prompt[]>();
      for (const prompt of ordered) {
        const group = byStage.get(prompt.stage) ?? [];
        group.push(prompt);
        byStage.set(prompt.stage, group);
      }
      // Offset each engine within its stage. For a stage containing just two
      // prompts, this distributes six distinct captures across the collection.
      const shift = { openai: 0, perplexity: 1 / 3, gemini: 2 / 3 }[rotation];
      const position = new Map<string, number>();
      for (const group of byStage.values()) {
        group.forEach((prompt, index) => position.set(prompt.id, (index + shift) / group.length));
      }
      ordered.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    }
    for (const [index, prompt] of ordered.entries()) {
      const sample = at + Math.floor(index * (until - at) / ordered.length);
      const utcDay = Math.floor(sample / DAY) * DAY;
      // The first collection on a new date is available from the start of that reporting day.
      last = utcDay > last ? utcDay : sample;
      times.set(prompt.id, last);
    }
  } else {
    for (const [index, prompt] of prompts.entries()) {
      last = at + index * 1000;
      times.set(prompt.id, last);
    }
  }
  const schedule = { times, last };
  schedules.set(at, schedule);
  return schedule;
}

function progress(project: Project, at: number) {
  const config = configFor(project)!;
  const phase = Math.max(0, Math.min(1,
    (at - day(config.startDate)) / Math.max(DAY, day(config.endDate) - day(config.startDate)),
  ));
  const curve = demoNumericProfile(config).growthCurve;
  return curve === 1 ? phase : phase ** curve;
}

/** Most prompt cohorts lead by the saved anchor, with the final few improving afterward. */
function rankImprovement(project: Project, at: number) {
  const phase = progress(project, at);
  const anchor = progress(project, day(configFor(project)!.anchorDate));
  // Inclusive date bounds also support the one-day scenarios used for website previews.
  const historical = Math.min(1, phase / Math.max(Number.EPSILON, anchor));
  const projected = Math.max(0, (phase - anchor) / Math.max(Number.EPSILON, 1 - anchor));
  return historical * 5.925 + projected * .075;
}

function runId(at: number, provider: ScanProvider) {
  return `run_demo_${iso(at).slice(0, 16).replace(/[-:]/g, '')}_${provider}`;
}

function artifactKey(project: Project, run: ScanRun, prompt: Prompt, kind: 'capture' | 'analysis') {
  return `${PREFIX}${encodeURIComponent(project.id)}/${run.id}/${encodeURIComponent(prompt.id)}/${kind}.json`;
}

function runCompletedAt(project: Project, at: number) {
  return Math.max(at + 120_000, captureSchedule(project, at).last + 1000);
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
    completedAt: iso(runCompletedAt(project, at)),
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
    deadlineAt: iso((usesModeledReporting(project.demo) ? captureSchedule(project, at).last : at) + HOUR),
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

/** Single-scan reads may reach the current collection through an answer's run ID. */
function collectingPrompts(project: Project, run: ScanRun, asOf: number) {
  const start = Date.parse(run.scheduledAt);
  if (!usesModeledReporting(project.demo) || start > asOf || Date.parse(run.completedAt!) <= asOf)
    return null;
  const schedule = captureSchedule(project, start, run.snapshot.provider);
  return activePrompts(project).filter(prompt => schedule.times.get(prompt.id)! <= asOf);
}

const measurementPlans = new WeakMap<Project, Map<ScanProvider, {
  promptOrder: Map<string, number>;
  scans: Map<number, { phase: number; mentionCount: number; positiveStart: number; ranks: Map<string, number> }>;
}>>();

function measurementPlan(project: Project, provider: ScanProvider) {
  let providers = measurementPlans.get(project);
  if (!providers) { providers = new Map(); measurementPlans.set(project, providers); }
  const cached = providers.get(provider);
  if (cached) return cached;
  const prompts = activePrompts(project);
  // Providers share nested cohorts, so added provider coverage cannot introduce
  // an unrelated lower-performing cohort into combined-period comparisons.
  const ordered = [...prompts].sort((a, b) =>
    hash(`${project.id}:${a.id}`) - hash(`${project.id}:${b.id}`) || a.id.localeCompare(b.id),
  );
  if (configFor(project)!.dashboardComparison === 'scenario_start') {
    // Spread the growing cohort across stages instead of saturating one stage at the outset.
    const groups = [...new Set(ordered.map(prompt => prompt.stage || 'unassigned'))]
      .map(stage => ordered.filter(prompt => (prompt.stage || 'unassigned') === stage));
    ordered.splice(0, ordered.length, ...Array.from({ length: Math.max(...groups.map(group => group.length)) },
      (_, index) => groups.flatMap(group => group[index] ? [group[index]] : [])).flat());
  }
  const plan = { promptOrder: new Map(ordered.map((prompt, index) => [prompt.id, index])),
    scans: new Map<number, { phase: number; mentionCount: number; positiveStart: number; ranks: Map<string, number> }>() };
  let previousCount = 0, previousPositive = 0, previousPositiveStart = prompts.length;
  let previousRanks = new Map<string, number>();
  let initialNeutral: number | undefined;
  const profile = {
    openai: { baseline: 0.42, growth: 0.54, curve: 1 },
    perplexity: { baseline: 0.34, growth: 0.56, curve: 1.08 },
    gemini: { baseline: 0.28, growth: 0.58, curve: 1.18 },
  }[provider];
  const visibilityAdjustment = demoNumericProfile(configFor(project)!).visibilityAdjustment;
  for (const at of scanTimes(project)) {
    const phase = progress(project, at);
    // Retain a growing cohort instead of alternating the two weekly scan slots.
    // A date range can begin on either slot: a weekly sawtooth otherwise turns
    // a successful scenario into a decline for arbitrary/custom date bounds.
    const mentionCount = Math.min(prompts.length, Math.max(previousCount,
      Math.floor(prompts.length * (profile.baseline + visibilityAdjustment + profile.growth * phase ** profile.curve))));
    const positiveCount = Math.min(mentionCount, Math.max(
      Math.ceil(mentionCount * (0.3 + 0.66 * phase)),
      previousCount ? Math.ceil(mentionCount * previousPositive / previousCount - 1e-10) : 0,
    ));
    // New mention cohorts enter with positive sentiment rather than diluting
    // a prompt's existing provider scores. Existing positive cohorts stay
    // positive as the historical sentiment curve improves.
    initialNeutral ??= mentionCount - positiveCount;
    const positiveStart = Math.min(previousPositiveStart, mentionCount - positiveCount,
      Math.ceil(initialNeutral * (1 - phase)));
    // A newly mentioned prompt must not dilute the average by entering below
    // established cohorts. Sparse source catalogs can constrain earlier ranks,
    // so cap entrants at the best established rank. This also keeps filtered
    // prompt cohorts from regressing when visibility expands.
    const desiredRank = (prompt: Prompt, index: number) => Math.min(
      1 + Math.min(...projectProviders(project).map(({ provider }) =>
        visibleCompetitorsFor(project, provider, prompt, phase).length)) + sourceCompanies(project).length,
      Math.max(1, 7 - Math.floor(rankImprovement(project, at) + index / Math.max(1, prompts.length))),
    );
    const ranks = new Map(ordered.slice(0, previousCount).map((prompt, index) =>
      [prompt.id, Math.min(previousRanks.get(prompt.id)!, desiredRank(prompt, index))] as const));
    const entryRank = ranks.size ? Math.min(...ranks.values()) : Infinity;
    for (let index = previousCount; index < mentionCount; index++)
      ranks.set(ordered[index].id, Math.min(entryRank, desiredRank(ordered[index], index)));
    plan.scans.set(at, { phase, mentionCount, positiveStart, ranks });
    previousRanks = ranks;
    previousCount = mentionCount;
    previousPositive = positiveCount;
    previousPositiveStart = positiveStart;
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

const presentationOrderCache = new WeakMap<Project, Map<string, number>>();
/** Shared, rotating blocks cover every prompt without increasing total mentions. */
function presentationMeasurements(project: Project, run: ScanRun, prompt: Prompt): BrandAnalysis[] {
  const presentation = configFor(project)!.presentation!;
  const prompts = activePrompts(project);
  let order = presentationOrderCache.get(project);
  if (!order) {
    const sorted = [...prompts].sort((a, b) => hash(`${project.id}:${a.id}`) - hash(`${project.id}:${b.id}`) || a.id.localeCompare(b.id));
    order = new Map(sorted.map((item, index) => [item.id, index]));
    presentationOrderCache.set(project, order);
  }
  const providers = projectProviders(project);
  const scanIndex = scanTimes(project).indexOf(Date.parse(run.scheduledAt));
  const providerIndex = providers.findIndex(item => item.provider === run.snapshot.provider);
  const count = Math.min(prompts.length, presentation.mentionCount);
  const offset = (scanIndex * providers.length + providerIndex) * count % Math.max(1, prompts.length);
  const mentioned = (order.get(prompt.id)! - offset + prompts.length) % Math.max(1, prompts.length) < count;
  const measurement = (brandId: string, visible: boolean, rank: number): BrandAnalysis => ({
    brandId, mentioned: visible,
    explicitRank: visible ? rank : null, appearanceRank: visible ? rank : null, mentionOrder: visible ? rank : null,
    sentiment: visible ? 'neutral' : 'not_applicable', evidence: [], rankEvidence: null, sentimentEvidence: null,
  });
  return [measurement(project.brand.id, mentioned, presentation.targetRank),
    ...project.competitors.map((brand, index) => measurement(brand.id, index < presentation.targetRank - 1, index + 1))];
}

function visibleCompetitorsFor(project: Project, provider: ScanProvider, prompt: Prompt, phase: number, modeledTargetRate?: number) {
  return project.competitors.filter((brand, index) =>
    (hash(`${prompt.id}:${brand.id}:${provider}`) % 1000) / 1000 <
      (modeledTargetRate === undefined ? .50 - .30 * phase - index * .025 : modeledBrandRate(modeledTargetRate, index)));
}

/** The target, competitors and answer evidence all use these per-scan measurements. */
function brandMeasurements(project: Project, run: ScanRun, prompt: Prompt): BrandAnalysis[] {
  if (configFor(project)!.presentation) return presentationMeasurements(project, run, prompt);
  const plan = measurementPlan(project, run.snapshot.provider!);
  const { phase, mentionCount, positiveStart, ranks } = plan.scans.get(Date.parse(run.scheduledAt))!;
  const index = plan.promptOrder.get(prompt.id)!;
  let mentioned = index < mentionCount;
  let positive = index >= positiveStart;
  let rank = ranks.get(prompt.id) ?? 1;
  const at = Date.parse(run.scheduledAt), provider = run.snapshot.provider!;
  const rate = usesModeledReporting(project.demo) ? investingVisibilityRate(project.demo, prompt.id, provider, at) : undefined;
  const modeledTargetRate = usesDetailedReporting(project.demo) ? rate : undefined;
  const visibleCompetitors = visibleCompetitorsFor(project, provider, prompt, phase, modeledTargetRate);
  if (rate !== undefined) {
    const scan = scanTimes(project).indexOf(at);
    const providerPhase = { openai: 0, perplexity: 1 / 3, gemini: 2 / 3 }[provider];
    // Space providers evenly across a scan, then rotate from one scan to the next.
    // Each prompt can gain coverage independently as its expected visibility rises.
    const sample = (salt: string, stride: number) =>
      (hash(`${prompt.id}:${salt}`) / 4294967296 + providerPhase + scan * stride) % 1;
    mentioned = sample('visibility', .61803398875) < rate;
    // Keep each provider's view of the prompt consistent as its rank and sentiment improve.
    positive = sample('sentiment', 0) < rate;
    const expectedRank = investingExpectedRank(rate);
    rank = Math.min(1 + visibleCompetitors.length + sourceCompanies(project).length,
      Math.floor(expectedRank) + Number(sample('rank', 0) < expectedRank % 1));
  }
  if (configFor(project)!.companyDiscovery && !mentioned && !visibleCompetitors.length && project.competitors.length)
    visibleCompetitors.push(project.competitors[hash(`${project.id}:${run.snapshot.provider}:${prompt.id}:discovery`) % project.competitors.length]);
  const target: BrandAnalysis = {
    brandId: project.brand.id,
    mentioned,
    explicitRank: mentioned ? rank : null,
    appearanceRank: mentioned ? rank : null,
    mentionOrder: mentioned ? rank : null,
    sentiment: mentioned ? positive ? 'positive' : 'neutral' : 'not_applicable',
    evidence: [],
    rankEvidence: null,
    sentimentEvidence: null,
  };
  let nextPosition = 1;
  return [target, ...project.competitors.map((brand, index): BrandAnalysis => {
    // Competitors remain credible references as the target's annual share grows.
    const visible = visibleCompetitors.includes(brand);
    if (mentioned && nextPosition === rank) nextPosition++;
    const position = nextPosition;
    const positiveRate = modeledTargetRate === undefined ? .24 + phase * .12 : modeledBrandRate(modeledTargetRate, index);
    if (visible) nextPosition++;
    return {
      brandId: brand.id,
      mentioned: visible,
      explicitRank: visible ? position : null,
      appearanceRank: visible ? position : null,
      mentionOrder: visible ? position : null,
      sentiment: visible
        ? (hash(`${prompt.id}:${brand.id}:${run.snapshot.provider}:sentiment`) % 1000) / 1000 < positiveRate
          ? 'positive' : 'neutral'
        : 'not_applicable',
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
const trackedCitationCache = new WeakMap<Project, {
  keys: Set<string | null>;
  eligible: Map<string, NonNullable<DemoConfig['trackedUrls']>>;
  references: NonNullable<DemoConfig['referenceSources']>;
}>();
const contentPickupCache = new WeakMap<Project, Map<string, { url: string; title: string }[]>>();
type TrackedPublication = NonNullable<DemoConfig['trackedUrls']>[number];

function enrolledForCapture(item: TrackedPublication, at: string) {
  return (item.createdAt || item.publishedAt) <= at && item.publishedAt <= at &&
    (!item.trackingPeriods || item.trackingPeriods.some(period => period.start <= at && (!period.end || at < period.end)));
}

function pickupWindows(project: Project, provider: ScanProvider, scanAt: number, firstDayOnly: boolean, item?: TrackedPublication) {
  const twiceDaily = usesDetailedReporting(project.demo);
  const windows = new Map<number, string[]>();
  for (const [promptId, captured] of captureSchedule(project, scanAt, provider).times) {
    if (item && !enrolledForCapture(item, iso(captured))) continue;
    if (firstDayOnly && Math.floor(captured / DAY) !== Math.floor(scanAt / DAY)) continue;
    // One actual answer in each half-day keeps enrolled content visible in a rolling 24-hour report.
    const window = twiceDaily ? Math.floor(captured / (12 * HOUR)) : scanAt;
    const candidates = windows.get(window) || [];
    candidates.push(promptId);
    windows.set(window, candidates);
  }
  return windows;
}

/** Enroll each post at its first scan; aligned demos retain citations in subsequent scans. */
function contentPickups(project: Project, run: ScanRun, prompt: Prompt) {
  let pickups = contentPickupCache.get(project);
  if (!pickups) {
    pickups = new Map();
    const providers = projectProviders(project), times = scanTimes(project);
    const commonWindows = new Map<string, ReturnType<typeof pickupWindows>>();
    const tracked = [...reportingPublications(project)]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.url.localeCompare(b.url));
    const partialCollections = usesDetailedReporting(project.demo) && project.demo.reportingProfile !== 'merchant_payments';
    for (const [index, item] of tracked.entries()) {
      const enrolledAt = Math.max(Date.parse(item.createdAt || item.publishedAt), Date.parse(item.publishedAt));
      const eligible = times.filter(at => {
        // Articles enrolled during a collection are eligible for subsequent captures in that run.
        const last = partialCollections ? captureSchedule(project, at).last : at;
        return last >= enrolledAt && (!item.trackingPeriods || item.trackingPeriods.some(period =>
          last >= Date.parse(period.start) && (!period.end || at < Date.parse(period.end))));
      });
      if (!eligible.length || !providers.length) continue;
      const provider = providers[index % providers.length].provider;
      for (const at of configFor(project)!.publicationAlignment === 'scans' ? eligible : eligible.slice(0, 1)) {
        let promptIds: string[];
        if (usesModeledReporting(project.demo)) {
          const firstDayOnly = !usesDetailedReporting(project.demo) && at === eligible[0];
          const key = `${at}:${firstDayOnly}:${captureRotation(project, provider)}`;
          const partialWindow = item.trackingPeriods || at < enrolledAt;
          let windows = partialWindow ? undefined : commonWindows.get(key);
          if (!windows) {
            // Captures after an eligible scan remain enrolled unless the URL has an explicit pause.
            windows = pickupWindows(project, provider, at, firstDayOnly, partialWindow ? item : undefined);
            if (!partialWindow) commonWindows.set(key, windows);
          }
          promptIds = [...windows].map(([window, candidates]) => candidates[hash(`${item.url}:${window}`) % candidates.length]);
        } else {
          const plan = measurementPlan(project, provider), mentionCount = plan.scans.get(at)!.mentionCount;
          const order = index % Math.max(1, mentionCount);
          const prompt = [...plan.promptOrder].find(([, value]) => value === order);
          promptIds = prompt ? [prompt[0]] : [];
        }
        for (const id of promptIds) {
          const key = `${iso(at)}:${provider}:${id}`;
          const citations = pickups.get(key) || [];
          citations.push({ url: item.url, title: item.title });
          pickups.set(key, citations);
        }
      }
    }
    contentPickupCache.set(project, pickups);
  }
  return pickups.get(`${run.scheduledAt}:${run.snapshot.provider}:${prompt.id}`) || [];
}

function citationsFor(project: Project, run: ScanRun, prompt: Prompt): Citation[] {
  const tracked = reportingPublications(project);
  let trackedIndex = trackedCitationCache.get(project);
  if (!trackedIndex) {
    const keys = new Set(tracked.map(item => trackedUrlKey(item.url)));
    const references = (project.demo?.referenceSources ?? []).filter(item => {
      const key = trackedUrlKey(item.url);
      return key && !keys.has(key);
    });
    trackedIndex = { keys, eligible: new Map(), references };
    trackedCitationCache.set(project, trackedIndex);
  }
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
    unique = [...new Map(candidates.map((citation) => [citation.url, citation])).values()]
      .filter(citation => !trackedIndex.keys.has(trackedUrlKey(citation.url)) && domainForUrl(citation.url) !== 'reddit.com')
      .map(citation => ({ ...citation, title: citation.title || new URL(citation.url).hostname }));
    pools.set(prompt.id, unique);
  }
  const size = Math.min(unique.length, 1 + Math.floor(progress(project, Date.parse(run.scheduledAt)) * 5));
  const at = usesModeledReporting(project.demo)
    ? iso(captureSchedule(project, Date.parse(run.scheduledAt), run.snapshot.provider).times.get(prompt.id)!)
    : run.scheduledAt;
  let eligible = trackedIndex.eligible.get(at);
  if (!eligible) {
    eligible = tracked.filter(item => enrolledForCapture(item, at));
    trackedIndex.eligible.set(at, eligible);
  }
  // Source tiers are encoded in answer citations, so the Sources rows, answer
  // drawer and dashboard all reconcile. The owned site leads (every answer),
  // Reddit appears in 90% of the stable prompt cohort, and the remaining
  // researched sources rotate within half the cohort. Discovery citations and
  // tracked-content pickups below remain attached to their actual answers.
  const index = measurementPlan(project, run.snapshot.provider!).promptOrder.get(prompt.id)!;
  const count = activePrompts(project).length;
  const base = index < Math.floor(count / 2) ? unique.slice(0, size) : [];
  if (trackedIndex.references.length) base.push(trackedIndex.references[index % trackedIndex.references.length]);
  const officialDomain = project.brand.domains[0];
  if (officialDomain) {
    const origin = new URL(/^https?:\/\//.test(officialDomain) ? officialDomain : `https://${officialDomain}`).origin;
    base.push({ url: `${origin}/`, title: project.brand.name });
  }
  if (index < Math.max(1, Math.floor(count * .9)))
    base.push({ url: 'https://www.reddit.com/', title: 'Reddit community discussions' });
  if (configFor(project)!.companyDiscovery) {
    const mentioned = brandMeasurements(project, run, prompt).find(brand => brand.mentioned);
    const brand = [project.brand, ...project.competitors].find(brand => brand.id === mentioned?.brandId);
    if (brand?.domains[0]) base.push({ url: `https://${brand.domains[0]}/`, title: brand.name });
  }
  base.push(...contentPickups(project, run, prompt));
  // Gradual pickup of enrolled content; the same citations drive every tracking view.
  if (eligible.length && hash(`${run.snapshot.provider}:${prompt.id}`) % 5 < 2) {
    const item = eligible[hash(`${run.id}:${prompt.id}:content`) % eligible.length];
    base.push({ url: item.url, title: item.title });
  }
  const citations: Citation[] = [...new Map(base.map(item => [item.url, item])).values()].map((citation, index) => ({
    id: `citation_${index + 1}`, blockId: 'answer', url: trackedArticleUrl(citation.url),
    title: citation.title || new URL(citation.url).hostname, start: null, end: null,
  }));
  return project.demo?.reportingProfile
    ? citations.concat(industrySources(project.demo.reportingProfile, activePrompts(project), prompt.id))
    : citations;
}

function resultFor(project: Project, run: ScanRun, prompt: Prompt, citations = citationsFor(project, run, prompt)): PromptResult {
  const brands = brandMeasurements(project, run, prompt);
  const captured = captureSchedule(project, Date.parse(run.scheduledAt), run.snapshot.provider).times.get(prompt.id)!;
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
    capturedAt: iso(captured),
    completedAt: iso(captured + 1000),
    model: run.snapshot.generationModel,
    usage: emptyUsage(), extractionUsage: emptyUsage(), expiresAt: run.expiresAt,
  };
}

function evidenceFor(project: Project, run: ScanRun, prompt: Prompt, citations = citationsFor(project, run, prompt)) {
  const result = resultFor(project, run, prompt, citations);
  const sample = sampleFor(project, prompt);
  const names = new Map([project.brand, ...project.competitors].map((brand) => [brand.id, brand.name]));
  const companies = result.brands!.filter((brand) => brand.mentioned).map((brand) => ({
    name: names.get(brand.brandId)!, rank: brand.appearanceRank!,
    sentiment: brand.sentiment === 'not_applicable' ? 'unknown' as const : brand.sentiment,
    brandId: brand.brandId,
  }));
  const available = sourceCompanies(project);
  const copy = answerCopy(project);
  const lastRank = Math.max(0, ...companies.map((company) => company.rank), Math.min(3, companies.length + available.length));
  let fillerIndex = 0;
  for (let rank = 1; rank <= lastRank; rank++)
    if (!companies.some((company) => company.rank === rank) && fillerIndex < available.length)
      companies.push({ name: available[fillerIndex++], rank, sentiment: 'neutral', brandId: '' });
  companies.sort((a, b) => a.rank - b.rank);
  const sentences = companies.map((company) =>
    `${company.rank}. ${company.name}${company.sentiment === 'positive' ? copy.positiveCompany : copy.neutralCompany}`,
  );
  const selection = sentences.join('\n');
  // The source excerpt is a reusable illustration, not a second provider call.
  const presentation = configFor(project)!.presentation;
  const excerpt = !presentation && result.target?.mentioned ? sample?.answerText?.trim().slice(0, 1800) : undefined;
  const text = [
    copy.introduction,
    selection || copy.fallback,
    excerpt || '',
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
  const answer: CapturedAnswer = {
    provider: run.snapshot.provider,
    providerResponseId: `demo_${result.responseId}`,
    model: run.snapshot.generationModel,
    status: 'completed',
    blocks: [{ id: 'answer', text }], text, citations,
    sources: citations.map(({ url, title }) => ({ url, title })),
    usage: emptyUsage(), createdAt: result.capturedAt!,
    raw: { demo: true, source: configFor(project)!.source, projection: result.capturedAt! > `${configFor(project)!.anchorDate}T23:59:59.999Z`,
      ...(presentation ? { illustrative: true, presentation } : {}) },
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
    ...(presentation ? { raw: { illustrative: true, presentation } } : {}),
  };
  return { result, answer, analysis };
}

function* observedRuns(project: Project, start: string, end: string, promptId?: string) {
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return;
  const prompts = activePrompts(project).filter((prompt) => !promptId || prompt.id === promptId);
  for (const at of scanTimes(project)) {
    if (at > to) break;
    if (captureSchedule(project, at).last < from) continue;
    for (const { provider } of projectProviders(project)) {
      const schedule = captureSchedule(project, at, provider);
      const observed = prompts.filter(prompt => {
        const captured = schedule.times.get(prompt.id)!;
        return captured >= from && captured <= to;
      });
      if (!observed.length) continue;
      const run = createRun(project, at, provider);
      yield { run, observed, schedule };
    }
  }
}

function historyFor(project: Project, start: string, end: string, promptId?: string): PromptHistory {
  const results: PromptResult[] = [], runs: ScanRun[] = [];
  for (const { run, observed } of observedRuns(project, start, end, promptId)) {
    runs.push(run);
    results.push(...observed.map(prompt => resultFor(project, run, prompt)));
  }
  return { runs, results };
}

/**
 * Scope virtual reads to an explicitly marked saved project. Authentication and
 * membership stay on the real repository; ordinary projects pass through.
 */
export function withDemoRuntime(runtime: Runtime, now: () => Date = () => new Date()): Runtime {
  const projects = new Map<string, { until: number; value: Promise<Project | null> }>();
  const tracking = new WeakMap<Project, ReturnType<typeof createScenarioTracking>>();
  const trackingFor = (project: Project) => {
    let value = tracking.get(project);
    if (!value) {
      value = createScenarioTracking(project, {
        history: (start, end) => historyFor(project, start, end),
        *captures(start, end) {
          for (const { run, observed, schedule } of observedRuns(project, start, end))
            for (const prompt of observed) yield { run, prompt, capturedAt: iso(schedule.times.get(prompt.id)!) };
        },
        citations: (run, prompt) => citationsFor(project, run, prompt),
        evidence: (run, prompt, citations) => evidenceFor(project, run, prompt, citations),
      });
      tracking.set(project, value);
    }
    return value;
  };
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
    async saveProject(project, expectedVersion) {
      const saved = await runtime.repository.saveProject(project, expectedVersion);
      if (saved) projects.delete(project.id);
      return saved;
    },
    async listTrackedUrls(projectId) {
      const project = await demoProject(projectId);
      return project && !project.demo!.presentation?.reportingOnly ? trackingFor(project).listTrackedUrls() : runtime.repository.listTrackedUrls(projectId);
    },
    async listTrackingMatches(projectId, trackedUrlId, options) {
      const project = await demoProject(projectId);
      return project && !project.demo!.presentation?.reportingOnly ? trackingFor(project).listTrackingMatches(trackedUrlId, options) : runtime.repository.listTrackingMatches(projectId, trackedUrlId, options);
    },
    async listRuns(projectId, limit = 60) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listRuns(projectId, limit);
      const latest = now().getTime();
      return scanTimes(project).filter(at => (usesModeledReporting(project.demo)
        ? runCompletedAt(project, at) : at) <= latest).reverse()
        .flatMap((at) => projectProviders(project).map(({ provider }) => createRun(project, at, provider)))
        .slice(0, Math.max(0, limit));
    },
    async getRun(projectId, id) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.getRun(projectId, id);
      const run = findRun(project, id);
      if (!run) return project.demo!.presentation && !id.startsWith('run_demo_') ? runtime.repository.getRun(projectId, id) : null;
      const collected = collectingPrompts(project, run, now().getTime());
      return collected ? { ...run, status: 'running', terminalCount: collected.length, succeededCount: collected.length,
        capturedCount: collected.length, resultVersion: collected.length, completedAt: undefined, summaryKey: undefined,
        summaryVersion: undefined } : run;
    },
    async listResults(projectId, id) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.listResults(projectId, id);
      const run = findRun(project, id);
      if (!run && project.demo!.presentation && !id.startsWith('run_demo_')) return runtime.repository.listResults(projectId, id);
      return run ? (collectingPrompts(project, run, now().getTime()) ?? activePrompts(project)).map(prompt => resultFor(project, run, prompt)) : [];
    },
    async getResult(projectId, id, promptId) {
      const project = await demoProject(projectId);
      if (!project) return runtime.repository.getResult(projectId, id, promptId);
      const run = findRun(project, id), prompt = activePrompts(project).find((item) => item.id === promptId);
      if (!run && project.demo!.presentation && !id.startsWith('run_demo_')) return runtime.repository.getResult(projectId, id, promptId);
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
      if (project.demo!.presentation) items.push(...await runtime.repository.listNativeCitations(projectId,
        captureKeys.filter(captureKey => !captureKey.slice(captureKey.indexOf(':') + 1).startsWith(PREFIX))));
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
      if (project.demo!.presentation) items.push(...await runtime.repository.listSavedAnalyses(projectId,
        refs.filter(ref => !ref.captureKey.startsWith(PREFIX))));
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
      const observed = await runtime.repository.aggregateTraffic(projectId, filters);
      return project && !project.demo!.presentation?.reportingOnly ? aggregateScenarioTraffic(project, filters, observed) : observed;
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
