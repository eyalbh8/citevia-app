import { randomUUID } from 'node:crypto';
import type { WebsiteHealthDevice, WebsiteHealthJob } from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { GoogleWebsiteHealthProvider, WebsiteHealthProviderError } from './website-health-provider.js';

type HealthProvider = Pick<GoogleWebsiteHealthProvider, 'audit'>;
const devices: WebsiteHealthDevice[] = ['mobile', 'desktop'];
const active = (job: WebsiteHealthJob) => ['queued', 'running'].includes(job.status);
const pending = (job: WebsiteHealthJob) => devices.filter(device => ['queued', 'running'].includes(job.results[device].status));

/** Each delivery tests one device so both reports fit within the worker time limit. */
export class WebsiteHealthEngine {
  constructor(
    private runtime: Runtime,
    private provider: HealthProvider = new GoogleWebsiteHealthProvider(),
    private now = () => new Date(),
  ) {}

  private hasLease(job: WebsiteHealthJob) {
    return Boolean(job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > this.now().getTime());
  }

  private async save(job: WebsiteHealthJob, changes: Partial<WebsiteHealthJob>) {
    const next = {
      ...job,
      ...changes,
      version: job.version + 1,
      updatedAt: this.now().toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    };
    if (!pending(next).length) {
      const successes = devices.filter(device => next.results[device].status === 'completed').length;
      next.status = successes === devices.length ? 'completed' : successes ? 'partial' : 'failed';
      next.completedAt = this.now().toISOString();
      next.retryNotBefore = undefined;
    } else next.status = 'queued';
    return await this.runtime.repository.saveWebsiteHealthAudit(next, job.version) ? next : null;
  }

  private async enqueue(job: WebsiteHealthJob, delaySeconds = 0) {
    if (active(job)) await this.runtime.queue.send([
      { kind: 'website-health', projectId: job.projectId, auditId: job.id },
    ], delaySeconds);
  }

  private async failPending(job: WebsiteHealthJob, code: string, message: string) {
    const results = structuredClone(job.results);
    for (const device of pending(job)) results[device] = { status: 'failed', error: { code, message } };
    await this.save(job, { results });
  }

  async handle(projectId: string, auditId: string) {
    const { repository, artifacts } = this.runtime;
    const job = await repository.getWebsiteHealthAudit(projectId, auditId);
    if (!job || !active(job) || this.hasLease(job)) return;
    if (job.retryNotBefore && Date.parse(job.retryNotBefore) > this.now().getTime()) {
      // Ignore early duplicate deliveries. The delayed delivery or reconciler owns the retry.
      return;
    }
    const project = await repository.getProject(projectId);
    if (!project || project.demo) {
      await this.failPending(job, 'audit_unavailable', 'Auditing is unavailable for this account.');
      return;
    }
    if (this.now().getTime() - Date.parse(job.createdAt) >= 24 * 60 * 60_000) {
      await this.failPending(job, 'audit_deadline', 'The audit exceeded its recovery deadline. Run a new audit.');
      return;
    }
    const device = pending(job)[0];
    if (!device) { await this.save(job, {}); return; }
    const key = `projects/${projectId}/website-health/${auditId}/${device}.json`;
    const checkpoint = await artifacts.get<Awaited<ReturnType<HealthProvider['audit']>>>(key);
    const deviceAttempts = (job.deviceAttempts?.[device] || 0) + 1;
    if (deviceAttempts > 3 && !checkpoint) {
      const saved = await this.save(job, { results: { ...job.results, [device]: {
        status: 'failed', error: { code: 'audit_recovery_exhausted', message: 'This device test could not finish after repeated interruptions. Run a new audit.' },
      } } });
      if (saved) await this.enqueue(saved);
      return;
    }
    const current: WebsiteHealthJob = {
      ...job,
      status: 'running',
      results: { ...job.results, [device]: { status: 'running' } },
      attempts: job.attempts + 1,
      deviceAttempts: { ...job.deviceAttempts, [device]: deviceAttempts },
      retryNotBefore: undefined,
      leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(this.now().getTime() + 6 * 60_000).toISOString(),
      version: job.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await repository.saveWebsiteHealthAudit(current, job.version))) return;
    // A private checkpoint permits a different worker to finish without rerunning Google.
    let result = checkpoint;
    if (!result) {
      try {
        result = await this.provider.audit(job.url, device);
      } catch (error) {
        const known = error instanceof WebsiteHealthProviderError;
        const failure = {
          code: known ? error.code : 'audit_provider_failed',
          message: known ? error.message : 'The website test could not finish. Run a new audit.',
        };
        const retry = known && error.retryable && deviceAttempts < 3;
        const delay = 30 * deviceAttempts;
        const saved = await this.save(current, {
          results: { ...current.results, [device]: { status: retry ? 'queued' : 'failed', error: failure } },
          retryNotBefore: retry ? new Date(this.now().getTime() + delay * 1000).toISOString() : undefined,
        });
        if (saved) await this.enqueue(saved, retry ? delay : 0);
        return;
      }
      // Storage errors retain the lease for recovery, preserving accepted reports.
      await artifacts.put(key, result);
    }
    const saved = await this.save(current, {
      results: { ...current.results, [device]: { status: 'completed', lab: result.lab, field: result.field } },
      artifactKeys: { ...current.artifactKeys, [device]: key },
      retryNotBefore: undefined,
    });
    if (saved) await this.enqueue(saved);
  }

  async reconcile() {
    const jobs = await this.runtime.repository.listActiveWebsiteHealthAudits();
    const due = jobs.filter(job => !this.hasLease(job) && (!job.retryNotBefore || Date.parse(job.retryNotBefore) <= this.now().getTime()));
    if (due.length) await this.runtime.queue.send(due.map(job => ({ kind: 'website-health', projectId: job.projectId, auditId: job.id })));
  }

  async deadLetter(projectId: string, auditId: string) {
    const job = await this.runtime.repository.getWebsiteHealthAudit(projectId, auditId);
    if (job && active(job) && !this.hasLease(job)) {
      // Delivery retries belong to the transport. Durable attempt budgets own recovery.
      await this.enqueue(job);
    }
  }
}
