import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateDashboardOverview, metricsFromResults,
  type Analysis, type CapturedAnswer, type DemoConfig, type Project,
  type PromptHistory, type PromptResult, type RunSummary, type ScanRun,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { buildServiceDemo, type ServiceDemoSource } from '../scripts/create-service-demo.js';
import { newProject } from './fixtures/scanner.js';

const DAY = 86_400_000;
const now = () => new Date('2026-10-28T12:00:00.000Z');
const sourceDirectory = new URL('../scripts/demo-sources/', import.meta.url);
const websiteProjects = readdirSync(sourceDirectory).filter(name => name.endsWith('.json')).flatMap(name => {
  const source = JSON.parse(readFileSync(new URL(name, sourceDirectory), 'utf8')) as ServiceDemoSource | ServiceDemoSource[];
  return (Array.isArray(source) ? source : [source]).map(value => buildServiceDemo(value, now().toISOString()));
});

function fixture(name: string, domain: string, source: DemoConfig['source'], industry?: string): Project {
  const project = newProject({ id: `ranking-${domain}`, name, brand: name, domain });
  return {
    ...project, enabled: false,
    scanProviders: ['openai', 'perplexity', 'gemini'].map(provider => ({ provider: provider as 'openai' | 'perplexity' | 'gemini', model: 'saved-source' })),
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source, sourceAccountId: domain, sourceCopiedAt: now().toISOString(),
      startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25',
      ...(industry ? { industry: { label: industry, audience: 'customers', services: [industry], criteria: ['service quality'] } } : {}),
      samples: [{ answerText: `${name} provides services for customers.`,
        companies: Array.from({ length: 8 }, (_, index) => `Source alternative ${index + 1}`) }],
    },
  };
}

const projects = [
  ...websiteProjects,
  fixture('All American Gutter Protection', 'allamericangutterprotection.com', 'website-demo', 'gutter protection'),
  fixture('Acme Locksmith', 'acmelocksmith.com', 'website-demo', 'locksmith services'),
  fixture('Freedom Power', 'gofreedompower.com', 'website-demo', 'electricity plans'),
  fixture('WindowWorks', 'mywindowworks.com', 'website-demo', 'window replacement'),
  fixture('Nayax legacy', 'nayax.com', 'igeo-nayax'),
  fixture('Dr. Roof', 'drroof.com', 'igeo-dr-roof'),
];

async function setup(project: Project) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  return { base: { repository, artifacts, queue }, runtime: withDemoRuntime({ repository, artifacts, queue }, now) };
}

function distribution(results: PromptResult[]) {
  const ranks = results.flatMap(result => result.target?.mentioned ? [result.target.appearanceRank!] : []);
  expect(ranks.length).toBeGreaterThan(0);
  return {
    mean: ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length,
    first: ranks.filter(rank => rank === 1).length / ranks.length,
    visibility: ranks.length / results.length,
    worst: Math.max(...ranks),
  };
}

function providerResults(history: PromptHistory, provider: string) {
  const runs = new Set(history.runs.filter(run => run.snapshot.provider === provider).map(run => run.id));
  return history.results.filter(result => runs.has(result.runId));
}

describe('demo ranking progression', () => {
  it.each(projects)('$name leads by its anchor and improves from historical to projected measurements', async project => {
    const { base, runtime } = await setup(project);
    const config = project.demo!;
    const start = Date.parse(config.startDate), anchor = Date.parse(config.anchorDate), end = Date.parse(config.endDate);
    const periods = [start, start + (anchor - start) / 2, anchor, end - 7 * DAY].map(at => ({
      start: new Date(at).toISOString(), end: new Date(Math.min(end + DAY - 1, at + 7 * DAY - 1)).toISOString(),
      granularity: 'daily' as const, timezone: 'UTC' as const,
    }));
    const histories = [];
    for (const period of periods) histories.push(await runtime.repository.listPromptHistory(project.id, period.start, period.end));
    for (const provider of ['openai', 'perplexity', 'gemini']) {
      const values = histories.map(history => distribution(providerResults(history, provider)));
      expect(values[2].mean).toBeLessThan(values[0].mean);
      expect(values[2].mean).toBeLessThan(values[1].mean);
      expect(values[3].mean).toBeLessThanOrEqual(values[2].mean);
      expect(values[2].first, `${provider} first place at anchor`).toBeGreaterThanOrEqual(.75);
      expect(values[2].worst).toBeLessThanOrEqual(2);
      expect(values[3].first, `${provider} projected first place`).toBeGreaterThanOrEqual(.9);
      expect(values[3].mean).toBeLessThan(values[0].mean);
      expect(values[3].visibility).toBeGreaterThan(values[0].visibility);
    }
    const history = histories[2], runs = new Map(history.runs.map(run => [run.id, run]));
    expect(distribution(history.results).first).toBeGreaterThanOrEqual(.8);
    const overview = aggregateDashboardOverview(project, periods[2],
      { providers: [], region: '', tag: '', branded: '', intent: '', search: '' },
      history.results.map(result => ({ result, run: runs.get(result.runId)! })),
    );
    expect(overview.ranking[0]).toMatchObject({ isTarget: true, rank: 1 });
    for (const result of histories.flatMap(history => history.results)) {
      const ranks = result.brands!.flatMap(brand => brand.mentioned ? [brand.appearanceRank!] : []);
      expect(new Set(ranks).size).toBe(ranks.length);
    }
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect(base.artifacts.values.size).toBe(0);
    expect(base.queue.messages).toEqual([]);
  });

  it.each([websiteProjects[0], projects.at(-2)!, projects.at(-1)!])('$name keeps rank aggregates and company evidence consistent', async project => {
    const { runtime } = await setup(project);
    const history = await runtime.repository.listPromptHistory(project.id,
      `${project.demo!.anchorDate}T00:00:00.000Z`, new Date(Date.parse(project.demo!.anchorDate) + 7 * DAY - 1).toISOString());
    for (const run of history.runs) {
      const results = history.results.filter(result => result.runId === run.id);
      const summary = (await runtime.artifacts.get<RunSummary>(run.summaryKey!))!;
      const measured = distribution(results);
      expect(summary.metrics.averageRank.value).toBeCloseTo(measured.mean);
      expect(metricsFromResults(results).averageRank).toEqual(summary.metrics.averageRank);
      const representatives = [results.find(result => result.target?.appearanceRank === 1),
        results.find(result => result.target?.appearanceRank === 2), results.find(result => !result.target?.mentioned)].filter(Boolean) as PromptResult[];
      for (const result of representatives) {
        const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
        const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
        expect(analysis.companies!.map(company => company.rank)).toEqual(analysis.companies!.map((_, index) => index + 1));
        for (const company of analysis.companies!) {
          expect(answer.text).toContain(`${company.rank}. ${company.name}`);
          expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
        }
        for (const brand of analysis.brands) {
          const identity = [project.brand, ...project.competitors].find(item => item.id === brand.brandId)!;
          const ordinal = analysis.companies!.findIndex(company => company.name === identity.name) + 1;
          expect(brand.appearanceRank).toBe(brand.mentioned ? ordinal : null);
          expect(brand.explicitRank).toBe(brand.mentioned ? ordinal : null);
          expect(brand.mentionOrder).toBe(brand.mentioned ? ordinal : null);
        }
        expect(analysis.brands.map(({ evidence, rankEvidence, sentimentEvidence, ...measurement }) => measurement))
          .toEqual(result.brands!.map(({ evidence, rankEvidence, sentimentEvidence, ...measurement }) => measurement));
      }
    }
  });

  it('keeps one-day website previews valid with supported ordinal ranks', async () => {
    const project = fixture('One-day preview', 'one-day-preview.com', 'website-demo', 'customer services');
    Object.assign(project.demo!, { startDate: '2026-10-26', anchorDate: '2026-10-26', endDate: '2026-10-26' });
    project.competitors = [];
    project.demo!.samples = [{ answerText: 'One-day preview provides customer services.' }];
    const { runtime } = await setup(project);
    const history = await runtime.repository.listPromptHistory(project.id, '2026-10-26T00:00:00.000Z', '2026-10-26T23:59:59.999Z');
    expect(history.runs).toHaveLength(3);
    expect(history.results.filter(result => result.target?.mentioned).every(result => result.target?.appearanceRank === 1)).toBe(true);
    expect(distribution(history.results).first).toBe(1);
  });

  it('passes a real XTrade account and its fifth-place saved observation through unchanged', async () => {
    const project = newProject({ id: 'account_xtrade', name: 'XTrade', brand: 'XTrade', domain: 'xtrade.com', now: now() });
    const { base, runtime } = await setup(project);
    const prompt = project.prompts[0], at = now().toISOString();
    const run: ScanRun = {
      id: 'saved-xtrade-run', projectId: project.id, scheduledAt: at, createdAt: at, status: 'completed', trigger: 'manual',
      snapshot: { projectName: project.name, brand: project.brand, competitors: project.competitors, prompts: [prompt],
        country: project.country, language: project.language, timezone: project.timezone,
        generationModel: project.generationModel, extractionModel: project.extractionModel, parserVersion: project.parserVersion,
        configVersion: project.version, provider: 'openai' },
      totalCount: 1, terminalCount: 1, succeededCount: 1, capturedCount: 1, resultVersion: 1, deadlineAt: at, expiresAt: 2_000_000_000,
    };
    const result: PromptResult = {
      projectId: project.id, runId: run.id, promptId: prompt.id, responseId: `${run.id}~${prompt.id}`, prompt,
      status: 'succeeded', version: 1, attempts: 1, capturedAt: at, captureKey: 'saved/xtrade/capture',
      target: { brandId: project.brand.id, mentioned: true, appearanceRank: 5, explicitRank: 5, mentionOrder: 5,
        sentiment: 'neutral', evidence: [], rankEvidence: null, sentimentEvidence: null },
      citationCount: 0, sourceCount: 0, expiresAt: 2_000_000_000,
    };
    const capture = { text: '5. XTrade is one of the saved providers.', createdAt: at };
    await base.repository.createRun(run, [result]);
    await base.artifacts.put(result.captureKey!, capture);
    const range = ['2026-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z'] as const;
    expect(await runtime.repository.getProject(project.id)).toEqual(project);
    expect(await runtime.repository.listPromptHistory(project.id, ...range)).toEqual(await base.repository.listPromptHistory(project.id, ...range));
    expect(await runtime.repository.listRuns(project.id)).toEqual([run]);
    expect(await runtime.repository.getResult(project.id, run.id, prompt.id)).toEqual(result);
    expect(await runtime.artifacts.get(result.captureKey!)).toEqual(capture);
    expect(base.artifacts.values.size).toBe(1);
    expect(base.queue.messages).toEqual([]);
  });
});
