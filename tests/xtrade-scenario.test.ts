import { describe, expect, it, vi } from 'vitest';
import {
  aggregateDashboardOverview, metricsFromResults, promptPeriodMetrics,
  type Analysis, type CapturedAnswer, type Project, type PromptResult, type ScanRun, type TrafficFilters,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { newProject } from './fixtures/scanner.js';

const now = () => new Date('2026-10-28T12:00:00.000Z');
const period = { start: '2026-10-20T00:00:00.000Z', end: '2026-10-28T23:59:59.999Z', granularity: 'daily' as const, timezone: 'UTC' as const };
function fixture(): Project {
  const project = newProject({ id: 'xtrade', name: 'XTrade', brand: 'XTrade', domain: 'xtrade.com' });
  return {
    ...project, enabled: false,
    competitors: ['Interactive Brokers', 'IG', 'eToro', 'XTB', 'Plus500', 'CMC Markets', 'Saxo'].map((name, index) => ({
      id: `rival-${index + 1}`, name, aliases: [], domains: [`rival-${index + 1}.example`],
    })),
    scanProviders: ['openai', 'perplexity', 'gemini'].map(provider => ({ provider: provider as 'openai' | 'perplexity' | 'gemini', model: 'illustrative-scenario' })),
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source: 'website-demo', sourceAccountId: 'original-xtrade', sourceCopiedAt: now().toISOString(),
      startDate: '2026-10-20', anchorDate: '2026-10-28', endDate: '2026-11-15',
      industry: { label: 'brokerage', audience: 'adults', services: ['trading'], criteria: ['regulatory status'] },
      presentation: { label: 'XTrade illustrative visibility scenario', targetRank: 8, mentionCount: 12, reportingOnly: true },
    },
  };
}
async function setup(project = fixture()) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const base = { repository, artifacts, queue };
  return { project, base, runtime: withDemoRuntime(base, now) };
}

describe('explicit illustrative presentation measurements', () => {
  it('places the target eighth across all prompts, with twelve mentions per provider and full two-scan coverage', async () => {
    const { project, base, runtime } = await setup();
    const history = await runtime.repository.listPromptHistory(project.id, period.start, period.end);
    expect(history.runs).toHaveLength(6);
    expect(history.results).toHaveLength(300);
    const mentioned = history.results.filter(result => result.target!.mentioned);
    expect(mentioned).toHaveLength(72);
    expect(new Set(mentioned.map(result => result.promptId)).size).toBe(50);
    expect(mentioned.every(result => result.target!.appearanceRank === 8)).toBe(true);
    for (const run of history.runs) {
      const results = history.results.filter(result => result.runId === run.id);
      expect(results.filter(result => result.target!.mentioned)).toHaveLength(12);
      expect(results.every(result => result.brands!.slice(1).every(brand => brand.mentioned))).toBe(true);
    }
    expect(metricsFromResults(history.results)).toMatchObject({ mentioned: 72, visibility: { value: 24 }, averageRank: { value: 8 } });
    const runs = new Map(history.runs.map(run => [run.id, run]));
    const overview = aggregateDashboardOverview(project, period,
      { providers: [], region: '', tag: '', branded: '', intent: '', search: '' },
      history.results.map(result => ({ result, run: runs.get(result.runId)! })));
    expect(overview.ranking.find(brand => brand.isTarget)).toMatchObject({ rank: 8, mentions: 72 });
    const prompts = promptPeriodMetrics(project, history, period.start, period.end);
    expect(prompts.items).toHaveLength(50);
    expect(prompts.items.every(item => item.avgRank === 8)).toBe(true);
    expect(await base.repository.listRuns(project.id)).toEqual([]);
    expect(base.artifacts.values.size).toBe(0);
    expect(base.queue.messages).toEqual([]);
    const repeated = withDemoRuntime(base, now);
    expect(await repeated.repository.listPromptHistory(project.id, period.start, period.end)).toEqual(history);
  });

  it('renders seven actual rival positions before the target and marks generated evidence as illustrative', async () => {
    const { project, runtime } = await setup();
    const [run] = await runtime.repository.listRuns(project.id);
    const results = await runtime.repository.listResults(project.id, run.id);
    for (const result of [results.find(result => result.target!.mentioned)!, results.find(result => !result.target!.mentioned)!]) {
      const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      expect(answer.text).toContain('Illustrative scenario');
      expect(answer.raw).toMatchObject({ illustrative: true, presentation: project.demo!.presentation });
      expect(analysis.raw).toMatchObject({ illustrative: true, presentation: project.demo!.presentation });
      expect(analysis.companies!.map(company => company.rank)).toEqual(Array.from({ length: result.target!.mentioned ? 8 : 7 }, (_, index) => index + 1));
      expect(answer.text.includes('XTrade')).toBe(result.target!.mentioned);
      for (const company of analysis.companies!) {
        expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
        expect(company.evidence.quote).toContain(`${company.rank}. ${company.name}`);
      }
    }
  });

  it('preserves and serves original runs, results, stored evidence, analyses, and native citations by their source identities', async () => {
    const { project, base, runtime } = await setup();
    const [generated] = await runtime.repository.listRuns(project.id);
    const [generatedResult] = await runtime.repository.listResults(project.id, generated.id);
    const originalRun: ScanRun = { ...generated, id: 'original-scan', summaryKey: 'original/summary.json', totalCount: 1, terminalCount: 1, succeededCount: 1, capturedCount: 1 };
    const originalResult: PromptResult = { ...generatedResult, runId: originalRun.id, responseId: 'original-response', captureKey: 'original/capture.json', analysisKey: 'original/analysis.json' };
    const answer = (await runtime.artifacts.get<CapturedAnswer>(generatedResult.captureKey!))!;
    const analysis = (await runtime.artifacts.get<Analysis>(generatedResult.analysisKey!))!;
    const originalAnswer: CapturedAnswer = { ...answer, text: 'Original response preserved', raw: { original: true } };
    await base.repository.createRun(originalRun, [originalResult]);
    await base.repository.saveMeasurement(originalResult, originalRun, originalAnswer, analysis);
    await base.artifacts.put(originalResult.captureKey!, originalAnswer);
    await base.artifacts.put(originalResult.analysisKey!, analysis);
    expect(await runtime.repository.getRun(project.id, originalRun.id)).toEqual(originalRun);
    expect(await runtime.repository.listResults(project.id, originalRun.id)).toEqual([originalResult]);
    expect(await runtime.repository.getResult(project.id, originalRun.id, originalResult.promptId)).toEqual(originalResult);
    expect(await runtime.artifacts.get(originalResult.captureKey!)).toEqual(originalAnswer);
    expect(await runtime.repository.listSavedAnalyses(project.id, [originalResult as Required<PromptResult>])).toEqual([{ responseId: originalResult.responseId, analysis }]);
    const captureKey = `${originalRun.snapshot.provider}:${originalResult.captureKey}`;
    expect(await runtime.repository.listNativeCitations(project.id, [captureKey])).toEqual(await base.repository.listNativeCitations(project.id, [captureKey]));
    expect(await base.repository.listRuns(project.id)).toEqual([originalRun]);
    expect(await base.repository.listResults(project.id, originalRun.id)).toEqual([originalResult]);
  });

  it('passes through traffic and tracked content so reporting illustrations cannot manufacture activity', async () => {
    const { project, base, runtime } = await setup();
    const traffic = vi.spyOn(base.repository, 'aggregateTraffic');
    const status = vi.spyOn(base.repository, 'trafficStatus');
    const tracked = vi.spyOn(base.repository, 'listTrackedUrls');
    const matches = vi.spyOn(base.repository, 'listTrackingMatches');
    const filters: TrafficFilters = { period, previous: period, countries: [], providers: [] };
    expect(await runtime.repository.aggregateTraffic(project.id, filters)).toEqual(await base.repository.aggregateTraffic(project.id, filters));
    expect(await runtime.repository.trafficStatus(project.id, 'test')).toEqual(await base.repository.trafficStatus(project.id, 'test'));
    expect(await runtime.repository.listTrackedUrls(project.id)).toEqual([]);
    expect(await runtime.repository.listTrackingMatches(project.id, 'tracked')).toEqual([]);
    expect(traffic).toHaveBeenCalledWith(project.id, filters);
    expect(status).toHaveBeenCalledWith(project.id, 'test');
    expect(tracked).toHaveBeenCalledWith(project.id);
    expect(matches).toHaveBeenCalledWith(project.id, 'tracked');
  });

  it.each([
    { targetRank: 1 }, { targetRank: 11 }, { targetRank: 8.5 }, { targetRank: 9 },
    { mentionCount: 0 }, { mentionCount: 51 }, { mentionCount: 12.5 }, { label: '' }, { reportingOnly: false },
  ])('rejects invalid bounded presentation configuration %j', async override => {
    const project = fixture();
    Object.assign(project.demo!.presentation!, override);
    const { runtime } = await setup(project);
    await expect(runtime.repository.listRuns(project.id)).rejects.toThrow('Invalid illustrative presentation configuration');
  });

  it('keeps ordinary projects and existing demos on their original paths', async () => {
    const original = fixture();
    delete original.demo!.presentation;
    const { runtime } = await setup(original);
    const history = await runtime.repository.listPromptHistory(original.id, period.start, period.end);
    expect(history.results.filter(result => result.target!.mentioned).length).not.toBe(72);
    const [run] = await runtime.repository.listRuns(original.id);
    const [result] = await runtime.repository.listResults(original.id, run.id);
    const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
    expect(answer.text).not.toContain('Illustrative scenario');
    expect(answer.raw).not.toHaveProperty('presentation');
    const real = fixture();
    delete real.demo;
    const actual = await setup(real);
    expect(await actual.runtime.repository.listPromptHistory(real.id, period.start, period.end)).toEqual({ runs: [], results: [] });
  });
});
