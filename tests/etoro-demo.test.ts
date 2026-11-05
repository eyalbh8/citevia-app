import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CapturedAnswer, DashboardOverview, MentionAnswer, MentionsSummary, Page, Project, PromptAnswerRow, PromptMetricsResponse, PromptResult, ResponseDetail, ScanRun, SourceRow, TrackingRow, TrackingSummary, TrafficDashboard } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { buildServiceDemo, createServiceDemo, expandServiceDemoTracking } from '../scripts/create-service-demo.js';
import { testIdentity } from './fixtures/users.js';

const source = JSON.parse(readFileSync(new URL('../scripts/demo-sources/etoro.json', import.meta.url), 'utf8'));
const now = () => new Date('2026-11-05T12:00:00.000Z');

describe('complete eToro demo account', () => {
  it('creates eToro alongside eToro US with a year of compact configuration', async () => {
    const project = buildServiceDemo(source, now().toISOString()), repository = new MemoryRepository();
    const us: Project = { ...structuredClone(project), id: 'account_existing_etoro_us', name: 'eToro US', demo: undefined };
    await repository.saveProject(us, null);
    expect(await createServiceDemo(repository, project, true)).toMatchObject({
      status: 'created', name: 'eToro', prompts: 50, competitors: 5, officialArticles: 40, socialLinks: 32,
      trackedUrls: 72, anchorDate: '2026-11-05', startDate: '2026-05-05', endDate: '2027-05-05', paidCalls: 0,
    });
    expect(await repository.getProject(us.id)).toEqual(us);
    expect((await createServiceDemo(repository, project, true)).status).toBe('exists');
    expect(project.brandbook?.about).toContain('eToro');
    expect(project.demo!.trackedUrls!.some(row => row.createdAt! > now().toISOString())).toBe(true);
  });

  it('expands existing tracking without changing saved enrollments, settings or account history', async () => {
    const originalSource = { ...source, blogs: source.blogs.slice(0, 14), socialLinks: source.socialLinks.slice(0, 8) };
    const existing: Project = JSON.parse(JSON.stringify(buildServiceDemo(originalSource, now().toISOString())));
    existing.extractionModel = 'saved-analysis-model';
    existing.demo!.trackedUrls![0].trackingPeriods = [{ start: '2026-05-06T08:00:00.000Z', end: null }];
    const repository = new MemoryRepository();
    await repository.saveProject(existing, null);
    const before = await repository.getProject(existing.id);
    expect(await expandServiceDemoTracking(repository, source)).toMatchObject({
      status: 'preview', previousTrackedUrls: 22, trackedUrls: 72, added: 50, blogs: 40, youtube: 16, reddit: 16,
    });
    expect(await repository.getProject(existing.id)).toEqual(before);
    expect((await expandServiceDemoTracking(repository, source, true, now())).status).toBe('updated');
    const saved = (await repository.getProject(existing.id))!;
    expect(saved.demo!.trackedUrls!.slice(0, 22)).toEqual(existing.demo!.trackedUrls);
    expect({ ...saved, version: existing.version, updatedAt: existing.updatedAt,
      demo: { ...saved.demo!, trackedUrls: existing.demo!.trackedUrls } }).toEqual(existing);
    const additions = saved.demo!.trackedUrls!.slice(22);
    for (const host of ['etoro.com', 'youtube.com', 'reddit.com']) {
      const links = additions.filter(row => new URL(row.url).hostname.replace(/^www\./, '') === host);
      expect(links.some(row => row.publishedAt < now().toISOString())).toBe(true);
      expect(links.some(row => row.publishedAt > now().toISOString())).toBe(true);
    }
    expect((await expandServiceDemoTracking(repository, source, true, now())).status).toBe('unchanged');
    expect((await repository.getProject(existing.id))!.version).toBe(saved.version);
    await expect(expandServiceDemoTracking(repository, { ...source, anchorDate: '2026-11-06' }, true, now())).rejects.toThrow('timeline');
    await expect(expandServiceDemoTracking({ getProject: async () => existing, saveProject: async () => false }, source, true, now()))
      .rejects.toThrow('concurrently');
    await expect(expandServiceDemoTracking({ getProject: async () => ({ ...existing, demo: undefined }), saveProject: async () => true }, source, true, now()))
      .rejects.toThrow('matching disabled website demo');
  });

  it('serves AI traffic, dashboard and citation-backed blogs, YouTube and Reddit in short and full-year ranges', async () => {
    const project = buildServiceDemo(source, now().toISOString());
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const identity = testIdentity('etoro-demo-owner');
    await repository.syncUser(identity);
    await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    const api = createApi({ repository, artifacts, queue }, { mode: 'live', now, providerConfigured: true });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json() as Promise<T>;
    };
    for (const range of ['days=7', 'days=30', 'days=90',
      'days=custom&start=2026-05-05&end=2026-11-05',
      'days=custom&start=2027-04-29&end=2027-05-05',
      'days=custom&start=2026-05-05&end=2027-05-05']) {
      const dashboard = await get<DashboardOverview>(`dashboard/overview?${range}`);
      expect(dashboard.analyzed).toBeGreaterThan(0);
      expect(dashboard.providers.every(row => row.count > 0)).toBe(true);
      expect(dashboard.comparison).toBe('modeled_period');
      expect(dashboard.providers.every(row => (row.change || 0) > 0)).toBe(true);
      expect(dashboard.stages.every(row => (row.visibilityChange || 0) > 0)).toBe(true);
      const band = ({ 'days=7': [2, 4], 'days=30': [7, 10], 'days=90': [20, 30] })[range];
      if (band) {
        const prompts = await get<PromptMetricsResponse>(`prompt-metrics?${range}`);
        const growth = [...dashboard.providers.map(row => row.change), ...dashboard.stages.map(row => row.visibilityChange),
          ...prompts.items.map(row => row.visibilityChange)];
        expect(growth.every(value => value !== null && value >= band[0] && value <= band[1])).toBe(true);
        expect(prompts.items.filter(row => row.avgVisibility! >= 60 && row.avgVisibility! <= 80).length).toBeGreaterThan(24);
        expect(prompts.items.filter(row => row.avgVisibility === 0).length).toBeLessThan(3);
        expect(prompts.items.every(row => row.comparison?.mode === 'modeled_period')).toBe(true);
      }
      const traffic = await get<TrafficDashboard>(`traffic?${range}`);
      expect(traffic.current).toBeGreaterThan(0);
      expect(traffic.providers.reduce((sum, row) => sum + row.visits, 0)).toBe(traffic.current);
      const tracking = await get<Page<TrackingRow>>(`tracked-urls?${range}&pageSize=100`);
      expect(tracking.items.every(row => row.periodAppearances > 0)).toBe(true);
      const summary = await get<TrackingSummary>(`tracked-urls/summary?${range}`);
      expect(tracking.items.reduce((sum, row) => sum + row.periodAppearances, 0)).toBe(summary.appearances);
      const mentions = await get<MentionsSummary>(`mentions/summary?${range}`);
      if (band) {
        const dates = summary.series.map(point => point.date);
        expect(dates).toHaveLength(Number(range.slice('days='.length)));
        expect(dashboard.trend.map(point => point.date)).toEqual(dates);
        for (const provider of mentions.providers) {
          expect(provider.points.map(point => point.date)).toEqual(dates);
          expect(provider.points.reduce((sum, point) => sum + point.count, 0))
            .toBe(dashboard.providers.find(row => row.provider === provider.provider)!.count);
        }
        expect(summary.series.every(point => point.citations > 0)).toBe(true);
        expect(summary.series.reduce((sum, point) => sum + point.citations, 0)).toBe(summary.appearances);
        for (const [index, point] of dashboard.trend.entries()) {
          expect(point.mentions[project.brand.id]).toBe(mentions.providers.reduce((sum, provider) => sum + provider.points[index].count, 0));
        }
        if (range === 'days=7' || range === 'days=90') {
          const page = await get<Page<MentionAnswer>>(`mentions?${range}&pageSize=100`);
          for (const provider of mentions.providers) {
            const today = provider.points.at(-1)!;
            expect(page.items.filter(row => row.provider === provider.provider && row.date.startsWith(today.date))).toHaveLength(today.count);
          }
          const latest = page.items[0];
          expect(latest.date.slice(0, 10)).toBe(now().toISOString().slice(0, 10));
          expect(latest.date <= now().toISOString()).toBe(true);
          const detail = await get<ResponseDetail>(`responses/${encodeURIComponent(latest.responseId)}`);
          expect(detail.answer?.createdAt).toBe(latest.date);
          expect(detail.result.capturedAt).toBe(latest.date);
        }
      }
      if (range === 'days=7') {
        const pickupDays = tracking.items.map(row => row.daysToFirstCitation!);
        expect(Math.min(...pickupDays)).toBe(0);
        expect(Math.max(...pickupDays)).toBe(14);
        expect(new Set(pickupDays).size).toBeGreaterThan(7);
        expect(summary.medianPickup).toBeGreaterThan(0);
        const publications = mentions.markers.flatMap(marker => marker.items);
        expect(new Set(publications.map(item => new URL(item.url).hostname))).toEqual(
          new Set(['www.etoro.com', 'www.youtube.com', 'www.reddit.com']),
        );
      }
      expect(mentions.markers.flatMap(marker => marker.items).length).toBe(summary.series.reduce((sum, point) => sum + point.published, 0));
      for (const marker of mentions.markers) for (const item of marker.items) {
        const row = tracking.items.find(row => row.id === item.id)!;
        expect(row, `${range}: ${item.url}`).toBeDefined();
        expect(item.appearances).toBe(row.periodAppearances);
        expect(item.appearances, `${range}: ${item.url}`).toBeGreaterThan(0);
        expect(marker.date).toBe(row.publishedAt.slice(0, 10));
      }
      for (const host of ['etoro.com', 'youtube.com', 'reddit.com']) {
        const cited = tracking.items.filter(row => new URL(row.url).hostname.replace(/^www\./, '') === host && row.periodAppearances > 0);
        expect(cited.length, `${range}: ${host}`).toBeGreaterThan(0);
        expect(cited.every(row => row.contentType === (host === 'etoro.com' ? 'BLOG' : 'SOCIAL'))).toBe(true);
        if (range !== 'days=7') continue;
        const answers = await get<Page<PromptResult>>(`tracked-urls/${cited[0].id}/answers?${range}&limit=100`);
        expect(answers.items.length).toBeGreaterThan(0);
        const detail = await get<{ answer: CapturedAnswer }>(`responses/${encodeURIComponent(answers.items[0].responseId)}`);
        expect(detail.answer.citations.some(citation => citation.url === cited[0].url)).toBe(true);
      }
    }
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  }, 30000);

  it('keeps the ongoing collection and source drilldowns within the current time', async () => {
    const project = buildServiceDemo(source, now().toISOString()), repository = new MemoryRepository();
    const identity = testIdentity('etoro-scan-owner');
    await repository.saveProject(project, null);
    await repository.syncUser(identity);
    await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    const api = createApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, { mode: 'live', now });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
      expect(response.status).toBe(200);
      return response.json();
    };
    const current = now().toISOString();
    const latestMention = (await get<Page<MentionAnswer>>('mentions?days=7')).items[0];
    const run = await get<ScanRun>(`runs/${latestMention.responseId.split('~')[0]}`);
    expect(run.status).toBe('running');
    expect(run.capturedCount).toBeGreaterThan(0);
    expect(run.capturedCount).toBeLessThan(run.totalCount);
    const responses = await get<Page<PromptResult>>(`responses?runId=${run.id}`);
    expect(responses.total).toBe(run.capturedCount);
    expect(responses.items.every(row => row.capturedAt! <= current)).toBe(true);
    const promptHistory = await get<Page<PromptAnswerRow>>(`prompts/${responses.items[0].promptId}/responses`);
    expect(promptHistory.items.every(row => row.date <= current)).toBe(true);

    const sources = await get<Page<SourceRow>>('sources?limit=1');
    expect(sources.total).toBeGreaterThan(1000);
    for (const query of ['', `&runId=${run.id}`]) {
      const owned = (await get<Page<SourceRow>>(`sources?owned=true${query}`)).items[0];
      expect(owned.domain).toBe('etoro.com');
      expect(owned.lastSeenAt <= current).toBe(true);
      const evidence = await get<Page<PromptResult>>(`sources/${owned.id}/responses?limit=100${query}`);
      expect(evidence.items.length).toBeGreaterThan(0);
      expect(evidence.items.every(row => row.capturedAt! <= current)).toBe(true);
    }
  });
});
