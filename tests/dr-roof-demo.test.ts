import type { DashboardOverview, MentionsSummary, Page, PromptMetricsResponse, SourceRow, TrackingRow } from '@citevia/core';
import { createApi } from '../apps/api/src/app.js';
import { testIdentity } from './fixtures/users.js';
import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { readFileSync } from 'node:fs';
import { buildDrRoofDemo, createDrRoofDemo, syncDrRoofReporting, DR_ROOF_DEMO_ID, DR_ROOF_DEMO_PROFILE, DR_ROOF_SOURCE_ACCOUNT_ID } from '../scripts/create-dr-roof-demo.js';
import { monitoringRoute } from '../apps/api/src/monitoring.js';

const source = () => ({
  sourceAccountId: DR_ROOF_SOURCE_ACCOUNT_ID,
  brand: { name: 'Dr. Roof', aliases: ['Dr Roof'], domains: ['drroof.com', 'https://www.facebook.com/DrRoofGA'] },
  competitors: Array.from({ length: 8 }, (_, index) => ({ name: `Source contractor ${index + 1}`, domains: [`contractor-${index + 1}.example`], aliases: [] })),
  prompts: Array.from({ length: 50 }, (_, index) => ({ text: `Which roofing service solves roof problem ${index + 1}?`, topic: 'Roof repair' })),
  brandbook: { about: 'Dr. Roof provides roofing services.', company_country: 'US', language: 'English', key_features: ['Roof repair'] },
  samples: [{ text: 'Dr. Roof repairs roofs in Atlanta.', citations: [{ url: 'https://drroof.com/roof-repair/', title: 'Roof repair' }] }],
  traffic: { pages: ['/', '/roof-repair/'], countries: ['US'], devices: ['mobile'], browsers: ['Chrome'] },
  blogs: Array.from({ length: 156 }, (_, index) => ({ url: `https://www.drroof.com/blog/p.202600${index}/roof-care-${index}/`,
    title: `Saved roofing article ${index + 1}`, sourcePublishedAt: '2026-01-12T00:00:00.000Z', sourceTrackedAt: '2026-02-12T00:00:00.000Z' })),
});
const project = () => buildDrRoofDemo(source(), '2026-10-25', '2026-10-25T10:00:00.000Z');

describe('explicit compact Dr. Roof demo', () => {
  it('keeps source identity, fifty actual questions, source-ordered competitors and modest independent numbers', () => {
    const original = source(), before = structuredClone(original), p = buildDrRoofDemo(original, '2026-10-25', '2026-10-25T10:00:00.000Z');
    expect(original).toEqual(before);
    expect(p.id).toBe(DR_ROOF_DEMO_ID);
    expect(p.name).toBe('Dr. Roof');
    expect(p.brand.domains).toEqual(['drroof.com']);
    expect(p.prompts.map(prompt => prompt.text)).toEqual(original.prompts.map(prompt => prompt.text));
    expect(p.competitors.map(competitor => competitor.name)).toEqual(original.competitors.slice(0, 5).map(competitor => competitor.name));
    expect(p.demo).toMatchObject({ source: 'igeo-dr-roof', sourceAccountId: DR_ROOF_SOURCE_ACCOUNT_ID,
      startDate: '2026-04-25', endDate: '2027-04-25', profile: DR_ROOF_DEMO_PROFILE });
    expect(p.demo?.traffic).toMatchObject(original.traffic);
    expect(p.demo?.samples?.[0]).toMatchObject({ answerText: original.samples[0].text, citations: original.samples[0].citations });
    expect(p.enabled).toBe(false);
    expect(p.scanSchedule?.slotsUtcMinutes).toHaveLength(2);
    expect(p.scanProviders?.map(provider => provider.provider)).toEqual(['openai', 'perplexity', 'gemini']);
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(250000);
  });

  it('reconciles hourly and daily charts, peer rankings, and positive prompt comparisons for the upgraded roofing profile', async () => {
    const at = new Date('2026-11-05T21:30:00Z');
    const data = source(), stages = ['understand', 'prefer', 'convert', 'trust'];
    const saved = buildDrRoofDemo({ ...data, prompts: data.prompts.map((row, i) => ({ ...row, stage: stages[i % stages.length] })) },
      '2026-11-05', at.toISOString());
    saved.demo!.reportingProfile = 'residential_roofing';
    saved.demo!.publicationAlignment = 'scans';
    saved.demo!.referenceSources = [{ url: 'https://www.nrca.net/roofingguidelines', title: 'Roofing guidelines' }];
    const repository = new MemoryRepository(), identity = testIdentity('roofing-report-viewer');
    await repository.saveProject(saved, null);
    await repository.syncUser(identity);
    await repository.putMembership({ projectId: saved.id, userId: identity.subject, role: 'viewer' });
    const api = createApi({ repository, queue: new MemoryQueue(), artifacts: new MemoryArtifacts() }, { mode: 'live', now: () => at });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await api(new Request(`https://test/v1/projects/${saved.id}/${path}`), identity);
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const bands: Record<string, [number, number]> = { 'days=7': [2, 4], 'days=30': [7, 10], 'days=90': [20, 30] };
    const citation = await get<Page<SourceRow>>('sources?q=nrca.net&limit=1');
    expect(citation.items[0]?.domain).toBe('nrca.net');
    for (const range of ['days=1', 'days=7', 'days=14', 'days=30', 'days=90',
      'days=custom&start=2026-06-04&end=2026-06-11', 'days=custom&start=2027-04-29&end=2027-05-05']) {
      const dashboard = await get<DashboardOverview>(`dashboard/overview?${range}`);
      const mentions = await get<MentionsSummary>(`mentions/summary?${range}`);
      const prompts = await get<PromptMetricsResponse>(`prompt-metrics?${range}`);
      expect(dashboard.rankingComparison).toBe('modeled_period');
      expect(dashboard.ranking.some(row => row.isTarget && row.mentions > 0)).toBe(true);
      expect(dashboard.ranking.every(row => row.mentionChange! > 0 && row.sentimentChange! > 0)).toBe(true);
      expect(mentions.comparison).toBe('modeled_period');
      const counts = new Map<string, number>();
      for (const row of mentions.providers) {
        const provider = dashboard.providers.find(item => item.provider === row.provider)!;
        expect(provider.count).toBe(row.count);
        expect(provider.change).toBe(row.change);
        expect(provider.change).toBeGreaterThan(0);
        for (const point of row.points) counts.set(point.date, (counts.get(point.date) ?? 0) + point.count);
      }
      expect(dashboard.trend.map(point => [point.date, point.mentions[saved.brand.id]])).toEqual([...counts].sort());
      if (range === 'days=1') {
        expect(dashboard.trendGranularity).toBe('hourly');
        expect(dashboard.trend.length).toBeGreaterThan(8);
        // The Wednesday article was enrolled during Monday's still-open scan.
        const tracked = await get<Page<TrackingRow>>('tracked-urls?days=1&pageSize=100');
        const midweek = tracked.items.find(item => item.createdAt.startsWith('2026-11-04'));
        expect(midweek?.periodAppearances).toBeGreaterThan(0);
        expect(midweek!.firstCitedAt! >= midweek!.createdAt).toBe(true);
      } else {
        const from = Date.parse(dashboard.period.start.slice(0, 10)), to = Date.parse(dashboard.period.end.slice(0, 10));
        expect(dashboard.trend).toHaveLength((to - from) / 86400000 + 1);
      }
      const measured = prompts.items.filter(row => row.measurementCount > 0);
      expect(measured.length).toBeGreaterThan(0);
      expect(measured.every(row => row.visibilityChange! > 0)).toBe(true);
      const band = bands[range];
      if (band) {
        const changes = [...dashboard.stages.map(row => row.visibilityChange), ...dashboard.providers.map(row => row.change),
          ...measured.map(row => row.visibilityChange)];
        expect(changes.every(value => value !== null && value >= band[0] && value <= band[1])).toBe(true);
        expect(measured.filter(row => row.avgVisibility! >= 60 && row.avgVisibility! <= 80).length).toBeGreaterThan(24);
      }
    }
  }, 30000);

  it('rejects another account, an unrelated company and misleading website domains', () => {
    expect(() => buildDrRoofDemo({ ...source(), sourceAccountId: 'another-account' })).toThrow();
    expect(() => buildDrRoofDemo({ ...source(), brand: { ...source().brand, name: 'Another Roofer' } })).toThrow('selected Dr. Roof');
    for (const domain of ['drroof.com.evil.example', 'facebook.com', 'https://drroof.com@evil.example/'])
      expect(() => buildDrRoofDemo({ ...source(), brand: { ...source().brand, domains: [domain] } })).toThrow('official drroof.com');
  });

  it('requires fifty distinct existing questions and five distinct existing competitor names', () => {
    expect(() => buildDrRoofDemo({ ...source(), prompts: Array.from({ length: 50 }, () => source().prompts[0]) })).toThrow('50 distinct source prompts');
    expect(() => buildDrRoofDemo({ ...source(), competitors: Array.from({ length: 5 }, () => source().competitors[0]) })).toThrow('five distinct source competitors');
    expect(() => buildDrRoofDemo({ ...source(), samples: [{ text: '' }] })).toThrow('saved answer excerpt');
  });

  it('infers roofing journey groups without rewriting the original question text', () => {
    const s = source();
    const questions = ['What causes roof leaks?', 'Best roofing contractors in Atlanta?', 'Are roofers licensed and insured?', 'Book a roof repair quote', 'Roof inspection and warranty options'];
    questions.forEach((text, index) => { s.prompts[index].text = text; });
    const p = buildDrRoofDemo(s);
    expect(p.prompts.slice(0, 5).map(prompt => prompt.stage)).toEqual(['understand', 'prefer', 'trust', 'convert', 'trust']);
    expect(p.prompts.slice(0, 5).map(prompt => prompt.text)).toEqual(questions);
    expect(buildDrRoofDemo(source(), '2026-08-31').demo?.startDate).toBe('2026-02-28');
    expect(() => buildDrRoofDemo(source(), '2026-02-30')).toThrow('valid --anchor');
  });

  it('enrolls three distinct official blogs per week with source dates preserved and deterministic scenario dates', () => {
    const p = project(), urls = p.demo!.trackedUrls!;
    expect(urls).toHaveLength(156);
    expect(new Set(urls.map(url => url.createdAt)).size).toBe(156);
    expect(urls.every(url => url.contentType === 'BLOG' && url.publishedAt === url.createdAt && url.sourcePublishedAt === '2026-01-12T00:00:00.000Z')).toBe(true);
    expect(urls.every(url => url.publishedAt >= `${p.demo!.startDate}T00:00:00.000Z` && url.publishedAt <= `${p.demo!.endDate}T23:59:59.999Z`)).toBe(true);
    expect(project().demo?.trackedUrls).toEqual(urls);
    for (const url of ['https://evil.example/blog/a', 'https://drroof.com.evil.example/blog/a', 'https://drroof.com/about/', 'http://drroof.com/blog/a', 'https://user:password@drroof.com/blog/a'])
      expect(() => buildDrRoofDemo({ ...source(), blogs: [{ ...source().blogs[0], url }] })).toThrow();
    expect(() => buildDrRoofDemo({ ...source(), blogs: Array.from({ length: 201 }, () => source().blogs[0]) })).toThrow();
  });

  it('shows the current weekly posts and citations in the default views while retaining future publications', async () => {
    const p = project(), now = () => new Date('2026-10-25T12:00:00.000Z'), repository = new MemoryRepository();
    await repository.saveProject(p, null);
    const runtime = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, now);
    for (const days of [7, 30]) {
      const response = await monitoringRoute(runtime, p, 'tracked-urls', new Request(`https://citevia.test/v1/projects/${p.id}/tracked-urls?days=${days}`), now(), async () => { throw new Error('GET only'); });
      expect(response?.status).toBe(200);
      const data = await response!.json();
      expect(data.total).toBe(78);
      expect(data.items).toHaveLength(25);
      expect(data.period.end).toBe(now().toISOString());
      expect(data.items.every((item: { publishedAt: string }) => item.publishedAt <= now().toISOString())).toBe(true);
      expect(data.items.reduce((sum: number, item: { periodAppearances: number }) => sum + item.periodAppearances, 0)).toBeGreaterThan(0);
    }
    const dates = [...new Set(p.demo!.trackedUrls!.map(url => url.publishedAt))];
    expect(dates.filter(date => date >= '2026-10-19' && date < '2026-10-26')).toEqual([
      '2026-10-19T08:00:00.000Z', '2026-10-21T08:00:00.000Z', '2026-10-23T08:00:00.000Z',
    ]);
    expect(dates.some(date => date > now().toISOString())).toBe(true);
    const [urls, matches, history] = await Promise.all([
      runtime.repository.listTrackedUrls(p.id), runtime.repository.listTrackingMatches(p.id),
      runtime.repository.listPromptHistory(p.id, `${p.demo!.startDate}T00:00:00Z`, now().toISOString()),
    ]);
    const scans = [...new Set(history.runs.map(run => run.scheduledAt))].sort();
    for (const url of urls.filter(url => url.publishedAt <= now().toISOString())) {
      const firstScan = scans.find(at => at >= url.publishedAt);
      const received = matches.filter(match => match.trackedUrlId === url.id && match.capture.capturedAt <= now().toISOString());
      if (firstScan) {
        expect(received.some(match => match.capture.capturedAt.slice(0, 10) === firstScan.slice(0, 10)), `${url.publishedAt} receives a citation in its next scheduled scan`).toBe(true);
      } else expect(received).toEqual([]);
    }
    expect(await repository.listRuns(p.id)).toEqual([]);
  });

  it('uses an exact Monday/Wednesday/Friday cadence with seventy-eight past posts and no repeated URLs', () => {
    const p = project(), urls = p.demo!.trackedUrls!, weeks = new Map<string, number>();
    for (const url of urls) {
      const date = new Date(url.publishedAt);
      expect([1, 3, 5]).toContain(date.getUTCDay());
      expect(url.publishedAt.endsWith('T08:00:00.000Z')).toBe(true);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const week = date.toISOString().slice(0, 10); weeks.set(week, (weeks.get(week) || 0) + 1);
    }
    expect(weeks.size).toBe(52);
    expect([...weeks.values()].every(count => count === 3)).toBe(true);
    expect(urls.filter(url => url.publishedAt < '2026-10-26T00:00:00Z')).toHaveLength(78);
    expect(new Set(urls.map(url => url.url)).size).toBe(156);
    expect(() => buildDrRoofDemo({ ...source(), blogs: source().blogs.slice(0, 77) })).toThrow('at least 78 distinct official blogs');
    const currentOnly = buildDrRoofDemo({ ...source(), blogs: source().blogs.slice(0, 78) });
    expect(currentOnly.demo?.trackedUrls).toHaveLength(78);
    const originals = source().blogs.slice(0, 78);
    const repeated = buildDrRoofDemo({ ...source(), blogs: [...originals,
      { ...originals[0], url: `${originals[0].url}?utm_source=chatgpt#section` }] });
    expect(repeated.demo?.trackedUrls).toHaveLength(78);
  });

  it('previews without mutation, creates only compact configuration and is idempotent', async () => {
    const repository = new MemoryRepository(), p = project(), save = vi.spyOn(repository, 'saveProject');
    expect(await createDrRoofDemo(repository, p)).toMatchObject({ status: 'preview', prompts: 50, competitors: 5, trackedUrls: 156,
      persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(await repository.getProject(p.id)).toBeNull();
    expect((await createDrRoofDemo(repository, p, true)).status).toBe('created');
    expect((await createDrRoofDemo(repository, p, true)).status).toBe('exists');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await repository.listRuns(p.id)).toEqual([]);
    expect(await repository.listPromptHistory(p.id, '2026-01-01', '2027-12-31')).toEqual({ runs: [], results: [] });
  });

  it('refuses to replace a real account or another scenario and stops on concurrent creation', async () => {
    const repository = new MemoryRepository(), p = project();
    await repository.saveProject({ ...p, demo: undefined }, null);
    await expect(createDrRoofDemo(repository, p, true)).rejects.toThrow('existing real account');
    const another = new MemoryRepository();
    await another.saveProject({ ...p, demo: { ...p.demo!, source: 'igeo-nayax' } }, null);
    await expect(createDrRoofDemo(another, p, true)).rejects.toThrow('existing real account');
    await expect(createDrRoofDemo({ getProject: async () => null, saveProject: async () => false }, p, true)).rejects.toThrow('concurrently');
    await expect(createDrRoofDemo(new MemoryRepository(), { ...p, id: 'real-account' }, true)).rejects.toThrow('demo identity');
  });
});


describe('Dr. Roof reporting upgrade', () => {
  const catalog = JSON.parse(readFileSync(new URL('../scripts/dr-roof-content.json', import.meta.url), 'utf8'));
  const now = new Date('2026-11-05T21:30:00Z');

  it('preserves saved records, respects article publication dates and adds every curated URL once', async () => {
    const existing = project(), repository = new MemoryRepository(), save = vi.spyOn(repository, 'saveProject');
    existing.version = 3;
    const draft = {
      url: `https://app.citevia.io/demo-content/${existing.id}/roof-inspection`, title: 'My inspection checklist',
      body: 'Start with an attic inspection.', contentType: 'BLOG' as const, demoPost: true as const,
      provenance: { kind: 'demo-draft' as const, sourceUrls: ['https://drroof.com/'] },
      publishedAt: '2026-07-06T08:00:00.000Z', createdAt: '2026-07-06T08:00:00.000Z',
    };
    existing.demo!.trackedUrls!.push(draft);
    await repository.saveProject(existing, null);
    const old = (await repository.getProject(existing.id))!, count = old.demo!.trackedUrls!.length;
    expect((await syncDrRoofReporting(repository, catalog, false, now)).status).toBe('preview');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await syncDrRoofReporting(repository, catalog, true, now)).toMatchObject({
      status: 'updated', version: 4, anchorDate: '2026-11-05', startDate: '2026-05-05', endDate: '2027-05-05',
      added: catalog.blogs.length + catalog.socialLinks.length, referenceSources: catalog.sources.length,
    });
    const updated = (await repository.getProject(existing.id))!;
    expect({ ...updated, demo: old.demo, updatedAt: old.updatedAt, version: old.version }).toEqual(old);
    expect(updated.demo).toMatchObject({ samples: old.demo!.samples, traffic: old.demo!.traffic,
      profile: old.demo!.profile, sourceAccountId: old.demo!.sourceAccountId, sourceCopiedAt: old.demo!.sourceCopiedAt });
    const urls = updated.demo!.trackedUrls!;
    expect(urls.slice(0, count)).toEqual(old.demo!.trackedUrls);
    const additions = urls.slice(count);
    expect(additions.map(row => row.url).sort()).toEqual([...catalog.blogs, ...catalog.socialLinks].map(row => row.url).sort());
    const reporting = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, () => now);
    const tracked = await reporting.repository.listTrackedUrls(existing.id);
    const matches = await reporting.repository.listTrackingMatches(existing.id);
    for (const blog of catalog.blogs) {
      const row = additions.find(row => row.url === blog.url)!;
      expect(row.sourcePublishedAt).toBe(blog.sourcePublishedAt);
      expect(row.publishedAt >= blog.sourcePublishedAt && row.createdAt! >= row.publishedAt).toBe(true);
      const id = tracked.find(url => url.url === blog.url)!.id;
      const captures = matches.filter(match => match.trackedUrlId === id).map(match => match.capture.capturedAt);
      expect(captures.length).toBeGreaterThan(0);
      expect(captures.every(at => at >= row.createdAt! && at >= blog.sourcePublishedAt)).toBe(true);
    }
    for (const until of [updated.demo!.anchorDate, updated.demo!.endDate]) {
      const end = Date.parse(until) + 86_400_000;
      const hosts = new Set(additions.filter(row => Date.parse(row.publishedAt) < end && Date.parse(row.publishedAt) >= end - 7 * 86_400_000)
        .map(row => new URL(row.url).hostname.replace(/^www\./, '')));
      expect(hosts).toEqual(new Set(['drroof.com', 'youtube.com', 'reddit.com']));
    }
    expect((await syncDrRoofReporting(repository, catalog, true, new Date('2026-11-06'))).status).toBe('unchanged');
    expect(await repository.getProject(existing.id)).toEqual(updated);
    expect(save).toHaveBeenCalledTimes(2);
    await expect(syncDrRoofReporting(repository, catalog, true, now, '2026-12-04')).rejects.toThrow('preserve');
  });

  it('guards identity, catalog ownership and concurrent edits', async () => {
    const saved = project(), saveProject = vi.fn(async () => false);
    for (const invalid of [{ ...saved, enabled: true }, { ...saved, demo: undefined },
      { ...saved, demo: { ...saved.demo!, sourceAccountId: 'another-account' } }])
      await expect(syncDrRoofReporting({ getProject: async () => invalid, saveProject }, catalog, true, now)).rejects.toThrow('matching disabled');
    const repository = { getProject: async () => saved, saveProject };
    await expect(syncDrRoofReporting(repository, { ...catalog, blogs: [{ url: 'https://unrelated.com/roof/', title: 'Other' }] }, true, now))
      .rejects.toThrow('official company website');
    expect(saveProject).not.toHaveBeenCalled();
    await expect(syncDrRoofReporting(repository, catalog, true, now)).rejects.toThrow('concurrently');
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ version: saved.version + 1 }), saved.version);
  });
});
