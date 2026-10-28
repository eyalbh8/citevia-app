import { describe, expect, it } from 'vitest';
import { citationMeasurement, type Analysis, type CapturedAnswer, type MentionAnswer, type MentionsSummary,
  type Project, type TrackingDetail } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { monitoringRoute } from '../apps/api/src/monitoring.js';
import { newProject } from './fixtures/scanner.js';

function weeklyNayax() {
  const posts = [
    ['best-selling-vending-machine-items', 'Best Products to Sell in Vending Machines'],
    ['payment-system-for-vending-business', 'Choosing a Vending Payment System'],
    ['vending-machine-inventory-management', 'Vending Machine Inventory Management'],
    ['how-to-start-a-vending-machine-business-your-journey-best-practices-and-tips', 'Starting a Vending Machine Business'],
    ['how-to-build-a-successful-cashless-vending-business', 'Building a Cashless Vending Business'],
    ['the-benefits-of-remote-management-for-vending-machines-how-nayaxs-solution-can-help', 'Remote Management for Vending Machines'],
  ];
  const project: Project = {
    ...newProject({ id: 'nayax-weekly', brand: 'Nayax', domain: 'nayax.com' }),
    enabled: false,
    scanProviders: [{ provider: 'openai', model: 'saved-openai' },
      { provider: 'perplexity', model: 'saved-perplexity' }, { provider: 'gemini', model: 'saved-gemini' }],
    scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] },
    demo: {
      version: 1, source: 'igeo-nayax', sourceAccountId: 'source-nayax', sourceCopiedAt: '2026-10-23T00:00:00.000Z',
      anchorDate: '2026-10-23', startDate: '2026-04-23', endDate: '2027-04-23',
      trackedUrls: posts.map(([slug, title], index) => {
        const publishedAt = new Date(Date.UTC(2026, 9, 19, 8) +
          (Math.floor(index / 3) * 7 + index % 3 * 2) * 86400000).toISOString();
        return { url: `https://www.nayax.com/blog/${slug}/`, title, publishedAt, createdAt: publishedAt, contentType: 'BLOG' };
      }),
    },
  };
  return project;
}

describe('Nayax weekly tracking runtime', () => {
  it('picks up each current and projected post at its first eligible scan with native answer evidence', async () => {
    const project = weeklyNayax(), repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const runtime = withDemoRuntime({ repository, artifacts, queue }, () => new Date('2026-10-25T12:00:00.000Z'));
    const urls = await runtime.repository.listTrackedUrls(project.id);
    const history = await runtime.repository.listPromptHistory(project.id, '2026-10-19T00:00:00.000Z', '2026-11-03T23:59:59.999Z');
    const times = [...new Set(history.runs.map(run => run.scheduledAt))].sort();
    const matches = await runtime.repository.listTrackingMatches(project.id);
    expect(urls).toHaveLength(6);
    expect(urls.filter(url => url.publishedAt <= '2026-10-25T12:00:00.000Z')).toHaveLength(3);
    for (const url of urls) {
      const firstScan = times.find(at => at >= url.publishedAt && at >= url.createdAt)!;
      const selected = matches.filter(match => match.trackedUrlId === url.id);
      expect(selected.every(match => match.capture.capturedAt >= url.publishedAt && match.capture.capturedAt >= url.createdAt)).toBe(true);
      const first = selected.find(match => match.capture.mentioned &&
        match.capture.capturedAt >= firstScan && Date.parse(match.capture.capturedAt) < Date.parse(firstScan) + 50_000);
      expect(first, url.title).toBeDefined();
      const result = (await runtime.repository.getResult(project.id, first!.capture.runId, first!.capture.promptId))!;
      const run = (await runtime.repository.getRun(project.id, first!.capture.runId))!;
      const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      expect(answer.citations.some(citation => citation.url === url.url)).toBe(true);
      expect(answer.citations).toHaveLength(result.citationCount);
      expect(citationMeasurement(result, run, answer, analysis)!.evidence.find(row => row.normalizedUrl === url.normalizedUrl))
        .toEqual(first!.evidence);
      expect(await runtime.repository.listTrackingMatches(project.id, url.id)).toEqual(selected);
    }
    const pending = urls[2];
    expect(matches.filter(match => match.trackedUrlId === pending.id && match.capture.capturedAt <= '2026-10-25T12:00:00.000Z')).toEqual([]);
    expect(matches.some(match => match.trackedUrlId === pending.id && match.capture.capturedAt.startsWith('2026-10-26'))).toBe(true);
    expect((await runtime.repository.listRuns(project.id, 1000)).every(run => run.scheduledAt <= '2026-10-25T12:00:00.000Z')).toBe(true);
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(await repository.listTrackedUrls(project.id)).toEqual([]);
    expect(await repository.listTrackingMatches(project.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  }, 30_000);

  it('keeps future citations out of current drawers while exposing them in a selected future period', async () => {
    const project = weeklyNayax(), repository = new MemoryRepository();
    await repository.saveProject(project, null);
    let currentTime = '2026-10-25T12:00:00.000Z';
    const clock = () => new Date(currentTime);
    const runtime = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, clock);
    const call = async <T,>(tail: string, query = 'days=7&pageSize=25'): Promise<T> => {
      const response = await monitoringRoute(runtime, project, tail, new Request(`https://test/${tail}?${query}`), clock(), request => request.json());
      expect(response?.status).toBe(200);
      return response!.json() as Promise<T>;
    };
    const summary = await call<MentionsSummary>('mentions/summary');
    expect(summary.markers.flatMap(marker => marker.items).map(item => item.title).sort())
      .toEqual(project.demo!.trackedUrls!.slice(0, 3).map(item => item.title).sort());
    const urls = await runtime.repository.listTrackedUrls(project.id), pending = urls[2];
    const before = await call<TrackingDetail>(`tracked-urls/${pending.id}`);
    const beforeAnswers = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${pending.id}/answers`);
    expect(before.row).toMatchObject({ firstCitedAt: null, lastCitedAt: null, status: 'published', appearances: 0, nativeCitations: 0 });
    expect(beforeAnswers.total).toBe(0);
    const projected = await call<TrackingDetail>(`tracked-urls/${pending.id}`, 'days=custom&start=2026-10-19&end=2026-10-26');
    expect(projected.row.firstCitedAt?.startsWith('2026-10-26T10:00:')).toBe(true);
    expect(projected.row.periodAppearances).toBeGreaterThan(0);
    currentTime = '2026-10-26T12:00:00.000Z';
    const after = await call<TrackingDetail>(`tracked-urls/${pending.id}`);
    const answers = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${pending.id}/answers`);
    expect(after.row.status).toBe('cited');
    expect(after.row.firstCitedAt).toEqual(projected.row.firstCitedAt);
    expect(after.row.matchingAnswers).toBe(answers.total);
    expect(answers.total).toBeGreaterThan(0);
    expect(answers.items.every(answer => answer.date >= pending.publishedAt && answer.date <= currentTime)).toBe(true);
  }, 30_000);
});
