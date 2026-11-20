import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  onboardingInputSchema,
  PARSER_VERSION,
  WEEKLY_SCHEDULE,
  DEFAULT_PERPLEXITY_PRESET,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_ANALYSIS_MODEL,
  SCAN_PROVIDERS,
  type AccountType,
  type ScanProvider,
  type OnboardingJob,
  type OnboardingInput,
  type Project,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function onboardingScanProviders(accountType?: AccountType): readonly ScanProvider[] {
  return accountType === 'prospect' ? ['openai'] : SCAN_PROVIDERS;
}

export const defaultAnalysisModel = () =>
  process.env.ANALYSIS_MODEL || process.env.OPENAI_EXTRACTION_MODEL || DEFAULT_ANALYSIS_MODEL;

export async function getProspectPreview(repository: Runtime['repository'], project: Project) {
  if (project.accountType !== 'prospect' || !project.onboardingJobId) return null;
  const job = await repository.getOnboarding(project.id, project.onboardingJobId);
  if (!job) return null;
  const { status, step, error, firstRunId } = job;
  const run = firstRunId ? await repository.getRun(project.id, firstRunId) : null;
  return { onboardingSummary: { status, step, error, firstRunId }, run };
}

/** An explicit retry before activation may use owner-corrected account details.
 * All dependent checkpoints get new keys; the original receipts stay intact. */
export function correctedOnboardingInput(job: OnboardingJob, project: Project): OnboardingInput | undefined {
  const host = new URL(job.input.website).hostname.toLowerCase();
  const domain = project.brand.domains[0]?.toLowerCase();
  if (project.brand.name === job.input.name && domain === host &&
      project.country === job.input.country && project.language === job.input.language &&
      project.promptFocus === job.input.promptFocus) return;
  const input = onboardingInputSchema.parse({
    name: project.brand.name,
    website: domain === host ? job.input.website : `https://${domain ?? ''}`,
    region: project.country,
    language: project.language,
    ...(project.promptFocus ? { promptFocus: project.promptFocus } : {}),
  });
  return { ...job.input, name: input.name, website: input.website, country: input.region,
    language: input.language, promptFocus: input.promptFocus, timezone: project.timezone };
}
export const onboardingRequestSchema = z
  .object({ accounts: z.array(onboardingInputSchema).min(1).max(25) })
  .strict();
export async function createAccounts(
  runtime: Runtime,
  userId: string,
  requestId: string,
  raw: unknown,
  now: Date,
  maxAccounts: number,
  checkProviders?: (providers: ScanProvider[]) => void,
) {
  const input = onboardingRequestSchema.parse(raw),
    items: { project: Project; job: OnboardingJob }[] = [];
  checkProviders?.([...new Set(input.accounts.flatMap(item => onboardingScanProviders(item.accountType)))]);
  const models = {
    openai: process.env.OPENAI_GENERATION_MODEL || 'gpt-4.1-2025-04-14',
    perplexity: process.env.PERPLEXITY_PRESET || DEFAULT_PERPLEXITY_PRESET,
    gemini: process.env.GEMINI_GENERATION_MODEL || DEFAULT_GEMINI_MODEL,
  };
  // Independent per-item keys make a retry repair a partially accepted bulk request.
  for (const [index, submitted] of input.accounts.entries()) {
    const account: OnboardingInput = {
      // Preserve request hashes for existing standard-account idempotency keys.
      ...(submitted.accountType === 'prospect' ? { accountType: submitted.accountType } : {}),
      name: submitted.name,
      website: submitted.website,
      country: submitted.region,
      language: submitted.language,
      ...(submitted.promptFocus ? { promptFocus: submitted.promptFocus } : {}),
      timezone: 'UTC',
      description: '',
      manualPrompts: [],
    };
    const id = hash(`${userId}:${requestId}:${index}`).slice(0, 32),
      projectId = `account_${id}`,
      jobId = `onboard_${id}`,
      at = now.toISOString(),
      inputHash = hash(JSON.stringify(account));
    const project: Project = {
      id: projectId,
      ...(account.accountType ? { accountType: account.accountType } : {}),
      name: account.name,
      ...(account.promptFocus ? { promptFocus: account.promptFocus } : {}),
      brand: {
        id: 'target',
        name: account.name,
        aliases: [],
        domains: [new URL(account.website).hostname],
      },
      competitors: [],
      country: account.country,
      language: account.language,
      timezone: account.timezone,
      scheduleExpression: WEEKLY_SCHEDULE,
      enabled: false,
      generationModel: models.openai,
      extractionModel: defaultAnalysisModel(),
      scanProviders: onboardingScanProviders(account.accountType).map(provider => ({ provider, model: models[provider] })),
      parserVersion: PARSER_VERSION,
      version: 1,
      prompts: [],
      createdAt: at,
      updatedAt: at,
      scheduleStatus: account.accountType === 'prospect' ? 'synced' : 'pending',
      onboardingJobId: jobId,
    };
    const job: OnboardingJob = {
      id: jobId,
      projectId,
      ownerId: userId,
      requestId,
      inputHash,
      input: account,
      step: 'research',
      status: 'queued',
      version: 1,
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      deadlineAt: new Date(now.getTime() + 86400000).toISOString(),
      retryRequestIds: [],
    };
    const outcome = await runtime.repository.createOnboarding(
      project,
      job,
      maxAccounts,
    );
    if (outcome === 'limit') return { items, limitReached: true };
    const saved = await runtime.repository.getOnboarding(projectId, jobId);
    if (!saved || saved.inputHash !== inputHash)
      throw Object.assign(
        new Error(
          'This request key was already used with different account details.',
        ),
        { status: 409 },
      );
    if (account.accountType !== 'prospect') await runtime.repository.ensureProjectScanSchedule(projectId);
    if (saved.status === 'queued' || saved.status === 'running')
      await runtime.queue.send([{ kind: 'onboard', projectId, jobId }]);
    items.push({
      project: (await runtime.repository.getProject(projectId))!,
      job: saved,
    });
  }
  return { items, limitReached: false };
}
