import { createHash, randomUUID } from 'node:crypto';
import {
  buildSummary,
  isTerminal,
  RETENTION_DAYS,
  projectProviders,
  scanProvidersSchema,
  isCurrentScheduledOccurrence,
  type ScanProvider,
  type CapturedAnswer,
  type Analysis,
  type PromptResult,
  type ScanRun,
  type ScanMessage,
  type ScanError,
} from '@citevia/core';
import type { ScannerDependencies, ScanDispatchReservation } from '@citevia/storage';
import { ExtractionError } from './openai.js';
import {
  object,
  ProviderError,
  responseFailure,
  type NativeResponse,
} from './provider.js';

export const MAX_ATTEMPTS = 4;
export const MAX_MANUAL_RETRIES = 3;
export const LEASE_MS = 12 * 60_000;
const RUN_DEADLINE_MS =
  Number(process.env.SCAN_RUN_DEADLINE_HOURS || 3) * 60 * 60_000;
// Provider Batch has a 24h window; leave time for queueing, polling and result imports.
const BATCH_RUN_DEADLINE_MS = Math.max(30, Number(process.env.ANALYSIS_BATCH_DEADLINE_HOURS || 30)) * 60 * 60_000;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);
export const runIdFor = (message: Extract<ScanMessage, { kind: 'kickoff' }>) =>
  `run_${hash(`${message.projectId}:${message.trigger ?? 'scheduled'}:${message.requestId ?? message.scheduledAt}`)}`;
export const providerRunIdFor = (
  baseId: string,
  provider: ScanProvider,
  primary: ScanProvider,
) => (provider === primary ? baseId : `run_${hash(`${baseId}:${provider}`)}`);
const rootKey = (result: PromptResult) =>
  `projects/${result.projectId}/runs/${result.runId}/prompts/${result.promptId}/generation-${result.captureGeneration ?? 0}`;
export const captureKeyFor = (result: PromptResult) =>
  `${rootKey(result)}/capture.json`;
export const analysisKeyFor = (result: PromptResult) =>
  `${rootKey(result)}/analysis.json`;

const scanError = (error: unknown): ScanError =>
  error instanceof ProviderError
    ? { code: error.code, message: error.message, retryable: error.retryable, kind: error.kind,
        safeToRetry: error.safeToRetry, retryAfterMs: error.retryAfterMs, providerCode: error.providerCode }
    : {
        code: 'internal_error',
        message:
          'The scan could not be completed. It will retry when possible.',
        retryable: true,
      };
function withoutLease(result: PromptResult): PromptResult {
  const { leaseOwner: _owner, leaseExpiresAt: _expires, ...rest } = result;
  return rest;
}
function capturedFailure(answer: CapturedAnswer): ProviderError | undefined {
  if (answer.status === 'refused')
    return new ProviderError(
      'response_refused',
      'The model refused this prompt.',
      false,
    );
  if (answer.status === 'incomplete')
    return new ProviderError(
      'response_incomplete',
      'The model returned an incomplete answer.',
      false,
    );
  if (!answer.text.trim())
    return new ProviderError(
      'response_empty',
      'The model returned no answer text.',
      false,
    );
  const native =
    !answer.provider || answer.provider === 'openai'
      ? object(object(answer.raw)?.response)
      : undefined;
  return native ? responseFailure(native as NativeResponse, true) : undefined;
}

export class Scanner {
  constructor(private readonly dependencies: ScannerDependencies) {}
  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  async handle(message: ScanMessage): Promise<void> {
    switch (message.kind) {
      case 'agent-post':
        if (!this.dependencies.agents) throw new Error('Agent post worker is not configured');
        return this.dependencies.agents.handle(message.projectId, message.postId);
      case 'onboard':
        if (!this.dependencies.onboarding)
          throw new Error('Onboarding worker is not configured');
        return this.dependencies.onboarding.handle(
          message.projectId,
          message.jobId,
        );
      case 'kickoff':
        await this.kickoff(message);
        return this.dispatch();
      case 'prompt':
        return this.dispatchedPrompt(message);
      case 'retry':
        await this.retry(message);
        return this.dispatch();
      case 'dispatch':
        return this.dispatch();
      case 'reconcile-run': {
        const run = await this.dependencies.repository.getRun(message.projectId, message.runId);
        if (run && !run.cancelledAt && ['queued', 'running'].includes(run.status)) await this.reconcileRun(run);
        else await this.dependencies.dispatch?.discardRun(message.projectId, message.runId);
        return this.dispatch();
      }
      case 'reconcile':
        // Publish independent recovery jobs before optional maintenance. A slow
        // schedule repair or onboarding service cannot hold up existing scans.
        await this.reconcile();
        await this.dispatch();
        try { await this.dependencies.maintenance?.reconcile(); }
        catch { console.error(JSON.stringify({ event: 'scanner_maintenance_failed' })); }
        try { await this.dependencies.agents?.reconcile(); }
        catch { console.error(JSON.stringify({ event: 'agent_reconcile_failed' })); }
        try { await this.dependencies.onboarding?.reconcile(); }
        catch { console.error(JSON.stringify({ event: 'onboarding_reconcile_failed' })); }
        return;
    }
  }

  /** Only a bounded set of durable intentions is delivered to SQS, across every worker. */
  private async dispatch(): Promise<void> {
    const store = this.dependencies.dispatch;
    if (!store) return;
    const setting = (name: string, fallback: number, maximum: number) => {
      const value = Number(process.env[name] ?? fallback);
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`Invalid ${name}`);
      return value;
    };
    const jobs = await store.claim({
      globalLimit: setting('SCAN_DISPATCH_MAX_OUTSTANDING', 12, 100),
      accountLimit: setting('SCAN_DISPATCH_MAX_PER_ACCOUNT', 3, 20),
      providerLimit: setting('SCAN_DISPATCH_MAX_PER_PROVIDER', 4, 40),
      leaseMs: LEASE_MS,
    });
    // A partial/uncertain SQS send keeps its reservations. Expiry repairs unsent messages;
    // replaying a successful send with the same token cannot start a second invocation.
    if (jobs.length) await this.dependencies.queue.send(jobs.map(job => ({
      kind: 'prompt', projectId: job.projectId, runId: job.runId,
      promptId: job.promptId, dispatchToken: job.token,
    })));
  }

  private async dispatchedPrompt(message: Extract<ScanMessage, { kind: 'prompt' }>): Promise<void> {
    const { dispatch: store, repository } = this.dependencies;
    if (!store) return this.prompt(message);
    const run = await repository.getRun(message.projectId, message.runId);
    if (!message.dispatchToken) {
      // Migrate already queued legacy deliveries through the same bounded admission path.
      const result = await repository.getResult(message.projectId, message.runId, message.promptId);
      if (run && !run.cancelledAt && result && !isTerminal(result.status)) {
        if (result.status === 'analysis_pending') await this.processAnalysisBatch(run);
        else await this.enqueuePrompt(result, run);
      }
      return this.dispatch();
    }
    const reservation: ScanDispatchReservation = {
      projectId: message.projectId, runId: message.runId, promptId: message.promptId,
      token: message.dispatchToken, provider: run?.snapshot.provider ?? 'openai', readyAt: this.now().toISOString(),
    };
    if (!(await store.start(reservation, LEASE_MS))) return;
    try { await this.prompt(message); }
    finally {
      const [latestRun, latest] = await Promise.all([
        repository.getRun(message.projectId, message.runId),
        repository.getResult(message.projectId, message.runId, message.promptId),
      ]);
      if (!latestRun || latestRun.cancelledAt || !latest || isTerminal(latest.status) || latest.status === 'analysis_pending')
        await store.complete(reservation);
      else await store.defer(reservation, new Date(Math.max(this.now().getTime(),
        latest.retryNotBefore ? Date.parse(latest.retryNotBefore) : 0,
        this.hasLiveLease(latest) ? Date.parse(latest.leaseExpiresAt!) : 0,
      )).toISOString(), latest.captureKey ? 'openai' : latestRun.snapshot.provider ?? 'openai');
      await this.dispatch();
    }
  }

  private async kickoff(
    message: Extract<ScanMessage, { kind: 'kickoff' }>,
  ): Promise<void> {
    const { repository, queue } = this.dependencies;
    const id = runIdFor(message);
    if (message.trigger !== 'manual' && this.dependencies.dispatch &&
        this.now().getTime() - Date.parse(message.scheduledAt) > 24 * 60 * 60_000) {
      console.warn(JSON.stringify({ event: 'scan_stale_schedule_skipped', projectId: message.projectId, scheduledAt: message.scheduledAt }));
      return;
    }
    let primary = await repository.getRun(message.projectId, id);
    if (primary?.cancelledAt) return;
    if (!primary) {
      const project = await repository.getProject(message.projectId);
      if (!project || (!project.enabled && message.trigger !== 'manual'))
        return;
      if (message.trigger !== 'manual' && !isCurrentScheduledOccurrence(project, message)) return;
      if (project.onboardingJobId) {
        const setup = await repository.getOnboarding(
          project.id,
          project.onboardingJobId,
        );
        if (!setup || ['failed', 'stopped'].includes(setup.status)) return;
        if (setup.status !== 'completed')
          throw new ProviderError(
            'onboarding_pending',
            'Account setup must complete before scanning.',
            true,
          );
      }
      const prompts = project.prompts.filter((prompt) => prompt.active);
      if (!prompts.length || prompts.length > 50)
        throw new ProviderError(
          'invalid_prompt_count',
          'A project needs 1 to 50 active prompts.',
          false,
        );
      if (!Number.isFinite(Date.parse(message.scheduledAt)))
        throw new ProviderError(
          'invalid_schedule_time',
          'The scheduled scan time is invalid.',
          false,
        );
      const now = this.now();
      const createdAt = now.toISOString();
      const expiresAt =
        Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 86400;
      const configs = scanProvidersSchema.parse(projectProviders(project));
      const snapshot = structuredClone({
        projectId: project.id,
        analysisMode: message.trigger !== 'manual' && process.env.ANALYSIS_BATCH_ENABLED === 'true' && this.dependencies.analysisBatch ? 'batch' as const : 'realtime' as const,
        projectName: project.name,
        brand: project.brand,
        competitors: project.competitors,
        prompts,
        country: project.country,
        language: project.language,
        timezone: project.timezone,
        generationModel: configs[0].model,
        provider: configs[0].provider,
        scanProviders: configs,
        extractionModel: project.extractionModel,
        ...(process.env.OPENAI_EXTRACTION_FALLBACK_MODEL?.trim() && process.env.OPENAI_EXTRACTION_FALLBACK_MODEL.trim() !== project.extractionModel
          ? { extractionFallbackModel: process.env.OPENAI_EXTRACTION_FALLBACK_MODEL.trim() } : {}),
        parserVersion: project.parserVersion,
        configVersion: project.version,
      });
      primary = {
        projectId: project.id,
        id,
        groupId: id,
        scheduledAt: message.scheduledAt,
        createdAt,
        status: 'queued',
        trigger: message.trigger ?? 'scheduled',
        snapshot,
        totalCount: prompts.length,
        terminalCount: 0,
        succeededCount: 0,
        capturedCount: 0,
        resultVersion: 0,
        deadlineAt: new Date(now.getTime() + (snapshot.analysisMode === 'batch' ? BATCH_RUN_DEADLINE_MS : RUN_DEADLINE_MS)).toISOString(),
        expiresAt,
      };
      await repository.createRun(primary, this.initialResults(primary), {
        onlyIfScheduledAccountIdle: !!this.dependencies.dispatch && primary.trigger === 'scheduled',
      });
      // A competing kickoff may have won. Its frozen configuration is authoritative.
      primary = (await repository.getRun(message.projectId, id))!;
      if (!primary) {
        console.warn(JSON.stringify({ event: 'scan_schedule_overlap_skipped', projectId: message.projectId, scheduledAt: message.scheduledAt }));
        return;
      }
      if (primary.cancelledAt) return;
    }
    // Freeze the complete portfolio on the first manifest. Replays repair partial fan-out,
    // even after project settings change. Historical OpenAI manifests stay single-provider.
    const configs = primary.snapshot.scanProviders ?? [
      {
        provider: primary.snapshot.provider ?? 'openai',
        model: primary.snapshot.generationModel,
      },
    ];
    for (const config of configs) {
      const providerId = providerRunIdFor(
        id,
        config.provider,
        configs[0].provider,
      );
      let run = await repository.getRun(message.projectId, providerId);
      if (run?.cancelledAt) continue;
      if (!run) {
        run = {
          ...primary,
          id: providerId,
          status: 'queued',
          startedAt: undefined,
          completedAt: undefined,
          terminalCount: 0,
          succeededCount: 0,
          capturedCount: 0,
          resultVersion: 0,
          summaryKey: undefined,
          summaryVersion: undefined,
          snapshot: {
            ...primary.snapshot,
            provider: config.provider,
            generationModel: config.model,
          },
        };
        await repository.createRun(run, this.initialResults(run), {
          onlyIfScheduledAccountIdle: !!this.dependencies.dispatch && run.trigger === 'scheduled',
        });
        run = await repository.getRun(message.projectId, providerId);
        if (!run || run.cancelledAt) continue;
      }
      const results = await repository.listResults(
        message.projectId,
        providerId,
      );
      if (this.dependencies.dispatch) {
        await this.enqueueResults(run!, results);
      } else await queue.send(
        results
          .filter(
            (result) =>
              !isTerminal(result.status) && !this.hasLiveLease(result) &&
              (!result.retryNotBefore || Date.parse(result.retryNotBefore) <= this.now().getTime()),
          )
          .map((result) => ({
            kind: 'prompt' as const,
            projectId: result.projectId,
            runId: result.runId,
            promptId: result.promptId,
          })),
      );
    }
  }

  private initialResults(run: ScanRun): PromptResult[] {
    return run.snapshot.prompts.map((prompt) => ({
      projectId: run.projectId,
      runId: run.id,
      promptId: prompt.id,
      responseId: `${run.id}~${prompt.id}`,
      prompt: structuredClone(prompt),
      status: 'queued',
      version: 0,
      attempts: 0,
      collectionAttempts: 0,
      analysisAttempts: 0,
      citationCount: 0,
      sourceCount: 0,
      expiresAt: run.expiresAt,
    }));
  }

  private hasLiveLease(result: PromptResult): boolean {
    return Boolean(
      result.leaseOwner &&
        result.leaseExpiresAt &&
        Date.parse(result.leaseExpiresAt) > this.now().getTime(),
    );
  }

  private deadlineFor(run: ScanRun, result: PromptResult): number {
    // A recorded retry intent also repairs a crash between the result CAS and the run deadline update.
    const retriedAt = result.lastRetryRequestedAt
      ? Date.parse(result.lastRetryRequestedAt)
      : 0;
    return Math.max(
      Date.parse(run.deadlineAt),
      retriedAt ? retriedAt + (run.snapshot.analysisMode === 'batch' ? BATCH_RUN_DEADLINE_MS : RUN_DEADLINE_MS) : 0,
    );
  }

  private stageAttempts(result: PromptResult, stage: 'collection' | 'analysis'): number {
    // Conservatively retain the consumed budget of manifests written before stage counters existed.
    return stage === 'collection'
      ? result.collectionAttempts ?? (result.captureKey ? 1 : result.attempts)
      : result.analysisAttempts ?? (result.captureKey ? result.attempts : 0);
  }

  private retryDelay(result: PromptResult, stage: 'collection' | 'analysis', retryAfterMs = 0): number {
    const attempt = this.stageAttempts(result, stage);
    // Stable per-prompt jitter avoids synchronized replays and survives Lambda redelivery.
    const jitter = 0.75 + parseInt(hash(`${result.responseId}:${stage}:${attempt}`).slice(0, 4), 16) / 65535 / 2;
    const backoff = Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1) * jitter);
    return Math.max(backoff, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
  }

  private async enqueueResults(run: ScanRun, results: PromptResult[]): Promise<void> {
    await this.dependencies.dispatch!.enqueue(results
      .filter(result => !isTerminal(result.status) && result.status !== 'analysis_pending')
      .map(result => ({ projectId: result.projectId, runId: result.runId, promptId: result.promptId,
        provider: result.captureKey ? 'openai' : run.snapshot.provider ?? 'openai',
        readyAt: new Date(Math.max(this.now().getTime(),
          result.retryNotBefore ? Date.parse(result.retryNotBefore) : 0,
          this.hasLiveLease(result) ? Date.parse(result.leaseExpiresAt!) : 0,
        )).toISOString(),
      })));
  }

  private async enqueuePrompt(result: PromptResult, knownRun?: ScanRun): Promise<void> {
    const remaining = result.retryNotBefore ? Date.parse(result.retryNotBefore) - this.now().getTime() : 0;
    if (this.dependencies.dispatch) {
      const run = knownRun ?? await this.dependencies.repository.getRun(result.projectId, result.runId);
      if (!run || run.cancelledAt) return;
      await this.enqueueResults(run, [result]);
      // Short retry wakeups avoid polling an idle database every minute. The existing
      // reconciliation schedule repairs failed wake sends and cooldowns over 15 minutes.
      if (remaining > 0) await this.dependencies.queue.send([{ kind: 'dispatch' }], Math.min(900, Math.ceil(remaining / 1000)));
      return;
    }
    await this.dependencies.queue.send([{
      kind: 'prompt', projectId: result.projectId, runId: result.runId, promptId: result.promptId,
    }], Math.min(900, Math.max(0, Math.ceil(remaining / 1000))));
  }

  private async prompt(
    message: Extract<ScanMessage, { kind: 'prompt' }>,
  ): Promise<void> {
    const { repository, artifacts, provider } = this.dependencies;
    const run = await repository.getRun(message.projectId, message.runId);
    const existing = await repository.getResult(
      message.projectId,
      message.runId,
      message.promptId,
    );
    if (!run || run.cancelledAt || !existing) return;
    if (isTerminal(existing.status)) {
      await this.finalize(message.projectId, message.runId);
      return;
    }
    if (this.hasLiveLease(existing)) return;
    if (existing.retryNotBefore && Date.parse(existing.retryNotBefore) > this.now().getTime()) {
      // SQS supports at most 15 minutes of delay. Longer provider cooldowns remain durable here.
      await this.enqueuePrompt(existing);
      return;
    }
    if (existing.status === 'analysis_pending') {
      // Poll first: a submitted batch owns its full processing window even when
      // collection used most of the original run deadline.
      await this.processAnalysisBatch(run);
      return;
    }
    const deadline = this.deadlineFor(run, existing);
    if (deadline <= this.now().getTime()) {
      await this.exhaust(
        existing,
        'retry_exhausted',
        'The scan exceeded its retry or time limit.',
      );
      return;
    }
    let current: PromptResult = {
      ...existing,
      version: existing.version + 1,
      collectionAttempts: this.stageAttempts(existing, 'collection'),
      analysisAttempts: this.stageAttempts(existing, 'analysis'),
      leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(this.now().getTime() + LEASE_MS).toISOString(),
      status: existing.captureKey ? 'extracting' : 'collecting',
    };
    delete current.retryNotBefore;
    if (!(await repository.commitResult(current, existing))) return;
    await repository.markRunRunning(
      message.projectId,
      message.runId,
      deadline > Date.parse(run.deadlineAt)
        ? new Date(deadline).toISOString()
        : undefined,
    );
    run.deadlineAt = new Date(deadline).toISOString();
    let answer: CapturedAnswer | null = null;
    let stage: 'collection' | 'analysis' = existing.captureKey ? 'analysis' : 'collection';
    const beginCall = async (nextStage: 'collection' | 'analysis'): Promise<boolean> => {
      stage = nextStage;
      const attempts = this.stageAttempts(current, nextStage);
      if (attempts >= MAX_ATTEMPTS)
        throw new ProviderError('retry_exhausted', 'This stage exhausted its initial call and three retries.', false);
      if (attempts > 0 && current.safeRetryStage !== nextStage)
        throw new ProviderError(
          nextStage === 'collection' ? 'scan_call_uncertain' : 'analysis_call_uncertain',
          'A previous provider attempt has no saved result. Review its outcome before retrying explicitly.',
          false,
        );
      const checkpoint: PromptResult = {
        ...current, version: current.version + 1, pendingCallStage: nextStage,
        ...(nextStage === 'collection' ? { collectionAttempts: attempts + 1 } : { analysisAttempts: attempts + 1 }),
      };
      checkpoint.attempts = Math.max(checkpoint.collectionAttempts ?? 0, checkpoint.analysisAttempts ?? 0);
      delete checkpoint.safeRetryStage;
      if (!(await repository.commitResult(checkpoint, current))) return false;
      current = checkpoint;
      return true;
    };
    try {
      // Read the deterministic checkpoint even if a prior invocation died before saving its DB key.
      const captureKey = current.captureKey ?? captureKeyFor(current);
      answer = await artifacts.get<CapturedAnswer>(captureKey);
      if (!answer) {
        if (run.reanalysisOf)
          throw new ProviderError(
            'saved_answer_missing',
            'The saved answer is unavailable. Reanalysis never purchases a replacement answer.',
            false,
          );
        if (!(await beginCall('collection'))) return;
        answer = await provider.collect(current.prompt.text, { ...run.snapshot, projectId: run.projectId, execution: { runId: run.id, promptId: current.promptId, attempt: current.collectionAttempts! } });
        await artifacts.put(captureKey, answer);
      }
      const captured: PromptResult = {
        ...current,
        version: current.version + 1,
        status: 'captured',
        captureKey,
        ...(!capturedFailure(answer) ? { capturedAt: answer.createdAt } : {}),
        model: answer.model,
        usage: answer.usage,
        citationCount: answer.citations.length,
        sourceCount: answer.sources.length,
      };
      if (captured.pendingCallStage === 'collection') delete captured.pendingCallStage;
      if (captured.safeRetryStage === 'collection') delete captured.safeRetryStage;
      if (!(await repository.commitResult(captured, current))) return;
      current = captured;
      const failure = capturedFailure(answer);
      if (failure) {
        const terminal: PromptResult = {
          ...withoutLease(current),
          version: current.version + 1,
          status:
            answer.status === 'refused'
              ? 'refused'
              : answer.status === 'incomplete'
                ? 'incomplete'
                : 'failed_collection',
          completedAt: this.now().toISOString(),
          error: scanError(failure),
        };
        await repository.commitResult(terminal, current);
        await this.finalize(message.projectId, message.runId);
        return;
      }
      const extracting: PromptResult = {
        ...current,
        version: current.version + 1,
        status: 'extracting',
      };
      if (!(await repository.commitResult(extracting, current))) return;
      current = extracting;
      const analysisKey = current.analysisKey ?? analysisKeyFor(current);
      let analysis = await artifacts.get<Analysis>(analysisKey);
      if (!analysis) {
        if (run.snapshot.analysisMode === 'batch') {
          if (!this.dependencies.analysisBatch)
            throw new ProviderError('analysis_batch_unavailable', 'Batch analysis is unavailable. No realtime replacement call was purchased.', false);
          const attempts = this.stageAttempts(current, 'analysis');
          if (attempts >= MAX_ATTEMPTS)
            throw new ProviderError('retry_exhausted', 'Analysis exhausted its initial call and three retries.', false);
          const pending: PromptResult = { ...withoutLease(current), version: current.version + 1, status: 'analysis_pending', analysisAttempts: attempts + 1, attempts: Math.max(current.collectionAttempts ?? 0, attempts + 1) };
          delete pending.safeRetryStage;
          delete pending.pendingCallStage;
          if (!(await repository.commitResult(pending, current))) return;
          current = pending;
          await this.processAnalysisBatch(run);
          return;
        }
        if (!(await beginCall('analysis'))) return;
        analysis = await provider.extract(answer, { ...run.snapshot, projectId: run.projectId, execution: { runId: run.id, promptId: current.promptId, attempt: current.analysisAttempts! } });
        await artifacts.put(analysisKey, analysis);
      }
      const target = analysis.brands.find(
        (brand) => brand.brandId === run.snapshot.brand.id,
      );
      if (!target)
        throw new ProviderError(
          'missing_target_analysis',
          'The analysis did not contain the tracked brand.',
          true,
        );
      const succeeded: PromptResult = {
        ...withoutLease(current),
        version: current.version + 1,
        status: 'succeeded',
        analysisKey,
        target,
        brands: analysis.brands,
        extractionUsage: analysis.usage,
        completedAt: this.now().toISOString(),
      };
      delete succeeded.error;
      delete succeeded.pendingCallStage;
      delete succeeded.safeRetryStage;
      if (await repository.commitResult(succeeded, current))
        await this.finalize(message.projectId, message.runId);
    } catch (error) {
      // Batch transport/storage failures are reconciled from durable state, without resetting item attempts.
      if (current.status === 'analysis_pending') throw error;
      const failure = scanError(error);
      if (error instanceof ExtractionError) {
        await artifacts.put(
          `${rootKey(current)}/extraction-attempt-${current.attempts}.json`,
          error.receipt,
        );
      }
      const deferred = error instanceof ProviderError && error.kind === 'deferred';
      const blockedBeforeHttp = error instanceof ProviderError && error.kind === 'quota' && error.code === 'provider_quota_blocked';
      const safeProviderRetry = error instanceof ProviderError && error.safeToRetry && error.kind !== 'quota';
      const infrastructureRetry = !(error instanceof ProviderError);
      const retryAfterMs = error instanceof ProviderError ? error.retryAfterMs : undefined;
      const delay = deferred ? Math.max(1000, retryAfterMs ?? 15_000) : this.retryDelay(current, stage, retryAfterMs);
      const retryTimestamp = this.now().getTime() + delay;
      const retryable = failure.retryable && (safeProviderRetry || infrastructureRetry) &&
        (deferred || this.stageAttempts(current, stage) < MAX_ATTEMPTS || infrastructureRetry) &&
        Number.isFinite(retryTimestamp) && Date.parse(run.deadlineAt) > retryTimestamp;
      const next: PromptResult = {
        ...withoutLease(current),
        version: current.version + 1,
        status: retryable
          ? current.captureKey
            ? 'captured'
            : 'queued'
          : current.captureKey
            ? 'failed_extraction'
            : 'failed_collection',
        error: { ...failure, retryable },
        ...(retryable ? {} : { completedAt: this.now().toISOString() }),
      };
      if (deferred || blockedBeforeHttp) {
        // Admission happens before HTTP. Waiting or a known quota circuit cannot consume a paid-call budget.
        if (stage === 'collection') next.collectionAttempts = Math.max(0, (current.collectionAttempts ?? 0) - 1);
        else next.analysisAttempts = Math.max(0, (current.analysisAttempts ?? 0) - 1);
        next.attempts = Math.max(next.collectionAttempts ?? 0, next.analysisAttempts ?? 0);
        delete next.pendingCallStage;
      }
      if (safeProviderRetry) {
        delete next.pendingCallStage;
        next.safeRetryStage = stage;
      }
      if (retryable) next.retryNotBefore = new Date(retryTimestamp).toISOString();
      if (!(await repository.commitResult(next, current))) return;
      if (retryable) {
        await this.enqueuePrompt(next);
        return;
      }
      await this.finalize(message.projectId, message.runId);
    }
  }

  private async processAnalysisBatch(run: ScanRun): Promise<void> {
    const { repository, analysisBatch } = this.dependencies;
    if (run.cancelledAt || !analysisBatch || run.snapshot.analysisMode !== 'batch') return;
    const results = await repository.listResults(run.projectId, run.id);
    if (results.some((result) => !isTerminal(result.status) && result.status !== 'analysis_pending')) return;
    const { batchId, updates, deadlineAt } = await analysisBatch.process(run, results);
    if (deadlineAt && Date.parse(deadlineAt) > Date.parse(run.deadlineAt)) {
      await repository.markRunRunning(run.projectId, run.id, deadlineAt);
      run.deadlineAt = deadlineAt;
    }
    const retries: PromptResult[] = [];
    for (const update of updates) {
      const result = await repository.getResult(run.projectId, run.id, update.promptId);
      if (!result || result.status !== 'analysis_pending' || result.captureKey !== update.captureKey || result.lastRetryRequestId !== update.retryRequestId ||
        (update.analysisAttempt !== undefined && update.analysisAttempt !== this.stageAttempts(result, 'analysis'))) continue;
      const target = update.analysis?.brands.find((brand) => brand.brandId === run.snapshot.brand.id);
      const next: PromptResult = {
        ...withoutLease(result), version: result.version + 1,
        status: target && update.analysis && update.analysisKey ? 'succeeded' : 'failed_extraction',
        completedAt: this.now().toISOString(),
      };
      if (target && update.analysis && update.analysisKey) {
        next.analysisKey = update.analysisKey;
        next.target = target;
        next.brands = update.analysis.brands;
        next.extractionUsage = update.analysis.usage;
        delete next.error;
      } else {
        const failure = update.error ?? { code: 'analysis_batch_invalid_analysis', message: 'Batch analysis did not contain the tracked brand.', retryable: false };
        const retryTimestamp = this.now().getTime() + this.retryDelay(result, 'analysis', failure.retryAfterMs);
        const retryable = failure.retryable && failure.safeToRetry === true &&
          (failure.kind === 'rate_limit' || failure.kind === 'transient') &&
          this.stageAttempts(result, 'analysis') < MAX_ATTEMPTS &&
          Number.isFinite(retryTimestamp) && this.deadlineFor(run, result) > retryTimestamp;
        next.error = { ...failure, retryable };
        if (retryable) {
          next.status = 'captured';
          next.safeRetryStage = 'analysis';
          next.retryNotBefore = new Date(retryTimestamp).toISOString();
          delete next.completedAt;
        }
      }
      if (await repository.commitResult(next, result)) {
        if (next.retryNotBefore && next.status === 'captured') retries.push(next);
      }
    }
    if (batchId) {
      const remaining = await repository.listResults(run.projectId, run.id);
      if (!remaining.some((result) => result.status === 'analysis_pending' && updates.some((update) => update.promptId === result.promptId && update.captureKey === result.captureKey && update.retryRequestId === result.lastRetryRequestId &&
        (update.analysisAttempt === undefined || update.analysisAttempt === this.stageAttempts(result, 'analysis'))))) await analysisBatch.complete(batchId);
    }
    // Finish the old batch before scheduling its next generation. Reconciliation repairs queue failures.
    for (const result of retries) await this.enqueuePrompt(result);
    await this.finalize(run.projectId, run.id);
  }

  private async exhaust(
    result: PromptResult,
    code: string,
    message: string,
  ): Promise<void> {
    if (isTerminal(result.status)) return;
    await this.dependencies.repository.commitResult(
      {
        ...withoutLease(result),
        version: result.version + 1,
        status: result.captureKey ? 'failed_extraction' : 'failed_collection',
        error: { code, message, retryable: false },
        completedAt: this.now().toISOString(),
      },
      result,
    );
    await this.finalize(result.projectId, result.runId);
  }

  private async retry(
    message: Extract<ScanMessage, { kind: 'retry' }>,
  ): Promise<void> {
    const { repository, queue } = this.dependencies;
    const run = await repository.getRun(message.projectId, message.runId);
    if (!run || run.cancelledAt) return;
    const results = await repository.listResults(
      message.projectId,
      message.runId,
    );
    const priorStamp = results
      .filter(
        (result) =>
          result.lastRetryRequestId === message.requestId &&
          result.lastRetryRequestedAt,
      )
      .map((result) => result.lastRetryRequestedAt!)
      .sort()[0];
    const requestedAt = priorStamp ?? this.now().toISOString();
    for (const result of results) {
      if (
        result.status !== 'failed_collection' &&
        result.status !== 'failed_extraction'
      )
        continue;
      const history =
        result.retryRequestIds ??
        (result.lastRetryRequestId ? [result.lastRetryRequestId] : []);
      if (
        history.includes(message.requestId) ||
        history.length >= MAX_MANUAL_RETRIES ||
        this.stageAttempts(result, result.status === 'failed_collection' ? 'collection' : 'analysis') >= MAX_ATTEMPTS
      )
        continue;
      const next: PromptResult = {
        ...withoutLease(result),
        version: result.version + 1,
        collectionAttempts: this.stageAttempts(result, 'collection'),
        analysisAttempts: this.stageAttempts(result, 'analysis'),
        status: result.status === 'failed_extraction' ? 'captured' : 'queued',
        safeRetryStage: result.status === 'failed_collection' ? 'collection' : 'analysis',
        lastRetryRequestId: message.requestId,
        lastRetryRequestedAt: requestedAt,
        retryRequestIds: [...history, message.requestId],
      };
      delete next.completedAt;
      delete next.error;
      delete next.pendingCallStage;
      delete next.retryNotBefore;
      if (result.status === 'failed_collection') {
        // Keep previous private evidence while preserving the response ID used by client links.
        next.captureGeneration = (result.captureGeneration ?? 0) + 1;
        delete next.captureKey;
        delete next.analysisKey;
        delete next.capturedAt;
        delete next.usage;
        next.citationCount = 0;
        next.sourceCount = 0;
      }
      await repository.commitResult(next, result);
    }
    // Re-read after CAS: duplicate retry deliveries repair partial fan-out, without resetting jobs again.
    const pending = (
      await repository.listResults(message.projectId, message.runId)
    ).filter(
      (result) =>
        result.lastRetryRequestId === message.requestId &&
        !isTerminal(result.status),
    );
    if (!pending.length) return;
    const deadline = Math.max(
      ...pending.map((result) => this.deadlineFor(run, result)),
    );
    const latest = await repository.getRun(message.projectId, message.runId);
    if (latest && deadline > Date.parse(latest.deadlineAt)) {
      await repository.markRunRunning(
        message.projectId,
        message.runId,
        new Date(deadline).toISOString(),
      );
    }
    if (this.dependencies.dispatch) await this.enqueueResults(run, pending);
    else await queue.send(
      pending
        .filter((result) => !this.hasLiveLease(result) &&
          (!result.retryNotBefore || Date.parse(result.retryNotBefore) <= this.now().getTime()))
        .map((result) => ({
          kind: 'prompt' as const,
          projectId: result.projectId,
          runId: result.runId,
          promptId: result.promptId,
        })),
    );
  }

  private async reconcile(): Promise<void> {
    const { repository, queue } = this.dependencies;
    const active = await repository.listActiveRuns();
    if (this.dependencies.dispatch) {
      // One long-running batch lookup/import must not monopolize the fleet's
      // reconciliation invocation. SQS bounds workers; the batch store fences polls.
      await queue.send(active.map(run => ({ kind: 'reconcile-run', projectId: run.projectId, runId: run.id })));
      return;
    }
    for (const run of active) {
      try { await this.reconcileRun(run); }
      catch { console.error(JSON.stringify({ event: 'scan_reconcile_failed', projectId: run.projectId, runId: run.id })); }
    }
  }

  private async reconcileRun(run: ScanRun): Promise<void> {
      const { repository, queue } = this.dependencies;
      if (run.cancelledAt) {
        await this.dependencies.dispatch?.discardRun(run.projectId, run.id);
        return;
      }
      await this.processAnalysisBatch(run);
      const refreshed = await repository.getRun(run.projectId, run.id);
      if (refreshed) run.deadlineAt = refreshed.deadlineAt;
      const results = await repository.listResults(run.projectId, run.id);
      const jobs: ScanMessage[] = [];
      for (const result of results) {
        if (isTerminal(result.status) || this.hasLiveLease(result)) continue;
        // Finish collection timeouts first. Captured answers can then form a batch
        // even if another prompt never produced an answer.
        if (result.status === 'analysis_pending') continue;
        if (
          this.deadlineFor(run, result) <= this.now().getTime()
        ) {
          await this.exhaust(
            result,
            'retry_exhausted',
            'The scan exceeded its retry or time limit.',
          );
        } else if (!result.retryNotBefore || Date.parse(result.retryNotBefore) <= this.now().getTime())
          jobs.push({
            kind: 'prompt',
            projectId: run.projectId,
            runId: run.id,
            promptId: result.promptId,
          });
      }
      await this.processAnalysisBatch(run);
      const afterBatch = await repository.getRun(run.projectId, run.id);
      if (afterBatch) run.deadlineAt = afterBatch.deadlineAt;
      for (const result of await repository.listResults(run.projectId, run.id)) {
        if (result.status === 'analysis_pending' && this.deadlineFor(run, result) <= this.now().getTime())
          await this.exhaust(result, 'analysis_batch_deadline', 'Analysis batch exceeded its processing deadline. Review its submission before retrying.');
      }
      if (this.dependencies.dispatch) await this.enqueueResults(run, await repository.listResults(run.projectId, run.id));
      else await queue.send(jobs);
      await this.finalize(run.projectId, run.id);
  }

  async handleDeadLetter(message: ScanMessage): Promise<void> {
    if (message.kind === 'agent-post') {
      if (!this.dependencies.agents) throw new Error('Agent post worker is not configured');
      await this.dependencies.agents.deadLetter(message.projectId, message.postId);
      return;
    }
    if (message.kind === 'onboard') {
      await this.dependencies.onboarding?.deadLetter(
        message.projectId,
        message.jobId,
      );
      return;
    }
    if (message.kind === 'prompt') {
      // Dispatch leases, checkpoint budgets and reconciliation own prompt recovery.
      // A stale SQS delivery reaching the DLQ must not terminate its newer generation.
      if (this.dependencies.dispatch) return this.dispatch();
      const run = await this.dependencies.repository.getRun(message.projectId, message.runId);
      if (!run || run.cancelledAt) return;
      const result = await this.dependencies.repository.getResult(
        message.projectId,
        message.runId,
        message.promptId,
      );
      // SQS delivery exhaustion must not terminate a successfully submitted asynchronous batch.
      // Durable batch state has its own deadline and is recovered by scheduled reconciliation.
      if (result?.status === 'analysis_pending') return;
      // Retry state lives in Postgres, not SQS receive counts. A duplicate old delivery
      // reaching the DLQ must not cancel a waiting retry or bypass its provider budget.
      if (result?.retryNotBefore && !isTerminal(result.status)) {
        await this.enqueuePrompt(result);
        return;
      }
      if (result && !this.hasLiveLease(result))
        await this.exhaust(
          result,
          'queue_delivery_exhausted',
          'Queue delivery retries were exhausted.',
        );
      return;
    }
    // Kickoff/retry messages contain no paid calls and can safely repair partial queue dispatch.
    await this.handle(message);
  }

  async finalize(projectId: string, runId: string): Promise<void> {
    const { repository, artifacts } = this.dependencies;
    const run = await repository.getRun(projectId, runId);
    if (!run || run.cancelledAt || run.terminalCount !== run.totalCount || !run.totalCount) return;
    if (
      run.summaryVersion === run.resultVersion &&
      ['completed', 'partial', 'failed'].includes(run.status)
    ) {
      await this.dependencies.dispatch?.discardRun(projectId, runId);
      return;
    }
    const results = await repository.listResults(projectId, runId);
    if (
      results.length !== run.totalCount ||
      !results.every((result) => isTerminal(result.status))
    )
      return;
    const details = await Promise.all(
      results.map(async (result) => ({
        result,
        answer: result.captureKey
          ? await artifacts.get<CapturedAnswer>(result.captureKey)
          : null,
        analysis: result.analysisKey
          ? await artifacts.get<Analysis>(result.analysisKey)
          : null,
      })),
    );
    const summary = buildSummary(run, results, details);
    for (const item of details)
      await repository.saveMeasurement(
        item.result,
        run,
        item.answer,
        item.analysis,
      );
    const summaryKey = `projects/${projectId}/runs/${runId}/summaries/v${run.resultVersion}.json`;
    await artifacts.put(summaryKey, summary);
    const status =
      run.succeededCount === run.totalCount
        ? 'completed'
        : run.succeededCount === 0
          ? 'failed'
          : 'partial';
    const finalized = await repository.finalizeRun(
      projectId,
      runId,
      run.resultVersion,
      status,
      summaryKey,
      this.now().toISOString(),
    );
    if (finalized) await this.dependencies.dispatch?.discardRun(projectId, runId);
  }
}
