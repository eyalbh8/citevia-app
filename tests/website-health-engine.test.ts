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
});
