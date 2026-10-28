import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  onboardingInputSchema,
  PARSER_VERSION,
  WEEKLY_SCHEDULE,
  DEFAULT_PERPLEXITY_PRESET,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_ANALYSIS_MODEL,
  type OnboardingJob,
  type OnboardingInput,
  type Project,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
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
) {
  const input = onboardingRequestSchema.parse(raw),
    items: { project: Project; job: OnboardingJob }[] = [];
  // Independent per-item keys make a retry repair a partially accepted bulk request.
  for (const [index, submitted] of input.accounts.entries()) {
    const account: OnboardingInput = {
      name: submitted.name,
      website: submitted.website,
      country: submitted.region,
      language: submitted.language,
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
      name: account.name,
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
      generationModel:
        process.env.OPENAI_GENERATION_MODEL || 'gpt-4.1-2025-04-14',
      extractionModel:
        process.env.ANALYSIS_MODEL || process.env.OPENAI_EXTRACTION_MODEL || DEFAULT_ANALYSIS_MODEL,
      scanProviders: [
        {
          provider: 'openai',
          model: process.env.OPENAI_GENERATION_MODEL || 'gpt-4.1-2025-04-14',
        },
        {
          provider: 'perplexity',
          model: process.env.PERPLEXITY_PRESET || DEFAULT_PERPLEXITY_PRESET,
        },
        {
          provider: 'gemini',
          model: process.env.GEMINI_GENERATION_MODEL || DEFAULT_GEMINI_MODEL,
        },
      ],
      parserVersion: PARSER_VERSION,
      version: 1,
      prompts: [],
      createdAt: at,
      updatedAt: at,
      scheduleStatus: 'pending',
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
    await runtime.repository.ensureProjectScanSchedule(projectId);
    const saved = await runtime.repository.getOnboarding(projectId, jobId);
    if (!saved || saved.inputHash !== inputHash)
      throw Object.assign(
        new Error(
          'This request key was already used with different account details.',
        ),
        { status: 409 },
      );
    if (!['failed', 'completed'].includes(saved.status))
      await runtime.queue.send([{ kind: 'onboard', projectId, jobId }]);
    items.push({
      project: (await runtime.repository.getProject(projectId))!,
      job: saved,
    });
  }
  return { items, limitReached: false };
}
