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
class LostLease extends Error {}
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
      !['queued', 'running'].includes(job.status) ||
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
    const generateOnce = async (
      key: string,
      operation: () => Promise<unknown>,
    ) => {
      if (await artifacts.get(key)) return;
      if (job.paidCall || job.attempts > 0)
        throw new ProviderError(
          'onboarding_call_uncertain',
          'A previous API attempt has no saved result. Automatic calls stopped to avoid duplicate charges. Review and retry explicitly.',
          false,
        );
      const pending: OnboardingJob = {
        ...current,
        paidCall: {
          id: randomUUID(),
          step: job.step as 'research' | 'brandbook' | 'prompts',
          startedAt: this.now().toISOString(),
        },
        version: current.version + 1,
      };
      if (!(await repository.saveOnboarding(pending, current.version)))
        throw new LostLease();
      current = pending;
      const latest = await repository.getOnboarding(projectId, jobId);
      if (latest?.version !== current.version || latest.status !== 'running')
        throw new LostLease();
      await artifacts.put(key, await operation());
    };
    try {
      if (current.step === 'research') {
        const key = `${root}/research.json`;
        await generateOnce(key, () => this.provider.research(current));
        current = { ...current, researchKey: key, step: 'brandbook' };
      } else if (current.step === 'brandbook') {
        const research = await artifacts.get<CapturedAnswer>(
          current.researchKey!,
        );
        if (!research) throw new Error('Missing research checkpoint');
        const key = `${root}/brandbook.json`;
        await generateOnce(key, () =>
          this.provider.brandbook(current, research),
        );
        current = { ...current, brandbookKey: key, step: 'prompts' };
      } else if (current.step === 'prompts') {
        const book = await artifacts.get<{ brandbook: Brandbook }>(
          current.brandbookKey!,
        );
        if (!book) throw new Error('Missing brandbook checkpoint');
        const key = `${root}/prompts.json`;
        await generateOnce(key, () =>
          this.provider.prompts(current, book.brandbook),
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
        const assertActive = async () => {
          const latest = await repository.getOnboarding(projectId, jobId);
          if (
            latest?.version !== current.version ||
            latest.status !== 'running'
          )
            throw new LostLease();
        };
        await assertActive();
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
          await assertActive();
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
        await assertActive();
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
      delete next.paidCall;
      const saved = await repository.saveOnboarding(next, current.version);
      if (!saved) await this.pauseFailedSetup(projectId, jobId);
      if (saved && next.status !== 'completed')
        await queue.send([{ kind: 'onboard', projectId, jobId }]);
    } catch (error) {
      if (error instanceof LostLease) {
        await this.pauseFailedSetup(projectId, jobId);
        return;
      }
      if (error instanceof OnboardingOutputError) {
        try {
          await artifacts.put(
            `${root}/attempts/${current.paidCall?.id ?? randomUUID()}/${job.step}.json`,
            error.receipt,
          );
        } catch {
          console.error(
            JSON.stringify({
              event: 'onboarding_receipt_save_failed',
              projectId,
              jobId,
              step: job.step,
            }),
          );
        }
      }
      // Once an API call is reserved, any failure requires explicit retry. A lost
      // checkpoint or expired lease cannot silently purchase another response.
      const retryable =
        !current.paidCall &&
        (!(error instanceof ProviderError) || error.retryable);
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
      if (await repository.saveOnboarding(next, current.version)) {
        if (next.status === 'queued') throw error;
        await this.pauseFailedSetup(projectId, jobId);
      } else await this.pauseFailedSetup(projectId, jobId);
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
    await this.pauseFailedSetup(job.projectId, job.id);
  }
  private async pauseFailedSetup(projectId: string, jobId: string) {
    try {
      const job = await this.runtime.repository.getOnboarding(projectId, jobId);
      if (!job || !['failed', 'stopped'].includes(job.status)) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const project = await this.runtime.repository.getProject(projectId);
        if (!project || project.onboardingJobId !== jobId || !project.enabled)
          return;
        const paused = {
          ...project,
          enabled: false,
          scheduleStatus: 'pending' as const,
          version: project.version + 1,
        };
        if (
          !(await this.runtime.repository.saveProject(paused, project.version))
        )
          continue;
        await this.syncSchedule(paused);
        return;
      }
    } catch {
      console.error(
        JSON.stringify({ event: 'onboarding_pause_pending', projectId, jobId }),
      );
    }
    // Scanner admission independently checks the terminal onboarding status.
  }
  async deadLetter(projectId: string, jobId: string) {
    const job = await this.runtime.repository.getOnboarding(projectId, jobId);
    if (job && ['queued', 'running'].includes(job.status))
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
