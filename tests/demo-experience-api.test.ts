import { describe, expect, it } from 'vitest';
import type { CapturedAnswer, DashboardOverview, Page, Project, PromptResult, SourceRow, TrafficDashboard } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = () => new Date('2026-11-04T12:00:00.000Z');
const ranges = ['days=7', 'days=14', 'days=30', 'days=90',
  'days=custom&start=2026-04-25&end=2026-11-04',
  'days=custom&start=2026-04-25&end=2027-04-25'];

async function setup() {
  const project: Project = {
    ...newProject({ id: 'account_roof_experience_demo_v1', name: 'Dr. Roof', brand: 'Dr. Roof', domain: 'drroof.com', now: now() }),
    enabled: false,
    scanProviders: [{ provider: 'openai', model: 'saved-openai' },
      { provider: 'perplexity', model: 'saved-perplexity' }, { provider: 'gemini', model: 'saved-gemini' }],
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source: 'igeo-dr-roof', sourceAccountId: 'roof-example', sourceCopiedAt: now().toISOString(),
      startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25',
      profile: { visibilityAdjustment: -.03, growthCurve: 1.06, trafficScale: .92, monthlyGrowth: .095 },
      samples: Array.from({ length: 12 }, (_, i) => ({
        answerText: 'Compare roofing contractors by inspections, repairs and warranty coverage.',
        companies: Array.from({ length: 8 }, (_, index) => `Roofing reference ${index + 1}`),
        citations: [{ url: `https://roofing-${i + 1}.example/guide`, title: `Roofing guide ${i + 1}` }],
      })),
      traffic: { countries: ['US', 'GB'], pages: ['/', '/roof-repair/', '/contact/'] },
    },
  };
  project.prompts = project.prompts.map((prompt, i) => ({ ...prompt, stage: (['understand', 'prefer', 'trust', 'convert'] as const)[i % 4] }));
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(project, null);
  const identity = testIdentity('demo-experience-owner');
  await repository.syncUser(identity);
  await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
  const api = createApi({ repository, artifacts, queue }, { mode: 'live', now, providerConfigured: true });
  const get = async <T,>(path: string): Promise<T> => {
    const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<T>;
  };
  return { project, repository, artifacts, queue, get };
}

describe('demo account experience through the API', () => {
  it('keeps dashboard comparisons favorable on the reported date across presets and full scenario ranges', async () => {
    const { project, repository, artifacts, queue, get } = await setup();
    for (const range of ranges) {
      const report = await get<DashboardOverview>(`dashboard/overview?${range}`);
      expect(report.analyzed).toBeGreaterThan(0);
      for (const provider of report.providers) {
        expect(provider.count).toBeGreaterThan(0);
        expect(provider.change, `${range}: ${provider.provider}`).toBeGreaterThanOrEqual(0);
      }
      for (const stage of report.stages) expect(stage.visibilityChange, `${range}: ${stage.key}`).toBeGreaterThanOrEqual(0);
      const target = report.ranking.find(row => row.isTarget)!;
      expect(target.mentionChange).toBeGreaterThanOrEqual(0);
      expect(target.sentimentChange).toBeGreaterThanOrEqual(0);
      const redditPosition = report.sources.findIndex(source => source.domain.replace(/^www\./, '') === 'reddit.com') + 1;
      expect(redditPosition, range).toBeGreaterThanOrEqual(2);
      expect(redditPosition, range).toBeLessThanOrEqual(5);
    }
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it('paginates real source rows and connects Reddit ranking to the underlying answer citations', async () => {
    const { get } = await setup();
    for (const provider of ['openai', 'perplexity', 'gemini']) {
      const query = `provider=${provider}&kind=cited&groupBy=domain&limit=10`;
      const first = await get<Page<SourceRow>>(`sources?${query}`);
      expect(first.items).toHaveLength(10);
      expect(first.total).toBeGreaterThan(10);
      expect(first.nextCursor).toBeTruthy();
      const second = await get<Page<SourceRow>>(`sources?${query}&cursor=${encodeURIComponent(first.nextCursor!)}`);
      expect(second.items.length).toBeGreaterThan(0);
      expect(second.items.every(row => !first.items.some(other => other.id === row.id))).toBe(true);
      const redditIndex = first.items.findIndex(row => row.domain === 'reddit.com');
      expect(redditIndex).toBeGreaterThanOrEqual(1);
      expect(redditIndex).toBeLessThanOrEqual(4);
      const reddit = first.items[redditIndex];
      const answers = await get<Page<PromptResult>>(`sources/${reddit.id}/responses?provider=${provider}&limit=100`);
      expect(answers.total).toBe(reddit.answerCount);
      expect(answers.items.length).toBeGreaterThan(0);
      const detail = await get<{ answer: CapturedAnswer }>(`responses/${encodeURIComponent(answers.items[0].responseId)}`);
      expect(detail.answer.citations.some(citation => new URL(citation.url).hostname.replace(/^www\./, '') === 'reddit.com')).toBe(true);
    }
  });

  it('reconciles traffic comparisons for each provider and region, including sparse hourly windows', async () => {
    const { get } = await setup();
    for (const range of ['days=1', ...ranges]) {
      for (const countries of ['', 'US', 'GB']) {
        const report = await get<TrafficDashboard>(`traffic?${range}&countries=${countries}`);
        expect(report.providers.every(provider => Number.isSafeInteger(provider.visits) && provider.visits >= 0 &&
          Number.isSafeInteger(provider.previous) && provider.previous >= 0)).toBe(true);
        expect(report.providers.reduce((sum, row) => sum + row.previous, 0)).toBe(report.previous);
        expect(report.providers.reduce((sum, row) => sum + row.visits, 0)).toBe(report.current);
        expect(report.series.reduce((sum, row) => sum + Object.values(row.values).reduce((total, count) => total + count, 0), 0)).toBe(report.current);
      }
    }
  });
});
