import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  usesModeledReporting, aggregateDashboardOverview, metricsFromResults, promptPeriodMetrics,
  type DemoConfig, type Project, type PromptResult, type RunSummary,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { buildServiceDemo, type ServiceDemoSource } from '../scripts/create-service-demo.js';
import { newProject } from './fixtures/scanner.js';

const DAY = 86_400_000;
const end = '2026-11-04T23:59:59.999Z';
const sourceDirectory = new URL('../scripts/demo-sources/', import.meta.url);
const websiteProjects = readdirSync(sourceDirectory).filter(name => name.endsWith('.json')).flatMap(name => {
  const source = JSON.parse(readFileSync(new URL(name, sourceDirectory), 'utf8')) as ServiceDemoSource | ServiceDemoSource[];
  return (Array.isArray(source) ? source : [source]).map(value => buildServiceDemo(value, end));
});
function legacy(name: string, domain: string, source: DemoConfig['source']): Project {
  const project = newProject({ id: `success-${domain}`, name, brand: name, domain });
  return {
    ...project, enabled: false,
    prompts: project.prompts.map((prompt, index) => ({ ...prompt, stage: (['understand', 'prefer', 'trust', 'convert'] as const)[index % 4] })),
    scanProviders: ['openai', 'perplexity', 'gemini'].map(provider => ({ provider: provider as 'openai' | 'perplexity' | 'gemini', model: 'saved-source' })),
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source, sourceAccountId: domain, sourceCopiedAt: end,
      startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25',
      industry: { label: 'customer services', audience: 'customers', services: ['customer services'], criteria: ['service quality'] },
      samples: [{ answerText: `${name} provides services for customers.`,
        companies: Array.from({ length: 8 }, (_, index) => `Source alternative ${index + 1}`),
        citations: Array.from({ length: 14 }, (_, index) => ({ url: `https://reference-${index + 1}.example/` })),
      }],
    },
  };
}
const projects = [...websiteProjects,
  legacy('Nayax', 'nayax.com', 'igeo-nayax'),
  legacy('Dr. Roof', 'drroof.com', 'igeo-dr-roof'),
  legacy('All American Gutter Protection', 'allamericangutterprotection.com', 'website-demo'),
  legacy('Acme Locksmith', 'acmelocksmith.com', 'website-demo'),
  legacy('Freedom Power', 'gofreedompower.com', 'website-demo'),
  legacy('WindowWorks', 'mywindowworks.com', 'website-demo'),
];

async function setup(project: Project) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const runtime = withDemoRuntime({ repository, artifacts, queue }, () => new Date(end));
  const history = await runtime.repository.listPromptHistory(project.id,
    `${project.demo!.startDate}T00:00:00.000Z`, `${project.demo!.endDate}T23:59:59.999Z`);
  return { repository, artifacts, queue, runtime, history };
}

describe('successful demo histories and Reddit source coverage', () => {
  it.each(projects.filter(project => !usesModeledReporting(project.demo)))('$name retains every gained mention and improves comparable measurements throughout its year', async project => {
    const { history, repository, artifacts, queue } = await setup(project);
    const byRun = new Map<string, PromptResult[]>();
    for (const result of history.results) {
      const rows = byRun.get(result.runId) || [];
      rows.push(result); byRun.set(result.runId, rows);
    }
    const regressions: string[] = [];
    for (const { provider } of project.scanProviders!) {
      const runs = history.runs.filter(run => run.snapshot.provider === provider).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      let prior: ReturnType<typeof metricsFromResults> | undefined;
      const previousPrompts = new Map<string, PromptResult>();
      for (const run of runs) {
        const results = byRun.get(run.id)!;
        const metrics = metricsFromResults(results);
        if (prior && (metrics.mentioned < prior.mentioned || metrics.sentimentScore.value! < prior.sentimentScore.value! ||
          metrics.averageRank.value! > prior.averageRank.value!)) regressions.push(`${provider}:${run.scheduledAt}:aggregate`);
        for (const result of results) {
          const before = previousPrompts.get(result.promptId)?.target, target = result.target!;
          if (before?.mentioned && (!target.mentioned || target.appearanceRank! > before.appearanceRank! ||
            before.sentiment === 'positive' && target.sentiment !== 'positive')) regressions.push(result.responseId);
          previousPrompts.set(result.promptId, result);
        }
        prior = metrics;
      }
    }
    // Adjacent-scan monotonicity also covers custom ranges beginning on either
    // weekly slot, which previously exposed negative 7/30-day dashboard badges.
    expect(regressions).toEqual([]);
    for (const days of [1, 7, 14, 30, 90, 365]) {
      const start = new Date(Date.parse(end) - days * DAY + 1).toISOString();
      const period = { start, end, granularity: 'daily' as const, timezone: 'UTC' as const };
      for (const providers of [[], ...project.scanProviders!.map(({ provider }) => [provider])]) {
        const runs = new Map(history.runs.filter(run => run.scheduledAt >= start && run.scheduledAt <= end &&
          (!providers.length || providers.includes(run.snapshot.provider!))).map(run => [run.id, run]));
        const overview = aggregateDashboardOverview(project, period,
          { providers, region: '', tag: '', branded: '', intent: '', search: '' },
          history.results.filter(result => runs.has(result.runId)).map(result => ({ result, run: runs.get(result.runId)! })),
        );
        const target = overview.ranking.find(row => row.isTarget);
        const changes = [...overview.providers.map(row => row.change), ...overview.stages.map(row => row.visibilityChange),
          target?.mentionChange, target?.rankChange, target?.sentimentChange];
        expect(changes.filter(change => change !== null && change !== undefined && change < 0), `${days} days, ${providers.join(',')}`).toEqual([]);
      }
      if ([7, 30, 90].includes(days)) {
        const rows = promptPeriodMetrics(project, history, start, end).items;
        expect(rows.filter(row => [row.visibilityChange, row.rankChange, row.sentimentChange].some(change => change !== null && change < 0))
          .map(row => ({ id: row.id, visibility: row.visibilityChange, rank: row.rankChange, sentiment: row.sentimentChange })), `${days} day prompt comparisons`).toEqual([]);
      }
    }
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  }, 30_000);

  it.each(projects.filter(project => usesModeledReporting(project.demo)))('$name rotates prompt coverage between scans while more answers mention the brand over the year', async project => {
    const { history } = await setup(project);
    const byRun = new Map<string, Set<string>>();
    for (const result of history.results) {
      if (!result.target?.mentioned) continue;
      const prompts = byRun.get(result.runId) || new Set();
      prompts.add(result.promptId);
      byRun.set(result.runId, prompts);
    }
    for (const { provider } of project.scanProviders!) {
      const scans = history.runs.filter(run => run.snapshot.provider === provider)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(run => byRun.get(run.id)!);
      expect(scans.some((prompts, i) => i > 0 && [...scans[i - 1]].some(id => !prompts.has(id)))).toBe(true);
      const total = (values: Set<string>[]) => values.reduce((sum, values) => sum + values.size, 0);
      expect(total(scans.slice(-8))).toBeGreaterThan(total(scans.slice(0, 8)));
    }
  });

  it.each(projects)('$name ranks Reddit second through fifth from generated citations across the scenario', async project => {
    const { history, runtime } = await setup(project);
    // Every month and provider, plus both edges, covers changing citation-pool
    // sizes and newly enrolled articles without relying on one latest scan.
    const representatives = new Map<string, typeof history.runs[number]>();
    for (const run of [...history.runs].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)))
      representatives.set(`${run.scheduledAt.slice(0, 7)}:${run.snapshot.provider}`, run);
    for (const run of history.runs.slice(0, 3)) representatives.set(`first:${run.snapshot.provider}`, run);
    const positions: { run: string; position: number }[] = [];
    for (const run of representatives.values()) {
      const summary = (await runtime.artifacts.get<RunSummary>(run.summaryKey!))!;
      const position = summary.domains.findIndex(source => source.domain === 'reddit.com') + 1;
      if (position < 2 || position > 5) positions.push({ run: run.id, position });
      const reddit = summary.domains.find(source => source.domain === 'reddit.com')!;
      expect(reddit.answerCount).toBeGreaterThan(0);
      // A single answer may cite both the Reddit community and a tracked thread.
      const redditPages = summary.urls.filter(source => source.domain === 'reddit.com');
      expect(reddit.citationCount).toBe(redditPages.reduce((sum, page) => sum + page.citationCount, 0));
      expect(reddit.answerCount).toBe(new Set(redditPages.flatMap(page => page.responseIds)).size);
      if (redditPages.length === 1) expect(reddit.citationCount).toBe(reddit.answerCount);
      const consultedPosition = summary.consultedDomains.findIndex(source => source.domain === 'reddit.com') + 1;
      expect(consultedPosition).toBeGreaterThanOrEqual(2);
      expect(consultedPosition).toBeLessThanOrEqual(5);
    }
    expect(positions).toEqual([]);
  }, 30_000);
});
