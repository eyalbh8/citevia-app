import { randomUUID } from 'node:crypto';
import { websiteHealthArtifactKey, type WebsiteHealthAudit, type WebsiteHealthDevice, type WebsiteHealthDeviceResult, type WebsiteHealthJob } from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { GoogleWebsiteHealthProvider, WebsiteHealthProviderError } from './website-health-provider.js';
import { WebsiteHealthCrawler } from './website-health-crawler.js';

type HealthProvider = Pick<GoogleWebsiteHealthProvider, 'audit'>;
type Target = { device: WebsiteHealthDevice; pageId?: string; url: string };
const devices: WebsiteHealthDevice[] = ['mobile', 'desktop'];
const active = (job: WebsiteHealthJob) => ['queued', 'running'].includes(job.status);
const pendingResult = (result: WebsiteHealthDeviceResult) => ['queued', 'running'].includes(result.status);
const pending = (job: WebsiteHealthJob): Target[] => job.site
  ? job.site.pages.flatMap(page => devices.filter(device => pendingResult(page.results[device])).map(device => ({ device, pageId: page.id, url: page.url })))
  : devices.filter(device => pendingResult(job.results[device])).map(device => ({ device, url: job.url }));
function status(results: WebsiteHealthDeviceResult[]): WebsiteHealthAudit['status'] {
  if (results.some(result => result.status === 'running')) return 'running';
  if (results.some(pendingResult)) return 'queued';
  const successes = results.filter(result => result.status === 'completed').length;
  return successes && successes === results.length ? 'completed' : successes ? 'partial' : 'failed';
}
function targetResults(job: WebsiteHealthJob, target: Target, result: WebsiteHealthDeviceResult): Partial<WebsiteHealthJob> {
  if (!target.pageId) return { results: { ...job.results, [target.device]: result } };
  return { site: { ...job.site!, pages: job.site!.pages.map(page => {
    if (page.id !== target.pageId) return page;
    const results = { ...page.results, [target.device]: result };
    return { ...page, results, status: status(devices.map(device => results[device])) };
  }) } };
}

/** Each delivery discovers one URL or tests one page/device within the worker time limit. */
export class WebsiteHealthEngine {
  constructor(
    private runtime: Runtime,
    private provider: HealthProvider = new GoogleWebsiteHealthProvider(),
    private now = () => new Date(),
    private crawler: Pick<WebsiteHealthCrawler, 'step'> = new WebsiteHealthCrawler(),
  ) {}

  private hasLease(job: WebsiteHealthJob) {
    return Boolean(job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > this.now().getTime());
  }

  private async save(job: WebsiteHealthJob, changes: Partial<WebsiteHealthJob>) {
    const next: WebsiteHealthJob = {
      ...job, ...changes, version: job.version + 1, updatedAt: this.now().toISOString(),
      leaseOwner: undefined, leaseExpiresAt: undefined,
    };
    const discovering = next.site?.discoveryStatus === 'discovering';
    if (next.site) {
      const pages = next.site.pages.map(page => ({ ...page, status: status(devices.map(device => page.results[device])) }));
      next.site = {
        ...next.site, pages, pageCount: pages.length,
        completedPages: pages.filter(page => page.status === 'completed').length,
        partialPages: pages.filter(page => page.status === 'partial').length,
        failedPages: pages.filter(page => page.status === 'failed').length,
      };
      next.results = Object.fromEntries(devices.map(device => {
        const overall = discovering ? 'queued' : status(pages.map(page => page.results[device]));
        return [device, { status: overall === 'partial' ? 'failed' : overall }];
      })) as WebsiteHealthJob['results'];
    }
    if (!discovering && !pending(next).length) {
      const results = next.site ? next.site.pages.flatMap(page => devices.map(device => page.results[device])) : devices.map(device => next.results[device]);
      next.status = status(results);
      if (next.status === 'completed' && next.site && (next.site.limited || next.site.warnings.length || next.site.discoveryStatus === 'failed')) next.status = 'partial';
      next.completedAt = this.now().toISOString();
      next.retryNotBefore = undefined;
      next.crawl = undefined;
    } else next.status = 'queued';
    return await this.runtime.repository.saveWebsiteHealthAudit(next, job.version) ? next : null;
  }

  private async enqueue(job: WebsiteHealthJob, delaySeconds = 0) {
    if (active(job)) await this.runtime.queue.send([
      { kind: 'website-health', projectId: job.projectId, auditId: job.id },
    ], delaySeconds);
  }

  private async failPending(job: WebsiteHealthJob, code: string, message: string) {
    let changes = structuredClone(job);
    for (const target of pending(changes)) changes = { ...changes, ...targetResults(changes, target, { status: 'failed', error: { code, message } }) };
    if (changes.site) changes.site = { ...changes.site, discoveryStatus: 'failed', warnings: [...new Set([...changes.site.warnings, message])] };
    await this.save(job, changes);
  }

  async handle(projectId: string, auditId: string) {
    const { repository, artifacts } = this.runtime;
    const job = await repository.getWebsiteHealthAudit(projectId, auditId);
    if (!job || !active(job) || this.hasLease(job)) return;
    if (job.retryNotBefore && Date.parse(job.retryNotBefore) > this.now().getTime()) return;
    const project = await repository.getProject(projectId);
    if (!project || project.demo) {
      await this.failPending(job, 'audit_unavailable', 'Auditing is unavailable for this account.');
      return;
    }
    if (this.now().getTime() - Date.parse(job.createdAt) >= 24 * 60 * 60_000) {
      await this.failPending(job, 'audit_deadline', 'The audit exceeded its recovery deadline. Run a new audit.');
      return;
    }
    if (job.site?.discoveryStatus === 'discovering') {
      if ((job.crawlAttempts || 0) >= 3) {
        const saved = await this.save(job, { site: { ...job.site, discoveryStatus: 'failed', warnings: [...job.site.warnings, 'Page discovery was interrupted repeatedly. Coverage may be incomplete.'] } });
        if (saved) await this.enqueue(saved);
        return;
      }
      const current = this.lease(job, { crawlAttempts: (job.crawlAttempts || 0) + 1 });
      if (!(await repository.saveWebsiteHealthAudit(current, job.version))) return;
      const discovery = await this.crawler.step(current, project.brandbook?.sitemapUrl);
      const saved = await this.save(current, { ...discovery, crawlAttempts: 0 });
      if (saved) await this.enqueue(saved, 1);
      return;
    }
    const target = pending(job)[0];
    if (!target) { await this.save(job, {}); return; }
    const { device, pageId } = target;
    const key = websiteHealthArtifactKey(projectId, auditId, device, pageId);
    const checkpoint = await artifacts.get<Awaited<ReturnType<HealthProvider['audit']>>>(key);
    const attemptKey = `${pageId}:${device}`;
    const attempts = (pageId ? job.pageAttempts?.[attemptKey] || 0 : job.deviceAttempts?.[device] || 0) + 1;
    if (attempts > 3 && !checkpoint) {
      const saved = await this.save(job, targetResults(job, target, {
        status: 'failed', error: { code: 'audit_recovery_exhausted', message: 'This device test could not finish after repeated interruptions. Run a new audit.' },
      }));
      if (saved) await this.enqueue(saved);
      return;
    }
    const current = this.lease(job, {
      ...targetResults(job, target, { status: 'running' }),
      ...(pageId ? { pageAttempts: { ...job.pageAttempts, [attemptKey]: attempts } } : { deviceAttempts: { ...job.deviceAttempts, [device]: attempts } }),
    });
    if (!(await repository.saveWebsiteHealthAudit(current, job.version))) return;
    let result = checkpoint;
    if (!result) {
      try {
        result = await this.provider.audit(target.url, device);
      } catch (error) {
        const known = error instanceof WebsiteHealthProviderError;
        const failure = { code: known ? error.code : 'audit_provider_failed', message: known ? error.message : 'The website test could not finish. Run a new audit.' };
        const retry = known && error.retryable && attempts < 3, delay = 30 * attempts;
        const saved = await this.save(current, {
          ...targetResults(current, target, { status: retry ? 'queued' : 'failed', error: failure }),
          retryNotBefore: retry ? new Date(this.now().getTime() + delay * 1000).toISOString() : undefined,
        });
        if (saved) await this.enqueue(saved, retry ? delay : 0);
        return;
      }
      // Storage errors retain the lease. Recovery can reuse this checkpoint without rerunning Google.
      await artifacts.put(key, result);
    }
    const lab = pageId ? { ...result.lab, metrics: [], issues: [], warnings: [] } : result.lab;
    const saved = await this.save(current, {
      ...targetResults(current, target, { status: 'completed', lab, ...(!pageId ? { field: result.field } : {}) }),
      ...(!pageId ? { artifactKeys: { ...current.artifactKeys, [device]: key } } : {}),
      retryNotBefore: undefined,
    });
    if (saved) await this.enqueue(saved);
  }

  private lease(job: WebsiteHealthJob, changes: Partial<WebsiteHealthJob>): WebsiteHealthJob {
    return {
      ...job, ...changes, status: 'running', attempts: job.attempts + 1, retryNotBefore: undefined,
      leaseOwner: randomUUID(), leaseExpiresAt: new Date(this.now().getTime() + 6 * 60_000).toISOString(),
      version: job.version + 1, updatedAt: this.now().toISOString(),
    };
  }

  async reconcile() {
    const jobs = await this.runtime.repository.listActiveWebsiteHealthAudits();
    const due = jobs.filter(job => !this.hasLease(job) && (!job.retryNotBefore || Date.parse(job.retryNotBefore) <= this.now().getTime()));
    if (due.length) await this.runtime.queue.send(due.map(job => ({ kind: 'website-health', projectId: job.projectId, auditId: job.id })));
  }

  async deadLetter(projectId: string, auditId: string) {
    const job = await this.runtime.repository.getWebsiteHealthAudit(projectId, auditId);
    if (job && active(job) && !this.hasLease(job)) await this.enqueue(job);
  }
}
