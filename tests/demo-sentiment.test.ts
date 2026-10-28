import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  brandSentimentScore, promptPeriodMetrics,
  type Analysis, type CapturedAnswer, type DemoConfig, type Project, type PromptResult,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { buildServiceDemo, type ServiceDemoSource } from '../scripts/create-service-demo.js';
import { newProject } from './fixtures/scanner.js';

const DAY = 86_400_000;
const end = '2026-10-28T23:59:59.999Z';
const now = () => new Date(end);
const sourceDirectory = new URL('../scripts/demo-sources/', import.meta.url);
const websiteProjects = readdirSync(sourceDirectory).filter(name => name.endsWith('.json')).flatMap(name => {
  const source = JSON.parse(readFileSync(new URL(name, sourceDirectory), 'utf8')) as ServiceDemoSource | ServiceDemoSource[];
  return (Array.isArray(source) ? source : [source]).map(value => buildServiceDemo(value, end));
});

function serviceProject(name: string, slug: string, domain: string, profile: NonNullable<DemoConfig['profile']>): Project {
  const id = `account_${slug}_demo_v1`, source = slug === 'dr_roof' ? 'igeo-dr-roof' : 'website-demo';
  const prefix = source === 'igeo-dr-roof' ? 'dr-roof-demo' : id;
  const project = newProject({ id, name, brand: name, domain, now: now() });
  return {
    ...project, enabled: false,
    prompts: project.prompts.map((prompt, index) => ({ ...prompt, id: `${prefix}-p${String(index + 1).padStart(2, '0')}` })),
    scanProviders: ['openai', 'perplexity', 'gemini'].map(provider => ({
      provider: provider as 'openai' | 'perplexity' | 'gemini', model: `saved-${provider}`,
    })),
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source, sourceAccountId: domain, sourceCopiedAt: end,
      startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25', profile,
      industry: { label: 'customer services', audience: 'customers', services: ['customer services'], criteria: ['service quality'] },
      samples: [{ answerText: `${name} provides services for customers.`,
        companies: Array.from({ length: 8 }, (_, index) => `Source alternative ${index + 1}`) }],
    },
  };
}

const projects = [
  ...websiteProjects,
  serviceProject('Dr. Roof', 'dr_roof', 'drroof.com', { visibilityAdjustment: -.03, growthCurve: 1.06, trafficScale: .92, monthlyGrowth: .095 }),
  serviceProject('All American Gutter Protection', 'all_american_gutter', 'allamericangutterprotection.com',
    { visibilityAdjustment: -.01, growthCurve: 1.03, trafficScale: 1.24, monthlyGrowth: .085 }),
  serviceProject('ACME Locksmith', 'acme_locksmith', 'acmelocksmith.com',
    { visibilityAdjustment: .02, growthCurve: 1.12, trafficScale: .74, monthlyGrowth: .092 }),
  serviceProject('Freedom Power', 'freedom_power', 'gofreedompower.com',
    { visibilityAdjustment: -.04, growthCurve: 1.08, trafficScale: 1.09, monthlyGrowth: .118 }),
  serviceProject('WindowWorks', 'windowworks', 'mywindowworks.com',
    { visibilityAdjustment: .01, growthCurve: .98, trafficScale: .86, monthlyGrowth: .104 }),
];

const legacyNayax = serviceProject('Nayax legacy', 'nayax', 'nayax.com',
  { visibilityAdjustment: 0, growthCurve: 1, trafficScale: 1, monthlyGrowth: .1 });
legacyNayax.prompts = legacyNayax.prompts.map((prompt, index) => ({ ...prompt, id: `nayax-demo-p${String(index + 1).padStart(2, '0')}` }));
Object.assign(legacyNayax.demo!, { source: 'igeo-nayax', startDate: '2026-04-23', anchorDate: '2026-10-23', endDate: '2027-04-23' });
delete legacyNayax.demo!.profile;

async function setup(project: Project) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const runtime = withDemoRuntime({ repository, artifacts, queue }, now);
  const history = await runtime.repository.listPromptHistory(project.id,
    `${project.demo!.startDate}T00:00:00.000Z`, `${project.demo!.endDate}T23:59:59.999Z`);
  return { repository, artifacts, queue, runtime, history };
}

const sentimentMean = (rows: PromptResult[]) => {
  const values = rows.flatMap(row => {
    const value = brandSentimentScore(row.target);
    return value === null ? [] : [value];
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

describe('demo sentiment progression', () => {
  it.each([...projects, legacyNayax])('$name improves comparable prompt sentiment without diluting new provider cohorts', async project => {
    const { history, repository, artifacts, queue } = await setup(project);
    for (const days of [7, 30, 90]) {
      const start = new Date(Date.parse(end) - days * DAY + 1).toISOString();
      for (const provider of [undefined, ...project.scanProviders!.map(value => value.provider)]) {
        const rows = promptPeriodMetrics(project, history, start, end, provider).items;
        expect(rows.every(row => row.measurementCount > 0)).toBe(true);
        expect(rows.filter(row => row.sentimentChange !== null && row.sentimentChange < 0)
          .map(row => ({ prompt: row.id, change: row.sentimentChange })), `${days} days, ${provider || 'all providers'}`).toEqual([]);
        if (days === 90 && !provider) expect(rows.some(row => (row.sentimentChange || 0) > 0)).toBe(true);
      }
    }

    const rowsByRun = new Map<string, PromptResult[]>();
    for (const result of history.results) {
      const rows = rowsByRun.get(result.runId) || [];
      rows.push(result); rowsByRun.set(result.runId, rows);
    }
    for (const { provider } of project.scanProviders!) {
      const providerRuns = history.runs.filter(run => run.snapshot.provider === provider)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      const seen = new Set<string>(), positive = new Set<string>();
      const regressions: string[] = [], diluted: string[] = [];
      for (const [scan, run] of providerRuns.entries()) {
        for (const result of rowsByRun.get(run.id)!) {
          if (!result.target!.mentioned) continue;
          if (positive.has(result.promptId) && result.target!.sentiment !== 'positive') regressions.push(result.responseId);
          if (scan && !seen.has(result.promptId) && result.target!.sentiment !== 'positive') diluted.push(result.responseId);
          if (result.target!.sentiment === 'positive') positive.add(result.promptId);
          seen.add(result.promptId);
        }
      }
      expect(regressions, `${provider} positive cohorts must stay positive`).toEqual([]);
      expect(diluted, `${provider} new mention cohorts must enter positive`).toEqual([]);

      const monthly: number[] = [];
      const start = new Date(project.demo!.startDate);
      for (let offset = 1; offset < 12; offset++) {
        const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
        monthly.push(sentimentMean(providerRuns.filter(run => run.scheduledAt.startsWith(month))
          .flatMap(run => rowsByRun.get(run.id)!)));
      }
      expect(monthly.every((value, index) => !index || value >= monthly[index - 1])).toBe(true);
      expect(monthly.at(-1)!).toBeGreaterThan(monthly[0] + 15);
    }
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it('keeps eToro positive and neutral answer copy aligned with measured sentiment', async () => {
    const project = websiteProjects.find(value => value.id === 'account_etoro_demo_v1')!;
    const { history, runtime } = await setup(project);
    const examples = ['positive', 'neutral'].map(sentiment => history.results.find(result => result.target!.sentiment === sentiment)!);
    expect(examples.every(Boolean)).toBe(true);
    for (const result of examples) {
      const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      const target = analysis.brands.find(brand => brand.brandId === project.brand.id)!;
      const company = analysis.companies!.find(company => company.name === project.brand.name)!;
      expect(target.sentiment).toBe(result.target!.sentiment);
      expect(company.sentiment).toBe(target.sentiment);
      expect(answer.text.slice(company.evidence.start, company.evidence.end)).toBe(company.evidence.quote);
      expect(company.evidence.quote).toBe(`${company.rank}. ${project.brand.name}${company.sentiment === 'positive'
        ? project.demo!.copy!.positiveCompany : project.demo!.copy!.neutralCompany}`);
    }
  });
});
