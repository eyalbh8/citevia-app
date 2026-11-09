import { randomUUID } from 'node:crypto';
import type {
  Brandbook,
  CapturedAnswer,
  DiscoveredCompetitor,
  OnboardingJob,
  Project,
  Prompt,
} from '@citevia/core';
import {
  markScheduleSynced,
  competitorBrands,
  promptFingerprint,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import {
  OnboardingOutputError,
  previousPortfolioDraft,
  type OnboardingProvider,
} from './onboarding-provider.js';
import { ProviderError, type ProviderReceipt } from './provider.js';
import { runIdFor } from './engine.js';
import { validateSavedPortfolio } from './saved-portfolio.js';
import { verifiedBrandNames } from './onboarding-evidence.js';
import { withCompetitorResearch } from './onboarding-research-retry.js';
import { ONBOARDING_INSTRUCTIONS_VERSION } from './onboarding-prompts.js';
const leaseMs = 12 * 60_000;
const maxAutomaticPortfolioCorrections = 2;
class LostLease extends Error {}

type ResearchCheckpoint = {
  brandbook: Brandbook;
  competitors?: DiscoveredCompetitor[];
  receipt?: { instructionsVersion?: string };
  competitorSearchQuery?: string;
  verificationDomains?: string[];
};

function portfolioContext(project: Project, job: OnboardingJob, research: ResearchCheckpoint) {
  const submittedHost = new URL(job.input.website).hostname.toLowerCase();
  if (project.brand.name !== job.input.name ||
      project.brand.domains[0]?.toLowerCase() !== submittedHost ||
      project.country !== job.input.country || project.language !== job.input.language ||
      project.promptFocus !== job.input.promptFocus) {
    throw new ProviderError('onboarding_account_changed',
      'The brand, website, market, language or focus changed during setup. Retry setup to research the corrected details before activation.', false);
  }
  if (project.onboardingAppliedJobId !== job.id && research.receipt?.instructionsVersion &&
      research.receipt.instructionsVersion !== ONBOARDING_INSTRUCTIONS_VERSION) {
    throw new ProviderError('onboarding_research_policy_changed', 'Recheck the company profile and direct rivals against current official sources.', false);
  }
  // Recheck aliases from older saved research using current identity rules.
  const verified = verifiedBrandNames(project.brand.name, job.input.website, research.brandbook);
  const names = [...new Set([project.brand.name, ...project.brand.aliases, ...verified])].slice(0, 20);
  const brandbook = { ...research.brandbook, names, domains: project.brand.domains };
  const brand = { ...project.brand, aliases: names.filter(name => name !== project.brand.name) };
  // The owner can select (or clear) competitors while research is running.
  const competitors = project.competitorsConfiguredAt || project.competitors.length
    ? project.competitors
    : competitorBrands({ id: project.id, brand }, research.competitors ?? []);
  return { brandbook, brand, competitors };
}

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
        const key = current.researchRevision ? `${root}/research-${current.researchRevision}.json` : `${root}/research.json`;
        await generateOnce(key, () => this.provider.research(current));
        current = { ...current, researchKey: key, step: 'brandbook' };
      } else if (current.step === 'brandbook') {
        const research = await artifacts.get<CapturedAnswer>(
          current.researchKey!,
        );
        if (!research) throw new Error('Missing research checkpoint');
        const primary = current.verifiedResearchKey
          ? await artifacts.get<CapturedAnswer>(current.verifiedResearchKey)
          : null;
        if (current.verifiedResearchKey && !primary) throw new Error('Missing original research checkpoint');
        const key = current.researchRevision ? `${root}/brandbook-${current.researchRevision}.json` : `${root}/brandbook.json`;
        await generateOnce(key, async () => {
          if (!current.verifiedBrandbookKey) return this.provider.brandbook(current, research);
          const original = await artifacts.get<ResearchCheckpoint>(current.verifiedBrandbookKey);
          if (!original?.brandbook || !primary) throw new Error('Missing validated company research');
          const result = await this.provider.brandbook(current, withCompetitorResearch(primary, research), original.brandbook);
          const candidates = [...(original.competitors ?? []), ...(result.competitors ?? [])];
          const unique = new Map(candidates.map(peer => [peer.domain, peer]));
          const competitors = [...unique.values()].filter(peer => !candidates.some(other =>
            other.domain !== peer.domain && promptFingerprint(other.name) === promptFingerprint(peer.name))).slice(0, 5);
          return { ...result, brandbook: original.brandbook, competitors };
        });
        const result = await artifacts.get<ResearchCheckpoint>(key);
        if (!result?.brandbook) throw new Error('Missing brandbook checkpoint');
        const project = await repository.getProject(projectId);
        if (result.competitors && result.competitors.length < 3 && !current.verifiedBrandbookKey &&
            project && !project.competitorsConfiguredAt && !project.competitors.length) {
          // Keep the verified profile while making one more search for direct alternatives.
          current = { ...current, step: 'research', verifiedBrandbookKey: key, verifiedResearchKey: current.researchKey,
            competitorSearchTerm: result.competitorSearchQuery || current.input.promptFocus ||
              result.brandbook.subIndustryCategory || result.brandbook.industryCategory || result.brandbook.keyFeatures[0],
            competitorSearchDomains: result.verificationDomains,
            researchRevision: (current.researchRevision ?? 0) + 1,
            researchFeedback: 'Find additional direct competitors using local buyer terms for the verified services and market. Look for official pages that document the competing offer and whom it serves.' };
        } else {
          current = { ...current, brandbookKey: key, step: 'prompts' };
        }
      } else if (current.step === 'prompts') {
        const book = await artifacts.get<ResearchCheckpoint>(current.brandbookKey!);
        if (!book) throw new Error('Missing brandbook checkpoint');
        const project = await repository.getProject(projectId);
        if (!project || project.onboardingJobId !== jobId)
          throw new ProviderError('onboarding_superseded', 'A newer onboarding job replaced this one.', false);
        const key = current.portfolioRevision
          ? `${root}/prompts-revision-${current.portfolioRevision}.json`
          : `${root}/prompts.json`;
        const context = portfolioContext(project, current, book);
        const rejected = current.rejectedPortfolioKey
          ? await artifacts.get<ProviderReceipt>(current.rejectedPortfolioKey) : null;
        await generateOnce(key, () => this.provider.prompts(current, context.brandbook, context.competitors,
          rejected ? previousPortfolioDraft(rejected) : undefined));
        current = { ...current, promptsKey: key, step: 'activate' };
      } else if (current.step === 'activate') {
        const book = await artifacts.get<ResearchCheckpoint>(current.brandbookKey!),
          portfolio = await artifacts.get<{ prompts: Prompt[] }>(
            current.promptsKey!,
          );
        if (!book) throw new Error('Missing brandbook checkpoint');
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
          if (!portfolio)
            throw new ProviderError('onboarding_portfolio_checkpoint_missing',
              'The saved portfolio could not be found. Retry setup to generate a replacement.', false);
          const context = portfolioContext(project, current, book);
          const prompts = validateSavedPortfolio(current, context.brandbook, portfolio.prompts, context.competitors);
          const next = {
            ...project,
            ...context,
            competitorResearch: (book.competitors ?? []).filter(candidate => candidate.relevance &&
              context.competitors.some(peer => peer.domains.includes(candidate.domain) && peer.name === candidate.name))
              .map(({name, domain, relevance}) => ({name, domain, relevance})),
            prompts,
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
          const latest = await repository.ensureProjectScanSchedule(projectId);
          if (!latest) throw new Error('Account missing');
          const context = portfolioContext(latest, current, book);
          try {
            validateSavedPortfolio(current, context.brandbook, latest.prompts.filter(p => p.active), context.competitors);
          } catch (error) {
            throw new ProviderError('onboarding_active_prompts_changed',
              `The account's active prompts no longer meet onboarding requirements. Correct them on the Prompts screen and retry setup. ${error instanceof ProviderError ? error.message : ''}`.trim(),
              false);
          }
          // Retrying a stopped/failed activation resumes its previously paused schedule.
          const resumed = current.retryRequestIds.length > 0 && !latest.enabled
            ? { ...latest, enabled: true } : latest;
          await this.syncSchedule(resumed);
          if (
            await repository.saveProject(
              markScheduleSynced(resumed, this.now().toISOString()),
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
      if (error instanceof ProviderError && error.kind === 'deferred' && error.safeToRetry) {
        const delay = Math.max(30, Math.min(86400, Math.ceil((error.retryAfterMs ?? 60000) / 1000)));
        const waiting: OnboardingJob = { ...current, status: 'queued', paidCall: undefined,
          attempts: Math.max(0, current.attempts - 1), leaseOwner: undefined,
          leaseExpiresAt: new Date(this.now().getTime() + delay * 1000).toISOString(),
          version: current.version + 1, updatedAt: this.now().toISOString() };
        if (await repository.saveOnboarding(waiting, current.version))
          await this.runtime.queue.send([{ kind: 'onboard', projectId, jobId }], Math.min(900, delay));
        return;
      }
      if (error instanceof LostLease) {
        await this.pauseFailedSetup(projectId, jobId);
        return;
      }
      let rejectedPortfolioSaved = false;
      let rejectedResearchSaved = false;
      let rejectedPortfolioKey: string | undefined;
      if (error instanceof OnboardingOutputError) {
        try {
          rejectedPortfolioKey = `${root}/attempts/${current.paidCall?.id ?? randomUUID()}/${job.step}.json`;
          await artifacts.put(rejectedPortfolioKey, error.receipt);
          rejectedPortfolioSaved = job.step === 'prompts' && error.canRevise;
          rejectedResearchSaved = error.receipt.response.status === 'completed' &&
            ['brandbook_evidence_invalid', 'onboarding_official_research_missing', 'competitor_research_evidence_missing'].includes(error.code);
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
      const needsResearch = rejectedResearchSaved ||
        (job.step === 'brandbook' && error instanceof ProviderError && !(error instanceof OnboardingOutputError) &&
          error.code === 'onboarding_official_research_missing');
      const obsoleteResearch = error instanceof ProviderError && error.code === 'onboarding_research_policy_changed';
      if (obsoleteResearch || (needsResearch && (job.step === 'research' || job.step === 'brandbook'))) {
        const fallback = current.verifiedBrandbookKey;
        if (fallback || !current.researchRevision) {
          const retry: OnboardingJob = {
            ...current, status: 'queued', attempts: 0, version: current.version + 1,
            step: fallback ? 'prompts' : 'research', brandbookKey: fallback,
            researchRevision: current.researchRevision || 1,
            researchFeedback: fallback ? undefined : (error as ProviderError).message,
            ...(obsoleteResearch ? { portfolioRevision: (current.portfolioRevision ?? 0) + 1, promptsKey: undefined } : {}),
            leaseOwner: undefined, leaseExpiresAt: undefined, paidCall: undefined,
            updatedAt: this.now().toISOString(),
          };
          if (await repository.saveOnboarding(retry, current.version))
            await queue.send([{ kind: 'onboard', projectId, jobId }]);
          return;
        }
      }
      const stalePortfolio = job.step === 'activate' && error instanceof ProviderError &&
        error.code === 'onboarding_portfolio_policy_changed';
      if ((rejectedPortfolioSaved || stalePortfolio) && error instanceof ProviderError &&
          (current.automaticPortfolioCorrections ?? 0) < maxAutomaticPortfolioCorrections) {
        // Only a known, saved rejection can start another generation. Each revision
        // has its own artifact and must acquire a fresh paid-call reservation.
        const correction: OnboardingJob = {
          ...current,
          status: 'queued',
          step: 'prompts',
          portfolioRevision: (current.portfolioRevision ?? 0) + 1,
          automaticPortfolioCorrections: (current.automaticPortfolioCorrections ?? 0) + 1,
          portfolioFeedback: { code: error.code, message: error.message },
          rejectedPortfolioKey,
          promptsKey: undefined,
          attempts: 0,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          paidCall: undefined,
          version: current.version + 1,
          updatedAt: this.now().toISOString(),
        };
        if (await repository.saveOnboarding(correction, current.version))
          await queue.send([{ kind: 'onboard', projectId, jobId }]);
        return;
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
