import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { z } from 'zod';
import {
  createAwsRuntime,
  migrateDatabase,
  productionDatabase,
  SqlAnalysisBatchStore,
  PostgresCallLedger,
  cleanupExpiredAuthState,
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
import { AnalysisBatchCoordinator } from './analysis-batch.js';
import { OpenAIBatchClient, type BatchClient } from './openai-batch.js';
import { providerApiKey } from './provider-http.js';

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

function maintenanceResult(event: SQSEvent | { kind: string }): SQSBatchResponse | { maintenance: true } | null {
  if (process.env.CITEVIA_MAINTENANCE_MODE !== 'true') return null;
  // Returning success for SQS would delete queued work. Preserve every record for retry, including DLQ deliveries.
  return 'Records' in event
    ? { batchItemFailures: event.Records.map(record => ({ itemIdentifier: record.messageId })) }
    : { maintenance: true };
}

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
  let batchClient: Promise<OpenAIBatchClient> | undefined;
  const client = () => (batchClient ??= providerApiKey('openai').then((apiKey) => new OpenAIBatchClient({ apiKey })).catch((error) => { batchClient = undefined; throw error; }));
  const lazyBatchClient: BatchClient = {
    upload: async (...args) => (await client()).upload(...args),
    create: async (...args) => (await client()).create(...args),
    retrieve: async (...args) => (await client()).retrieve(...args),
    find: async (...args) => (await client()).find(...args),
    download: async (...args) => (await client()).download(...args),
  };
  scanner = new Scanner({
    ...runtime,
    agents: new AgentPostEngine(runtime, createResponseProviderFromEnv),
    onboarding,
    provider: createScanProviderFromEnv(runtime),
    // Keep the port available for already-frozen Batch runs even if new batch admission is disabled.
    analysisBatch: new AnalysisBatchCoordinator({ store: new SqlAnalysisBatchStore(productionDatabase()), artifacts: runtime.artifacts, client: lazyBatchClient, ledger: new PostgresCallLedger(productionDatabase(), runtime.artifacts) }),
    maintenance: { reconcile: async () => { await cleanupExpiredAuthState(productionDatabase(), { dryRun: false, limit: 100, rateLimitRetentionDays: 7 }); } },
  });
  return scanner;
}

export function createHandler(
  engine: Scanner,
  deadLetterArn = process.env.DEAD_LETTER_QUEUE_ARN,
) {
  return async (
    event: SQSEvent | ScanMessage,
  ): Promise<SQSBatchResponse | { ok: true } | { maintenance: true }> => {
    const paused = maintenanceResult(event);
    if (paused) return paused;
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
  // Includes direct migrations/admin/reanalysis invocations; no source database writer bypasses the freeze.
  const paused = maintenanceResult(event);
  if (paused) return paused;
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
