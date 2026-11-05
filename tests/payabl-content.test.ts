import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { MentionsSummary, Page, PromptResult, ResponseDetail, SourceRow, TrackingRow, TrackingSummary } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';
import { testIdentity } from './fixtures/users.js';

it('reconciles payabl. publications, tracked citations and payments sources with saved answers', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../scripts/demo-sources/payabl.json', import.meta.url), 'utf8'));
  const now = () => new Date('2026-11-05T21:30:00Z');
  const project = buildServiceDemo(fixture, now().toISOString());
  const repository = new MemoryRepository(), identity = testIdentity('merchant-reporting-owner');
  await repository.saveProject(project, null);
  await repository.syncUser(identity);
  await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
  const api = createApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, { mode: 'live', now });
  async function get<T>(path: string): Promise<T> {
    const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
    expect(response.status, path).toBe(200);
    return response.json();
  }
  const hourly = await get<Page<TrackingRow>>('tracked-urls?days=1&pageSize=100');
  expect(hourly.items.length).toBeGreaterThan(0);
  expect(hourly.items.every(row => row.periodAppearances > 0)).toBe(true);
  for (const host of ['payabl.com', 'www.youtube.com', 'www.reddit.com']) {
    const tracked = hourly.items.find(row => new URL(row.url).hostname === host)!;
    const answers = await get<Page<PromptResult>>(`tracked-urls/${tracked.id}/answers?days=1&limit=1`);
    const detail = await get<ResponseDetail>(`responses/${encodeURIComponent(answers.items[0].responseId)}`);
    expect(detail.answer!.citations.some(citation => citation.url === tracked.url)).toBe(true);
    const age = now().getTime() - Date.parse(detail.result.capturedAt!);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(86_400_000);
  }
  for (const days of [7, 14, 30, 90]) {
    const tracking = await get<Page<TrackingRow>>(`tracked-urls?days=${days}&pageSize=100`);
    const summary = await get<TrackingSummary>(`tracked-urls/summary?days=${days}`);
    const mentions = await get<MentionsSummary>(`mentions/summary?days=${days}`);
    expect(summary.series).toHaveLength(days);
    expect(summary.series.every(row => row.citations > 0)).toBe(true);
    expect(tracking.items.every(row => row.periodAppearances > 0)).toBe(true);
    expect(summary.appearances).toBe(tracking.items.reduce((sum, row) => sum + row.periodAppearances, 0));
    const publications = mentions.markers.flatMap(marker => marker.items);
    expect(new Set(publications.map(item => new URL(item.url).hostname))).toEqual(new Set(['payabl.com', 'www.youtube.com', 'www.reddit.com']));
    expect(publications.length).toBe(summary.series.reduce((sum, row) => sum + row.published, 0));
    for (const { id, appearances } of publications)
      expect(tracking.items.find(row => row.id === id)?.periodAppearances).toBe(appearances);
  }
  const sources = await get<Page<SourceRow>>('sources?limit=25');
  expect(sources.items[0].domain).toBe('payabl.com');
  expect(sources.total).toBeGreaterThan(1000);
  const secondPage = await get<Page<SourceRow>>(`sources?limit=25&cursor=${encodeURIComponent(sources.nextCursor!)}`);
  expect(secondPage.items).toHaveLength(25);
  expect(secondPage.items.some(row => sources.items.some(first => first.id === row.id))).toBe(false);
  for (const domain of ['emvco.com', 'europeanpaymentscouncil.eu', 'openbanking.org.uk', 'pcisecuritystandards.org']) {
    const source = (await get<Page<SourceRow>>(`sources?q=${domain}&limit=1`)).items[0];
    expect(source.domain).toBe(domain);
    const evidence = await get<Page<PromptResult>>(`sources/${source.id}/responses?limit=1`);
    expect(evidence.items[0]?.responseId).toBeTruthy();
  }
});
