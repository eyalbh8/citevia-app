import {
  buildSummary,
  projectProviders,
  trackedUrlKey,
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
import { createScenarioTracking } from './demo-tracking.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = DAY * 7;
const PREFIX = 'demo/v1/';
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const iso = (at: number) => new Date(at).toISOString();
const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`);
const checkedMetadata = new WeakMap<DemoConfig, string>();

function validateMetadata(config: DemoConfig, projectId: string) {
  if (checkedMetadata.get(config) === projectId) return;
  const validText = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
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
  if (config.version !== 1 || !['igeo-nayax', 'igeo-dr-roof', 'website-demo'].includes(config.source) ||
      !Number.isFinite(day(config.startDate)) || !Number.isFinite(day(config.endDate)) ||
      day(config.endDate) < day(config.startDate) ||
      day(config.endDate) - day(config.startDate) > 366 * DAY)
    throw new Error('Invalid demo scenario configuration');
  demoNumericProfile(config);
  validateMetadata(config, project.id);
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
  scanTimeCache.set(project, times);
  return times;
}

function progress(project: Project, at: number) {
  const config = configFor(project)!;
  const phase = Math.max(0, Math.min(1,
    (at - day(config.startDate)) / Math.max(DAY, day(config.endDate) - day(config.startDate)),
  ));
  const curve = demoNumericProfile(config).growthCurve;
  return curve === 1 ? phase : phase ** curve;
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

/** Service scenarios retain annual growth while each pair of weekly scans moves. */
function weeklyMovement(project: Project, at: number) {
  if (!['igeo-dr-roof', 'website-demo'].includes(configFor(project)!.source)) return 0;
  const date = new Date(at);
  const minute = ((date.getUTCDay() + 6) % 7) * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes();
  const first = Math.min(...(project.scanSchedule?.slotsUtcMinutes || [600, 5640]));
  return minute === first ? -1 : 1;
}

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
  const profile = {
    openai: { baseline: 0.42, growth: 0.54, curve: 1 },
    perplexity: { baseline: 0.34, growth: 0.56, curve: 1.08 },
    gemini: { baseline: 0.28, growth: 0.58, curve: 1.18 },
  }[provider];
  const visibilityAdjustment = demoNumericProfile(configFor(project)!).visibilityAdjustment;
  for (const at of scanTimes(project)) {
    const phase = progress(project, at);
    const movement = weeklyMovement(project, at);
    const variation = movement * (1 + hash(`${project.id}:${provider}:weekly-mentions`) % 2);
    const mentionCount = Math.max(movement ? Math.min(1, prompts.length) : 0, Math.min(prompts.length - (movement ? 1 : 0),
      Math.floor(prompts.length * (profile.baseline + visibilityAdjustment + profile.growth * phase ** profile.curve)) + variation));
    // Legacy Nayax retains its original monotonic share. Service demos allow
    // modest weekly movement around the same improving annual sentiment curve.
    const positiveCount = movement
      ? Math.max(0, Math.min(mentionCount - 1, Math.floor(mentionCount * (0.3 + 0.66 * phase + movement * .04))))
      : Math.min(mentionCount, Math.max(
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

/** Stable prompt thresholds share the same scan movement across every report. */
function brandMeasurements(project: Project, run: ScanRun, prompt: Prompt): BrandAnalysis[] {
  const plan = measurementPlan(project, run.snapshot.provider!);
  const { phase, mentionCount, positiveCount } = plan.scans.get(Date.parse(run.scheduledAt))!;
  const index = plan.promptOrder.get(prompt.id)!;
  const mentioned = index < mentionCount;
  const movement = weeklyMovement(project, Date.parse(run.scheduledAt));
  const visibleCompetitors = project.competitors.filter((brand, competitorIndex) => {
    const threshold = (hash(`${prompt.id}:${brand.id}:${run.snapshot.provider}`) % 1000) / 1000;
    const seed = hash(`${project.id}:${brand.id}:${run.snapshot.provider}:weekly-mentions`);
    const variation = movement * (seed % 2 ? 1 : -1) * (.03 + (seed % 4) * .01);
    return threshold < 0.50 - 0.18 * phase - competitorIndex * 0.025 + variation;
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
    // Competitors remain credible references as the target's annual share grows.
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
      sentiment: visible
        ? movement && (hash(`${prompt.id}:${brand.id}:${run.snapshot.provider}:sentiment`) % 1000) / 1000 <
          .24 + movement * (hash(`${project.id}:${brand.id}:sentiment`) % 2 ? .07 : -.07)
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
}>();
const contentPickupCache = new WeakMap<Project, Map<string, { url: string; title: string }[]>>();

/** Enroll each service post in one scenario capture at its first subsequent scan. */
function contentPickups(project: Project, run: ScanRun, prompt: Prompt) {
  if (!['igeo-dr-roof', 'website-demo'].includes(configFor(project)!.source)) return [];
  let pickups = contentPickupCache.get(project);
  if (!pickups) {
    pickups = new Map();
    const providers = projectProviders(project), times = scanTimes(project);
    const tracked = [...(configFor(project)!.trackedUrls || [])]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.url.localeCompare(b.url));
    for (const [index, item] of tracked.entries()) {
      const enrolledAt = Math.max(Date.parse(item.createdAt || item.publishedAt), Date.parse(item.publishedAt));
      const at = times.find(at => at >= enrolledAt && (!item.trackingPeriods || item.trackingPeriods.some(period =>
        at >= Date.parse(period.start) && (!period.end || at < Date.parse(period.end)))));
      if (at === undefined || !providers.length) continue;
      const provider = providers[index % providers.length].provider;
      const plan = measurementPlan(project, provider), mentionCount = plan.scans.get(at)!.mentionCount;
      const order = index % Math.max(1, mentionCount);
      const promptId = [...plan.promptOrder].find(([, value]) => value === order)?.[0];
      if (!promptId) continue;
      const key = `${iso(at)}:${provider}:${promptId}`;
      const citations = pickups.get(key) || [];
      citations.push({ url: item.url, title: item.title });
      pickups.set(key, citations);
    }
    contentPickupCache.set(project, pickups);
  }
  return pickups.get(`${run.scheduledAt}:${run.snapshot.provider}:${prompt.id}`) || [];
}

function citationsFor(project: Project, run: ScanRun, prompt: Prompt): Citation[] {
  const tracked = configFor(project)!.trackedUrls || [];
  let trackedIndex = trackedCitationCache.get(project);
  if (!trackedIndex) {
    trackedIndex = { keys: new Set(tracked.map(item => trackedUrlKey(item.url))), eligible: new Map() };
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
      .filter(citation => !trackedIndex.keys.has(trackedUrlKey(citation.url)))
      .map(citation => ({ ...citation, title: citation.title || new URL(citation.url).hostname }));
    pools.set(prompt.id, unique);
  }
  const size = Math.min(unique.length, 1 + Math.floor(progress(project, Date.parse(run.scheduledAt)) * 5));
  const at = iso(Date.parse(run.scheduledAt));
  let eligible = trackedIndex.eligible.get(at);
  if (!eligible) {
    eligible = tracked.filter(item => (item.createdAt || item.publishedAt) <= at && item.publishedAt <= at);
    trackedIndex.eligible.set(at, eligible);
  }
  const base = unique.slice(0, size);
  base.push(...contentPickups(project, run, prompt));
  // Gradual pickup of enrolled content; the same citations drive every tracking view.
  if (eligible.length && hash(`${run.snapshot.provider}:${prompt.id}`) % 5 < 2) {
    const item = eligible[hash(`${run.id}:${prompt.id}:content`) % eligible.length];
    base.push({ url: item.url, title: item.title });
  }
  return [...new Map(base.map(item => [item.url, item])).values()].map((citation, index) => ({
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
  const excerpt = result.target?.mentioned ? sample?.answerText?.trim().slice(0, 1800) : undefined;
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
        citations: (run, prompt) => citationsFor(project, run, prompt),
        evidence: (run, prompt) => evidenceFor(project, run, prompt),
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
    async listTrackedUrls(projectId) {
      const project = await demoProject(projectId);
      return project ? trackingFor(project).listTrackedUrls() : runtime.repository.listTrackedUrls(projectId);
    },
    async listTrackingMatches(projectId, trackedUrlId) {
      const project = await demoProject(projectId);
      return project ? trackingFor(project).listTrackingMatches(trackedUrlId) : runtime.repository.listTrackingMatches(projectId, trackedUrlId);
    },
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
      return project ? aggregateScenarioTraffic(project, filters) : runtime.repository.aggregateTraffic(projectId, filters);
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
            firstSeenAt: iso(day(config.startDate)), lastSeenAt: last, trackerVersion: 'citevia-v1' }]; }
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
