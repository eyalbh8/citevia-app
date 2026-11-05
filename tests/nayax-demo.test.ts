import { describe, expect, it, vi } from 'vitest';
import type { DashboardOverview, MentionsSummary, PromptMetricsResponse } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { buildNayaxDemo, createNayaxDemo, refreshNayaxAccount, syncNayaxReporting } from '../scripts/create-nayax-demo.js';
import { refreshNayaxContent } from '../scripts/refresh-nayax-content.js';
import { createApi } from '../apps/api/src/app.js';
import { publicTrafficRoute } from '../apps/api/src/traffic.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { testIdentity } from './fixtures/users.js';
import { FixtureProvider } from './fixtures/scanner.js';

const source = () => ({
  brand: { name: 'Nayax', domains: ['nayax.com'], aliases: [] }, competitors: [{ name: 'Cantaloupe', domains: ['cantaloupe.com'], aliases: [] }],
  prompts: Array.from({ length: 50 }, (_, i) => ({ text: `Which cashless payment solution fits vending use case ${i + 1}?`, topic: 'Vending payments' })),
  brandbook: { about: 'Nayax provides cashless payment solutions for unattended retail.', companyCountry: 'US', language: 'en' },
  samples: [{ text: 'Nayax cashless payments support unattended retail.', citations: [{ url: 'https://nayax.com/' }] }],
});
const project = () => buildNayaxDemo(source(), '2026-10-23', '2026-10-23T10:00:00Z');
const now = () => new Date('2026-10-23T12:00:00Z');

describe('explicit Nayax demo account', () => {
  it('copies 50 prompts with a calendar-year scenario and stays compact and disabled', () => {
    const p = project();
    expect(p.prompts).toHaveLength(50);
    expect(new Set(p.prompts.map(p => p.id)).size).toBe(50);
    expect(p.demo).toMatchObject({ startDate: '2026-04-23', endDate: '2027-04-23' });
    expect(p.enabled).toBe(false);
    expect(p.name).toBe('Nayax');
    expect(p.scanProviders!.every(item => !/demo|synthetic/i.test(item.model))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(40000);
    expect(buildNayaxDemo(source(), '2026-08-31').demo?.startDate).toBe('2026-02-28');
  });

  it('reports measured hourly and daily visibility for the imported prompts, including the two Trust prompts', async () => {
    const at = new Date('2026-11-05T22:09:00Z'), data = source();
    // Preserve the uneven stage mix of the imported catalog.
    const stages = [...Array<string>(27).fill('prefer'), ...Array<string>(17).fill('understand'),
      ...Array<string>(4).fill('convert'), 'trust', 'trust'];
    const p = buildNayaxDemo({ ...data, prompts: data.prompts.map((prompt, i) => ({ ...prompt, stage: stages[i] })) },
      '2026-11-05', at.toISOString());
    p.demo!.reportingProfile = 'unattended_payments';
    const repository = new MemoryRepository(), identity = testIdentity('nayax-report-viewer');
    await repository.saveProject(p, null);
    await repository.syncUser(identity);
    await repository.putMembership({ projectId: p.id, userId: identity.subject, role: 'viewer' });
    const api = createApi({ repository, queue: new MemoryQueue(), artifacts: new MemoryArtifacts() }, { mode: 'live', now: () => at });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await api(new Request(`https://test/v1/projects/${p.id}/${path}`), identity);
      expect(response.status, path).toBe(200);
      return response.json();
    };
    for (const [days, lower, upper] of [[1, 0.1, 1], [7, 2, 4], [14, 3, 7], [30, 7, 10], [90, 20, 30]]) {
      const dashboard = await get<DashboardOverview>(`dashboard/overview?days=${days}`);
      const mentions = await get<MentionsSummary>(`mentions/summary?days=${days}`);
      const prompts = await get<PromptMetricsResponse>(`prompt-metrics?days=${days}`);
      expect(dashboard.stages).toHaveLength(4);
      expect(dashboard.ranking[0].name).toBe('Nayax');
      expect(dashboard.rankingComparison).toBe('modeled_period');
      expect(mentions.comparison).toBe('modeled_period');
      expect(dashboard.sources[0]).toMatchObject({ domain: 'nayax.com', owned: true });
      const measured = prompts.items.filter(row => row.measurementCount > 0);
      const changes = [...dashboard.providers.map(row => row.change), ...dashboard.stages.map(row => row.visibilityChange),
        ...measured.map(row => row.visibilityChange)];
      expect(changes.every(value => value !== null && value >= lower && value <= upper)).toBe(true);
      if (days === 1) {
        expect(dashboard.trendGranularity).toBe('hourly');
        expect(dashboard.trend.length).toBeGreaterThan(8);
      } else {
        expect(dashboard.trend).toHaveLength(days);
        expect(measured).toHaveLength(50);
        expect(measured.filter(row => row.avgVisibility! >= 60 && row.avgVisibility! <= 80).length).toBeGreaterThan(24);
      }
      const totals = new Map<string, number>();
      for (const provider of mentions.providers) {
        expect(dashboard.providers).toContainEqual({ provider: provider.provider, count: provider.count, change: provider.change });
        for (const point of provider.points) totals.set(point.date, (totals.get(point.date) ?? 0) + point.count);
      }
      expect(dashboard.trend.map(point => [point.date, point.mentions[p.brand.id]])).toEqual([...totals].sort());
    }
  }, 20000);

  it('refreshes only the selected account metadata and derives stable blog enrollments without persisting observations', async () => {
    const db = await localPostgres();
    try {
      const repository = new PostgresRepository(db), p = project();
      p.name = 'Nayax Demo';
      p.prompts[0].tags = ['Demo', 'Payments'];
      await repository.saveProject(p, null);
      const blogs = Array.from({ length: 14 }, (_, index) => ({ url: `https://www.nayax.com/blog/payments-${index}/`, title: `Payments ${index}`, sourcePublishedAt: '2025-01-01T00:00:00Z' }));
      expect((await refreshNayaxAccount(repository, blogs)).status).toBe('preview');
      expect((await repository.getProject(p.id))?.name).toBe('Nayax Demo');
      expect((await refreshNayaxAccount(repository, blogs, true, now())).status).toBe('updated');
      const saved = (await repository.getProject(p.id))!;
      expect(saved.name).toBe('Nayax');
      expect(saved.enabled).toBe(false);
      expect(saved.prompts[0].tags).toEqual(['Payments']);
      expect(saved.demo?.trackedUrls).toHaveLength(14);
      expect(new Set(saved.demo?.trackedUrls?.map(url => url.createdAt)).size).toBe(4);
      expect(saved.demo?.trackedUrls?.every(url => url.sourcePublishedAt === blogs[0].sourcePublishedAt)).toBe(true);
      expect((await refreshNayaxAccount(repository, blogs, true)).status).toBe('unchanged');
      expect((await repository.getProject(p.id))?.version).toBe(2);
      for (const table of ['citevia_runs', 'citevia_prompt_results', 'prompt_responses', 'analytics_events', 'citevia_tracked_urls'])
        expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      await repository.saveProject({ ...saved, demo: undefined, version: 3 }, 2);
      await expect(refreshNayaxAccount(repository, blogs, true)).rejects.toThrow('expected Nayax source identity');
    } finally { await db.close(); }
  });

  it('persists configuration only, is idempotent, and preserves existing real accounts', async () => {
    const db = await localPostgres();
    try {
      const repository = new PostgresRepository(db), p = project();
      expect((await createNayaxDemo(repository, p)).status).toBe('preview');
      expect(await repository.getProject(p.id)).toBeNull();
      expect((await createNayaxDemo(repository, p, true)).status).toBe('created');
      expect((await createNayaxDemo(repository, p, true)).status).toBe('exists');
      expect((await db.query('SELECT count(*)::int AS n FROM prompts')).rows[0].n).toBe(50);
      for (const table of ['citevia_runs', 'citevia_prompt_results', 'prompt_responses', 'analytics_events'])
        expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      const real = { ...p, demo: undefined, version: 2 };
      await repository.saveProject(real, 1);
      await expect(createNayaxDemo(repository, p, true)).rejects.toThrow('existing real account');
    } finally { await db.close(); }
  });

  it('serves all four reports through normal authentication, and blocks mutations and paid scans', async () => {
    const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue(), p = project();
    const runtime = { repository, artifacts, queue };
    await repository.saveProject(p, null);
    const identity = testIdentity('demo-owner');
    await repository.syncUser(identity);
    await repository.putMembership({ projectId: p.id, userId: identity.subject, role: 'owner' });
    const api = createApi(runtime, { mode: 'live', now, providerConfigured: true });
    for (const path of ['dashboard', 'dashboard/overview?days=30', 'prompt-metrics?days=30', 'mentions?days=30', 'traffic?days=30']) {
      const r = await api(new Request(`https://citevia.test/v1/projects/${p.id}/${path}`), identity);
      expect(r.status, `${path}: ${await r.clone().text()}`).toBe(200);
      const report = await r.json();
      if (path === 'dashboard') expect(report.metrics.analyzed).toBeGreaterThan(0);
      if (path.startsWith('dashboard/overview')) expect(report.analyzed).toBeGreaterThan(0);
      if (path.startsWith('prompt-metrics')) {
        expect(report.items).toHaveLength(50);
        expect(report.items.every((item: { measurementCount: number }) => item.measurementCount > 0)).toBe(true);
      }
      if (path.startsWith('mentions')) expect(report.total).toBeGreaterThan(0);
      if (path.startsWith('traffic')) expect(report.current).toBeGreaterThan(report.previous);
    }
    const denied = await api(new Request(`https://citevia.test/v1/projects/${p.id}/runs`, { method: 'POST', headers: { 'Idempotency-Key': 'demo-test-request' } }), identity);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe('ACCOUNT_READ_ONLY');
    const stranger = testIdentity('unassigned');
    const privateReport = await api(new Request(`https://citevia.test/v1/projects/${p.id}/dashboard`), stranger);
    expect(privateReport.status).toBe(404);
    const provider = new FixtureProvider(now), collect = vi.spyOn(provider, 'collect');
    await new Scanner({ ...runtime, provider, now }).handle({ kind: 'kickoff', projectId: p.id, scheduledAt: now().toISOString(), trigger: 'manual', requestId: 'demo-never-scan' });
    expect(collect).not.toHaveBeenCalled();
    expect(queue.messages).toHaveLength(0);
    expect(await repository.listRuns(p.id)).toHaveLength(0);
  });

  it.each(['memory', 'postgres'])('installs a scoped tracker and reconciles actual referrals with account history (%s)', async backend => {
    const db = backend === 'postgres' ? await localPostgres() : null;
    try {
      const repository = db ? new PostgresRepository(db) : new MemoryRepository(), p = project();
      p.brand.domains = ['investing.nayax.com'];
      const identity = testIdentity('traffic-viewer'), runtime = { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
      await repository.saveProject(p, null);
      await repository.syncUser(identity);
      await repository.putMembership({ projectId: p.id, userId: identity.subject, role: 'viewer' });
      const api = createApi(runtime, { mode: 'live', now, providerConfigured: true });
      const report = async (tail: string) => {
        const response = await api(new Request(`https://citevia.test/v1/projects/${p.id}/traffic${tail}`), identity);
        expect(response.status).toBe(200);
        return response.json();
      };
      const setup = await report('/status');
      expect(setup).toMatchObject({ installed: false, sites: [], hasEvents: false });
      expect(setup.trackerId).toMatch(/^[a-f0-9-]{36}$/);
      const before = await report('?days=7');
      const testId = crypto.randomUUID();
      const send = (origin: string, connectionTest?: string) => publicTrafficRoute(runtime, new Request('https://citevia.test/v1/traffic/collect', {
        method: 'POST', headers: { Origin: origin },
        body: JSON.stringify({ id: crypto.randomUUID(), projectId: setup.trackerId, url: origin + '/new-visit', referrer: 'https://chatgpt.com/', testId: connectionTest }),
      }), now());
      expect((await send('https://nayax.com.unrelated.test'))?.status).toBe(403);
      expect((await send('https://other.nayax.com'))?.status).toBe(403);
      expect((await send('https://www.investing.nayax.com', testId))?.status).toBe(204);
      expect(await report(`/status?testId=${testId}`)).toMatchObject({ testReceived: true, hasEvents: false, installed: true });
      expect((await report('?days=7')).current).toBe(before.current);
      expect((await send('https://investing.nayax.com'))?.status).toBe(204);
      const after = await report('?days=7');
      expect(after.current).toBe(before.current + 1);
      expect(after.pages).toContainEqual({ label: '/new-visit', visits: 1 });
      expect(after.status).toMatchObject({ installed: true, hasEvents: true });
    } finally { await db?.close(); }
  });

  it('keeps legacy internal scenario IDs unavailable to public tracking', async () => {
    const repository = new MemoryRepository(), p = project();
    await repository.saveProject(p, null);
    const collect = vi.spyOn(repository, 'collectTrafficEvent'), install = vi.spyOn(repository, 'recordTrafficInstallation');
    const r = await publicTrafficRoute({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, new Request('https://citevia.test/v1/traffic/collect', {
      method: 'POST', body: JSON.stringify({ id: '123e4567-e89b-42d3-a456-426614174000', projectId: p.id, url: 'https://nayax.com/', referrer: 'https://chatgpt.com/' }),
    }), now());
    expect(r?.status).toBe(204);
    expect(collect).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});


describe('Nayax reporting upgrade', () => {
  const at = new Date('2026-11-05T22:09:00Z');
  const catalog = {
    blogs: [{ url: 'https://www.nayax.com/blog/payment-system-for-vending-business/', title: 'Choosing a payment system', sourcePublishedAt: '2024-08-08' }],
    socialLinks: [{ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Card readers in unattended retail' },
      { url: 'https://www.reddit.com/r/vending/comments/123ab/', title: 'How do vending readers work?' }],
    sources: [{ url: 'https://www.vending.org/', title: 'National Automatic Merchandising Association' }],
  };

  it('adds reporting to the current saved catalog only and guards against regressions from prior refresh commands', async () => {
    const repository = new MemoryRepository(), existing = project();
    existing.version = 5;
    existing.brand.domains = ['www.nayax.com'];
    existing.prompts[0].tags = ['Saved priority'];
    existing.demo!.trackedUrls = [{ url: 'https://www.nayax.com/blog/best-selling-vending-machine-items/',
      title: 'Saved products article', contentType: 'BLOG', publishedAt: '2026-04-24T08:00:00.000Z',
      createdAt: '2026-04-24T08:00:00.000Z', sourcePublishedAt: '2026-03-26T00:00:00.000Z',
      trackingPeriods: [{ start: '2026-04-24T08:00:00.000Z', end: null }] }];
    await repository.saveProject(existing, null);
    const original = (await repository.getProject(existing.id))!, save = vi.spyOn(repository, 'saveProject');
    expect((await syncNayaxReporting(repository, catalog, false, at)).status).toBe('preview');
    expect(save).not.toHaveBeenCalled();
    expect(await syncNayaxReporting(repository, catalog, true, at)).toMatchObject({ status: 'updated', version: 6,
      anchorDate: '2026-11-05', startDate: '2026-05-05', endDate: '2027-05-05', added: 3, trackedUrls: 4 });
    const updated = (await repository.getProject(existing.id))!;
    expect({ ...updated, version: original.version, updatedAt: original.updatedAt, demo: original.demo }).toEqual(original);
    const config = updated.demo!;
    expect(config).toMatchObject({ reportingProfile: 'unattended_payments', publicationAlignment: 'scans',
      samples: original.demo!.samples, traffic: original.demo!.traffic, sourceAccountId: original.demo!.sourceAccountId,
      sourceCopiedAt: original.demo!.sourceCopiedAt, referenceSources: catalog.sources });
    expect(config.trackedUrls![0]).toEqual(original.demo!.trackedUrls![0]);
    expect(config.trackedUrls!.map(row => row.url).sort()).toEqual([
      original.demo!.trackedUrls![0].url, ...catalog.blogs.map(x => x.url), ...catalog.socialLinks.map(x => x.url),
    ].sort());
    expect(config.trackedUrls!.some(row => row.demoPost)).toBe(false);
    expect((await syncNayaxReporting(repository, catalog, true, new Date('2026-11-06'))).status).toBe('unchanged');
    await expect(syncNayaxReporting(repository, catalog, true, at, '2026-11-06')).rejects.toThrow('preserve');
    await expect(refreshNayaxAccount(repository, catalog.blogs, true, at)).rejects.toThrow('source identity');
    await expect(refreshNayaxContent(repository, catalog, true, at)).rejects.toThrow('scenario identity');
    expect(await repository.getProject(existing.id)).toEqual(updated);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('requires the expected account, domain and source, and uses the saved version to protect concurrent edits', async () => {
    const saved = project(), saveProject = vi.fn(async () => false);
    const presentation = { label: 'Reviewed account', targetRank: 4, mentionCount: 12, reportingOnly: true as const };
    for (const invalid of [{ ...saved, enabled: true }, { ...saved, demo: undefined },
      { ...saved, demo: { ...saved.demo!, source: 'website-demo' as const } },
      { ...saved, demo: { ...saved.demo!, sourceAccountId: 'unrelated' } }, { ...saved, demo: { ...saved.demo!, presentation } },
      { ...saved, demo: { ...saved.demo!, reportingProfile: 'merchant_payments' as const } },
      { ...saved, brand: { ...saved.brand, domains: ['nayax.com.evil.com'] } }])
      await expect(syncNayaxReporting({ getProject: async () => invalid, saveProject }, catalog, true, at)).rejects.toThrow('matching disabled Nayax');
    expect(saveProject).not.toHaveBeenCalled();
    await expect(syncNayaxReporting({ getProject: async () => saved, saveProject }, catalog, true, at)).rejects.toThrow('concurrently');
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ version: saved.version + 1 }), saved.version);
  });
});
