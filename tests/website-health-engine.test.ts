import { describe, expect, it, vi } from 'vitest';
import type { WebsiteHealthDevice, WebsiteHealthJob, WebsiteHealthLabResult } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { WebsiteHealthEngine } from '../apps/scanner/src/website-health.js';
import { WebsiteHealthProviderError } from '../apps/scanner/src/website-health-provider.js';
import { parseScanMessage } from '../apps/scanner/src/handler.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';

const instant = '2026-10-26T09:00:00.000Z';
const url = 'https://northstar.example/';
function report(device: WebsiteHealthDevice) {
  const lab: WebsiteHealthLabResult = {
    strategy: device, requestedUrl: url, finalUrl: url, fetchedAt: instant, lighthouseVersion: '13',
    scores: { performance: device === 'mobile' ? 51 : 90, accessibility: 88, 'best-practices': 100, seo: null },
    metrics: [], issues: [], warnings: [],
  };
  return { lab, field: { status: 'unavailable' as const, metrics: [], message: 'Insufficient real-user data.' }, raw: { device } };
}
async function setup() {
  let clock = Date.parse(instant);
  const runtime = { repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
  const project = newProject({ id: 'health-worker', now: new Date(instant) });
  await runtime.repository.saveProject(project, null);
  const job: WebsiteHealthJob = {
    id: 'audit_test', projectId: project.id, url, fingerprint: 'test', createdBy: 'owner', version: 1, attempts: 0,
    status: 'queued', createdAt: instant, updatedAt: instant,
    results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } },
  };
  await runtime.repository.reserveWebsiteHealthAudit(job, null);
  const audit = vi.fn(async (_url: string, device: WebsiteHealthDevice) => report(device));
  const engine = new WebsiteHealthEngine(runtime, { audit }, () => new Date(clock));
  return { runtime, project, job, audit, engine, advance: (ms: number) => { clock += ms; },
    get: () => runtime.repository.getWebsiteHealthAudit(project.id, job.id),
    handle: () => engine.handle(project.id, job.id) };
}

async function siteSetup(discovering = false) {
  const s = await setup();
  const saved = (await s.get())!;
  await s.runtime.repository.saveWebsiteHealthAudit({ ...saved, version: saved.version + 1, scope: 'site', site: {
    maxPages: 10, discoveryStatus: discovering ? 'discovering' : 'completed', limited: false, warnings: [],
    pageCount: discovering ? 0 : 2, completedPages: 0, partialPages: 0, failedPages: 0,
    pages: discovering ? [] : ['one', 'two'].map(id => ({ id, url: `${url}${id}`, status: 'queued', results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } } })),
  } }, saved.version);
  return s;
}

describe('Website Health worker', () => {
  it('routes and checkpoints one device per delivery, retaining independent mobile/desktop results', async () => {
    const s = await setup();
    const scanner = new Scanner({ ...s.runtime, provider: new FixtureProvider(), websiteHealth: s.engine });
    const message = parseScanMessage({ kind: 'website-health', projectId: s.project.id, auditId: s.job.id });
    await scanner.handle(message);
    expect(await s.get()).toMatchObject({ status: 'queued', results: { mobile: { status: 'completed' }, desktop: { status: 'queued' } } });
    expect(s.runtime.queue.messages).toContainEqual(message);
    await scanner.handle(message);
    await scanner.handle(message);
    expect(s.audit.mock.calls.map(([, device]) => device)).toEqual(['mobile', 'desktop']);
    expect(await s.get()).toMatchObject({ status: 'completed', results: {
      mobile: { lab: { scores: { performance: 51, seo: null } } },
      desktop: { lab: { scores: { performance: 90, seo: null } } },
    } });
    expect(await s.runtime.artifacts.get(`projects/${s.project.id}/website-health/${s.job.id}/mobile.json`)).toMatchObject({ raw: { device: 'mobile' } });
  });

  it('accepts only one concurrent worker lease', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.audit.mockImplementation(async (_url, device) => { await gate; return report(device); });
    const running = s.handle();
    await vi.waitFor(() => expect(s.audit).toHaveBeenCalledOnce());
    await s.handle();
    expect(s.audit).toHaveBeenCalledOnce();
    release();
    await running;
  });

  it('recovers a saved Google checkpoint after a database interruption without another API call', async () => {
    const s = await setup();
    const save = s.runtime.repository.saveWebsiteHealthAudit.bind(s.runtime.repository);
    vi.spyOn(s.runtime.repository, 'saveWebsiteHealthAudit').mockImplementationOnce(save).mockRejectedValueOnce(new Error('database interrupted'));
    await expect(s.handle()).rejects.toThrow('database interrupted');
    expect(s.audit).toHaveBeenCalledOnce();
    s.advance(6 * 60_000);
    await s.engine.reconcile();
    expect(s.runtime.queue.messages).toContainEqual({ kind: 'website-health', projectId: s.project.id, auditId: s.job.id });
    await s.handle();
    expect(s.audit).toHaveBeenCalledOnce();
    expect(await s.get()).toMatchObject({ results: { mobile: { status: 'completed' } } });
  });

  it('retains the successful device when the other fails', async () => {
    const s = await setup();
    s.audit.mockImplementation(async (_url, device) => {
      if (device === 'mobile') throw new WebsiteHealthProviderError('pagespeed_runtime', 'Google could not load this page.', false);
      return report(device);
    });
    await s.handle();
    await s.handle();
    expect(await s.get()).toMatchObject({ status: 'partial', results: { mobile: { status: 'failed' }, desktop: { status: 'completed' } } });
  });

  it('respects retry delays and caps transient failures per device', async () => {
    const s = await setup();
    s.audit.mockRejectedValue(new WebsiteHealthProviderError('pagespeed_rate_limited', 'Google is rate limiting tests.', true));
    await s.handle();
    const queued = s.runtime.queue.messages.length;
    await s.handle();
    expect(s.audit).toHaveBeenCalledOnce();
    expect(s.runtime.queue.messages).toHaveLength(queued);
    expect(s.runtime.queue.delays).toContain(30);
    s.advance(30_000); await s.handle();
    s.advance(60_000); await s.handle();
    expect(await s.get()).toMatchObject({ results: { mobile: { status: 'failed' }, desktop: { status: 'queued' } } });
    await s.handle();
    s.advance(30_000); await s.handle();
    s.advance(60_000); await s.handle();
    expect(await s.get()).toMatchObject({ status: 'failed' });
    await s.handle();
    expect(s.audit).toHaveBeenCalledTimes(6);
  });

  it('preserves a checkpoint even after the last interrupted provider attempt', async () => {
    const s = await setup();
    const job = (await s.get())!;
    await s.runtime.repository.saveWebsiteHealthAudit({ ...job, version: 2, deviceAttempts: { mobile: 3 } }, 1);
    await s.runtime.artifacts.put(`projects/${s.project.id}/website-health/${s.job.id}/mobile.json`, report('mobile'));
    await s.handle();
    expect(s.audit).not.toHaveBeenCalled();
    expect(await s.get()).toMatchObject({ results: { mobile: { status: 'completed' } } });
  });

  it('expires abandoned audits and never tests demo accounts', async () => {
    const expired = await setup();
    expired.advance(24 * 60 * 60_000);
    await expired.handle();
    expect(expired.audit).not.toHaveBeenCalled();
    expect(await expired.get()).toMatchObject({ status: 'failed', results: { mobile: { error: { code: 'audit_deadline' } } } });
    const demo = await setup();
    await demo.runtime.repository.saveProject({ ...demo.project, version: 2, demo: {
      version: 1, source: 'website-demo', anchorDate: instant, startDate: instant, endDate: instant, sourceAccountId: 'test', sourceCopiedAt: instant,
    } }, 1);
    await demo.handle();
    expect(demo.audit).not.toHaveBeenCalled();
    expect(await demo.get()).toMatchObject({ status: 'failed' });
  });

  it('recovers a page-specific checkpoint after interruption and tests every page/device exactly once', async () => {
    const s = await siteSetup();
    const save = s.runtime.repository.saveWebsiteHealthAudit.bind(s.runtime.repository);
    vi.spyOn(s.runtime.repository, 'saveWebsiteHealthAudit').mockImplementationOnce(save).mockRejectedValueOnce(new Error('database interrupted'));
    await expect(s.handle()).rejects.toThrow('database interrupted');
    expect(s.audit).toHaveBeenCalledOnce();
    expect((await s.get())!.site!.pages[0]).toMatchObject({ status: 'running', results: { mobile: { status: 'running' } } });
    s.advance(6 * 60_000);
    await s.engine.reconcile();
    await s.handle();
    expect(s.audit).toHaveBeenCalledOnce();
    for (let i = 0; i < 4; i++) await s.handle();
    expect(s.audit.mock.calls).toEqual([[url + 'one', 'mobile'], [url + 'one', 'desktop'], [url + 'two', 'mobile'], [url + 'two', 'desktop']]);
    expect(await s.get()).toMatchObject({ status: 'completed', site: { pageCount: 2, completedPages: 2, partialPages: 0, failedPages: 0 } });
    expect(await s.runtime.artifacts.get(`projects/${s.project.id}/website-health/${s.job.id}/one/mobile.json`)).toMatchObject({ raw: { device: 'mobile' } });
  });

  it('budgets retries per page/device and continues after a failed test', async () => {
    const s = await siteSetup();
    s.audit.mockImplementation(async (page, device) => {
      if (page.endsWith('one') && device === 'mobile') throw new WebsiteHealthProviderError('rate_limited', 'Try again later.', true);
      return report(device);
    });
    await s.handle();
    await s.handle();
    expect(s.audit).toHaveBeenCalledOnce();
    s.advance(30000); await s.handle();
    s.advance(60000); await s.handle();
    for (let i = 0; i < 4; i++) await s.handle();
    expect(s.audit.mock.calls.filter(([page, device]) => page.endsWith('one') && device === 'mobile')).toHaveLength(3);
    expect(s.audit.mock.calls.filter(([page]) => page.endsWith('two'))).toHaveLength(2);
    expect(await s.get()).toMatchObject({ status: 'partial', site: { completedPages: 1, partialPages: 1, failedPages: 0 } });
  });

  it('leases discovery, persists its frontier, and recovers interrupted discovery with a bounded attempt budget', async () => {
    const s = await siteSetup(true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const step = vi.fn(async (job: WebsiteHealthJob) => {
      await gate;
      return { site: { ...job.site!, pageCount: 0 }, crawl: { queue: [{ url, kind: 'page' as const }], seen: ['root'], robots: {}, requests: 1, sitemaps: 0 } };
    });
    const engine = new WebsiteHealthEngine(s.runtime, { audit: s.audit }, () => new Date(instant), { step });
    const running = engine.handle(s.project.id, s.job.id);
    await vi.waitFor(() => expect(step).toHaveBeenCalledOnce());
    await engine.handle(s.project.id, s.job.id);
    expect(step).toHaveBeenCalledOnce();
    release(); await running;
    expect(await s.get()).toMatchObject({ status: 'queued', crawlAttempts: 0, crawl: { seen: ['root'], requests: 1 } });
    expect(s.audit).not.toHaveBeenCalled();

    const interrupted = await siteSetup(true);
    let clock = Date.parse(instant);
    const failedStep = vi.fn(async () => { throw new Error('interrupted'); });
    const recovery = new WebsiteHealthEngine(interrupted.runtime, { audit: interrupted.audit }, () => new Date(clock), { step: failedStep });
    for (let i = 0; i < 3; i++) {
      await expect(recovery.handle(interrupted.project.id, interrupted.job.id)).rejects.toThrow('interrupted');
      clock += 6 * 60_000;
    }
    await recovery.handle(interrupted.project.id, interrupted.job.id);
    expect(failedStep).toHaveBeenCalledTimes(3);
    expect(await interrupted.get()).toMatchObject({ status: 'failed', site: { discoveryStatus: 'failed' } });
  });

  it('retains completed pages when a site scan reaches its deadline and marks limited coverage partial', async () => {
    const s = await siteSetup();
    await s.handle();
    await s.handle();
    s.advance(24 * 60 * 60_000);
    await s.handle();
    expect(await s.get()).toMatchObject({ status: 'partial', site: { completedPages: 1, failedPages: 1 } });
    expect((await s.get())!.site!.pages[1].results.mobile.error?.code).toBe('audit_deadline');

    const limited = await siteSetup();
    const saved = (await limited.get())!;
    await limited.runtime.repository.saveWebsiteHealthAudit({ ...saved, version: saved.version + 1, site: { ...saved.site!, limited: true } }, saved.version);
    for (let i = 0; i < 4; i++) await limited.handle();
    expect(await limited.get()).toMatchObject({ status: 'partial', site: { completedPages: 2, limited: true } });
  });
});
