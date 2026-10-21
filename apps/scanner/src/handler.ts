import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { z } from 'zod';
import {
  createAwsRuntime,
  migrateDatabase,
  productionDatabase,
} from '@citevia/storage';
import type { ScanMessage } from '@citevia/core';
import { Scanner } from './engine.js';
import { AgentPostEngine } from './agent-posts.js';
import { createResponseProviderFromEnv } from './openai.js';
import { createScanProviderFromEnv } from './providers.js';
import { OpenAIOnboardingProvider } from './onboarding-provider.js';
import { OnboardingEngine } from './onboarding-engine.js';
import { syncProjectSchedule } from '../../api/src/scheduler.js';
import { ProviderError } from './provider.js';
import { reanalyzeCapturedRun } from './reanalysis.js';
import { refreshPortfolio } from './portfolio-refresh.js';

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent-post'), projectId: id, postId: id }).strict(),
  z.object({ kind: z.literal('onboard'), projectId: id, jobId: id }).strict(),
  z
    .object({
      kind: z.literal('kickoff'),
      projectId: id,
      scheduledAt: z.string().datetime({ offset: true }),
      requestId: z.string().min(1).max(200).optional(),
      trigger: z.enum(['scheduled', 'manual']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prompt'),
      projectId: id,
      runId: id,
      promptId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry'),
      projectId: id,
      runId: id,
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    })
    .strict(),
  z.object({ kind: z.literal('reconcile') }).strict(),
]);
export const parseScanMessage = (value: unknown): ScanMessage =>
  messageSchema.parse(value);

let scanner: Scanner | undefined;
function awsScanner(): Scanner {
  if (scanner) return scanner;
  const runtime = createAwsRuntime();
  let onboardingProvider: Promise<OpenAIOnboardingProvider> | undefined;
  const onboard = () =>
    (onboardingProvider ||= createResponseProviderFromEnv()
      .then((value) => new OpenAIOnboardingProvider(value))
      .catch((error) => {
        onboardingProvider = undefined;
        throw error;
      }));
  const onboarding = new OnboardingEngine(
    runtime,
    {
      research: async (job) => (await onboard()).research(job),
      brandbook: async (job, research) =>
        (await onboard()).brandbook(job, research),
      prompts: async (job, book, competitors) =>
        (await onboard()).prompts(job, book, competitors),
    },
    syncProjectSchedule,
  );
  scanner = new Scanner({
    ...runtime,
    agents: new AgentPostEngine(runtime, createResponseProviderFromEnv),
    onboarding,
    provider: createScanProviderFromEnv(),
  });
  return scanner;
}

export function createHandler(
  engine: Scanner,
  deadLetterArn = process.env.DEAD_LETTER_QUEUE_ARN,
) {
  return async (
    event: SQSEvent | ScanMessage,
  ): Promise<SQSBatchResponse | { ok: true }> => {
    if ('Records' in event) {
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const record of event.Records) {
        try {
          const message = parseScanMessage(JSON.parse(record.body));
          if (deadLetterArn && record.eventSourceARN === deadLetterArn)
            await engine.handleDeadLetter(message);
          else await engine.handle(message);
        } catch (error) {
          // Structured operational logs contain identifiers and error codes only, never prompt or response text.
          console.error(
            JSON.stringify({
              event: 'scan_job_failed',
              messageId: record.messageId,
              code: error instanceof ProviderError ? error.code : 'job_error',
            }),
          );
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
      return { batchItemFailures };
    }
    await engine.handle(parseScanMessage(event));
    return { ok: true };
  };
}

export const handler = async (
  event:
    | SQSEvent
    | ScanMessage
    | { kind: 'database:migrate' }
    | { kind: 'prompts:refresh'; projectId: string; requestId: string }
    | {
        kind: 'scan:reanalyze';
        projectId: string;
        runId: string;
        requestId: string;
      }
    | { kind: 'users:bootstrap-admin'; userId: string },
) => {
  if ('kind' in event && event.kind === 'prompts:refresh') {
    const input = z
      .object({
        kind: z.literal('prompts:refresh'),
        projectId: id,
        requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      })
      .strict()
      .parse(event);
    return refreshPortfolio(
      createAwsRuntime(),
      {
        prompts: async (job, book) =>
          new OpenAIOnboardingProvider(
            await createResponseProviderFromEnv(),
          ).prompts(job, book),
      },
      input.projectId,
      input.requestId,
    );
  }
  if ('kind' in event && event.kind === 'scan:reanalyze') {
    const input = z
      .object({
        kind: z.literal('scan:reanalyze'),
        projectId: id,
        runId: id,
        requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      })
      .strict()
      .parse(event);
    return reanalyzeCapturedRun(
      createAwsRuntime(),
      input.projectId,
      input.runId,
      input.requestId,
    );
  }
  // SQS payload validation rejects maintenance events. Only direct IAM-authorized invocation can migrate.
  if ('kind' in event && event.kind === 'database:migrate') {
    await migrateDatabase(productionDatabase());
    return { migrated: true };
  }
  if ('kind' in event && event.kind === 'users:bootstrap-admin') {
    const input = z
      .object({
        kind: z.literal('users:bootstrap-admin'),
        userId: z.string().uuid(),
      })
      .strict()
      .parse(event);
    await createAwsRuntime().repository.bootstrapAdmin(input.userId);
    return { adminBootstrapped: true };
  }
  return createHandler(awsScanner())(event);
};
