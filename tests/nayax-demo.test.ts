import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { buildNayaxDemo, createNayaxDemo, refreshNayaxAccount } from '../scripts/create-nayax-demo.js';
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

  it('ignores public traffic collection for a demo account', async () => {
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
