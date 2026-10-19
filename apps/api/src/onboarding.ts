import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  onboardingInputSchema,
  PARSER_VERSION,
  WEEKLY_SCHEDULE,
  type OnboardingJob,
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
  for (const [index, account] of input.accounts.entries()) {
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
        process.env.OPENAI_EXTRACTION_MODEL || 'gpt-4.1-mini-2025-04-14',
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
