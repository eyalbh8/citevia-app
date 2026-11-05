import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { DashboardOverview, MentionsSummary, PromptMetricsResponse } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';
import { testIdentity } from './fixtures/users.js';

const source = JSON.parse(readFileSync(new URL('../scripts/demo-sources/payabl.json', import.meta.url), 'utf8'));
const now = () => new Date('2026-11-05T21:30:00Z');

it('reconciles payabl. brand and provider charts and measures positive growth across reporting ranges', async () => {
  const project = buildServiceDemo(source, now().toISOString());
  const repository = new MemoryRepository();
  const identity = testIdentity('merchant-report-viewer');
  await repository.saveProject(project, null);
  await repository.syncUser(identity);
  await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'viewer' });
  const api = createApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, { mode: 'live', now });
  const get = async <T,>(path: string): Promise<T> => {
    const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
    expect(response.status, path).toBe(200);
    return response.json();
  };
  const bands: Record<string, [number, number]> = { 'days=7': [2, 4], 'days=30': [7, 10], 'days=90': [20, 30] };
  for (const range of [
    'days=1', 'days=7', 'days=14', 'days=30', 'days=90',
    'days=custom&start=2026-07-12&end=2026-07-26',
    'days=custom&start=2027-04-29&end=2027-05-05',
    'days=custom&start=2026-05-05&end=2027-05-05',
  ]) {
    const dashboard = await get<DashboardOverview>(`dashboard/overview?${range}`);
    const mentions = await get<MentionsSummary>(`mentions/summary?${range}`);
    const prompts = await get<PromptMetricsResponse>(`prompt-metrics?${range}`);
    expect(dashboard.comparison).toBe('modeled_period');
    expect(dashboard.rankingComparison).toBe('modeled_period');
    expect(mentions.comparison).toBe('modeled_period');
    expect(dashboard.ranking[0].isTarget).toBe(true);
    expect(dashboard.ranking.every(row => row.mentions > 0 && row.mentionChange! > 0 &&
      row.rankChange! >= 0 && row.sentimentChange! > 0)).toBe(true);

    const totals = new Map<string, number>();
    expect(dashboard.providers).toHaveLength(3);
    for (const row of dashboard.providers) {
      expect(row.count).toBeGreaterThan(0);
      expect(row.change).toBeGreaterThan(0);
      const provider = mentions.providers.find(item => item.provider === row.provider)!;
      expect(provider.count).toBe(row.count);
      expect(provider.change).toBe(row.change);
      expect(provider.points.reduce((sum, point) => sum + point.count, 0)).toBe(row.count);
      for (const { date, count } of provider.points) totals.set(date, (totals.get(date) ?? 0) + count);
    }
    expect(dashboard.trend.map(point => [point.date, point.mentions[project.brand.id]]))
      .toEqual([...totals].sort(([a], [b]) => a.localeCompare(b)));
    if (range === 'days=1') {
      expect(dashboard.trendGranularity).toBe('hourly');
      expect(dashboard.trend.length).toBeGreaterThan(8);
      expect(dashboard.trend.every(point => point.date.endsWith(':00:00.000Z'))).toBe(true);
    } else {
      const start = Date.parse(dashboard.period.start.slice(0, 10));
      const end = Date.parse(dashboard.period.end.slice(0, 10));
      expect(dashboard.trend).toHaveLength(1 + (end - start) / 86400000);
      expect(dashboard.trend[0].date).toBe(dashboard.period.start.slice(0, 10));
      expect(dashboard.trend.at(-1)!.date).toBe(dashboard.period.end.slice(0, 10));
    }

    const measured = prompts.items.filter(row => row.measurementCount > 0);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every(row => row.comparison?.mode === 'modeled_period' && row.visibilityChange! > 0)).toBe(true);
    expect(measured.every(row => row.rankCount === 0 || row.rankChange! > 0)).toBe(true);
    expect(measured.every(row => row.sentimentCount === 0 || row.sentimentChange! > 0)).toBe(true);
    expect(prompts.items.filter(row => !row.measurementCount).every(row => row.visibilityChange === null)).toBe(true);
    expect(dashboard.stages.every(row => row.visibilityChange! > 0)).toBe(true);
    const band = bands[range];
    if (band) {
      const changes = [...dashboard.providers.map(row => row.change), ...dashboard.stages.map(row => row.visibilityChange),
        ...measured.map(row => row.visibilityChange)];
      expect(changes.every(value => value !== null && value >= band[0] && value <= band[1])).toBe(true);
      expect(measured.filter(row => row.avgVisibility! >= 60 && row.avgVisibility! <= 80).length).toBeGreaterThan(24);
      expect(measured.filter(row => row.avgVisibility === 0)).toHaveLength(0);
    }
  }
}, 60000);
