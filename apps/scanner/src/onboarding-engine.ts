import { randomUUID } from 'node:crypto';
import type {
  Brandbook,
  CapturedAnswer,
  OnboardingJob,
  Prompt,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import {
  OnboardingOutputError,
  type OnboardingProvider,
} from './onboarding-provider.js';
import { ProviderError } from './provider.js';
import { runIdFor } from './engine.js';
const leaseMs = 12 * 60_000;
export class OnboardingEngine {
  constructor(
    private runtime: Runtime,
    private provider: OnboardingProvider,
    private syncSchedule: (
      project: import('@citevia/core').Project,
    ) => Promise<void>,
    private now = () => new Date(),
  ) {}
  async handle(projectId: string, jobId: string) {
    const { repository, artifacts, queue } = this.runtime;
    const job = await repository.getOnboarding(projectId, jobId);
    if (
      !job ||
      ['completed', 'failed'].includes(job.status) ||
      (job.leaseExpiresAt &&
        Date.parse(job.leaseExpiresAt) > this.now().getTime())
    )
      return;
    if (
      job.attempts >= 4 ||
      Date.parse(job.deadlineAt) < this.now().getTime()
    ) {
      await this.fail(
        job,
        'onboarding_exhausted',
        'Onboarding exceeded its retry or time limit. Retry after checking the account details.',
      );
      return;
    }
    let current: OnboardingJob = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      version: job.version + 1,
      leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(this.now().getTime() + leaseMs).toISOString(),
      updatedAt: this.now().toISOString(),
    };
    if (!(await repository.saveOnboarding(current, job.version))) return;
    const root = `projects/${projectId}/onboarding/${jobId}`;
    try {
      if (current.step === 'research') {
        const key = `${root}/research.json`;
        if (!(await artifacts.get(key)))
          await artifacts.put(key, await this.provider.research(current));
        current = { ...current, researchKey: key, step: 'brandbook' };
      } else if (current.step === 'brandbook') {
        const research = await artifacts.get<CapturedAnswer>(
          current.researchKey!,
        );
        if (!research) throw new Error('Missing research checkpoint');
        const key = `${root}/brandbook.json`;
        if (!(await artifacts.get(key)))
          await artifacts.put(
            key,
            await this.provider.brandbook(current, research),
          );
        current = { ...current, brandbookKey: key, step: 'prompts' };
      } else if (current.step === 'prompts') {
        const book = await artifacts.get<{ brandbook: Brandbook }>(
          current.brandbookKey!,
        );
        if (!book) throw new Error('Missing brandbook checkpoint');
        const key = `${root}/prompts.json`;
        if (!(await artifacts.get(key)))
          await artifacts.put(
            key,
            await this.provider.prompts(current, book.brandbook),
          );
        current = { ...current, promptsKey: key, step: 'activate' };
      } else if (current.step === 'activate') {
        const book = await artifacts.get<{ brandbook: Brandbook }>(
            current.brandbookKey!,
          ),
          portfolio = await artifacts.get<{ prompts: Prompt[] }>(
            current.promptsKey!,
          );
        if (!book || portfolio?.prompts.length !== 50)
          throw new Error('Invalid onboarding checkpoints');
        let project = await repository.getProject(projectId);
        if (!project || project.onboardingJobId !== jobId)
          throw new ProviderError(
            'onboarding_superseded',
            'A newer onboarding job replaced this one.',
            false,
          );
        if (project.onboardingAppliedJobId !== jobId) {
          const next = {
            ...project,
            brandbook: book.brandbook,
            brand: {
              ...project.brand,
              aliases: book.brandbook.names
                .filter((name) => name !== project!.brand.name)
                .slice(0, 20),
            },
            prompts: portfolio.prompts,
            enabled: true,
            onboardingAppliedJobId: jobId,
            scheduleStatus: 'pending' as const,
            version: project.version + 1,
            updatedAt: this.now().toISOString(),
          };
          if (!(await repository.saveProject(next, project.version)))
            throw new ProviderError(
              'project_conflict',
              'The account changed during activation. Retrying.',
              true,
            );
          project = next;
        }
        // Synchronize the latest saved settings, with CAS to prevent an old job overwriting a newer schedule.
        let synced = false;
        for (let i = 0; i < 3; i++) {
          const latest = await repository.getProject(projectId);
          if (!latest) throw new Error('Account missing');
          await this.syncSchedule(latest);
          if (
            await repository.saveProject(
              {
                ...latest,
                scheduleStatus: 'synced',
                version: latest.version + 1,
              },
              latest.version,
            )
          ) {
            synced = true;
            break;
          }
        }
        if (!synced) throw new Error('Concurrent schedule updates');
        const message = {
          kind: 'kickoff' as const,
          projectId,
          scheduledAt: job.createdAt,
          requestId: `onboarding-${job.id}`,
          trigger: 'manual' as const,
        };
        await queue.send([message]);
        current = {
          ...current,
          firstRunId: runIdFor(message),
          step: 'completed',
        };
      }
      const next = {
        ...current,
        status:
          current.step === 'completed'
            ? ('completed' as const)
            : ('queued' as const),
        version: current.version + 1,
        attempts: 0,
        updatedAt: this.now().toISOString(),
      };
      delete next.leaseOwner;
      delete next.leaseExpiresAt;
      delete next.error;
      if (
        (await repository.saveOnboarding(next, current.version)) &&
        next.status !== 'completed'
      )
        await queue.send([{ kind: 'onboard', projectId, jobId }]);
    } catch (error) {
      if (error instanceof OnboardingOutputError)
        await artifacts.put(
          `${root}/${job.step}-attempt-${current.attempts}.json`,
          error.receipt,
        );
      const retryable = !(error instanceof ProviderError) || error.retryable;
      const next = {
        ...current,
        status:
          retryable && current.attempts < 4
            ? ('queued' as const)
            : ('failed' as const),
        version: current.version + 1,
        updatedAt: this.now().toISOString(),
        error: {
          code:
            error instanceof ProviderError ? error.code : 'onboarding_error',
          message:
            error instanceof ProviderError
              ? error.message
              : 'Account setup failed. Check the saved details and retry.',
        },
      };
      // Persist the original step on failure, so a retry does not skip an unfinished operation.
      next.step = job.step;
      delete next.leaseOwner;
      delete next.leaseExpiresAt;
      if (
        (await repository.saveOnboarding(next, current.version)) &&
        next.status === 'queued'
      )
        throw error;
    }
  }
  private async fail(job: OnboardingJob, code: string, message: string) {
    await this.runtime.repository.saveOnboarding(
      {
        ...job,
        status: 'failed',
        version: job.version + 1,
        updatedAt: this.now().toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        error: { code, message },
      },
      job.version,
    );
  }
  async deadLetter(projectId: string, jobId: string) {
    const job = await this.runtime.repository.getOnboarding(projectId, jobId);
    if (job && !['failed', 'completed'].includes(job.status))
      await this.fail(
        job,
        'queue_delivery_exhausted',
        'Queue delivery failed. Retry account setup.',
      );
  }
  async reconcile() {
    for (const job of await this.runtime.repository.listActiveOnboarding()) {
      if (
        job.leaseExpiresAt &&
        Date.parse(job.leaseExpiresAt) > this.now().getTime()
      )
        continue;
      if (
        job.attempts >= 4 ||
        Date.parse(job.deadlineAt) < this.now().getTime()
      )
        await this.fail(
          job,
          'onboarding_exhausted',
          'Account setup exceeded its retry or time limit.',
        );
      else
        await this.runtime.queue.send([
          { kind: 'onboard', projectId: job.projectId, jobId: job.id },
        ]);
    }
  }
}
