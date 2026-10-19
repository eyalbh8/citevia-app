import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { z } from 'zod';
import { createAwsRuntime,migrateDatabase,productionDatabase, type AnswerProvider } from '@citevia/storage';
import type { ScanMessage } from '@citevia/core';
import { Scanner } from './engine.js';
import { createOpenAIProviderFromEnv,createResponseProviderFromEnv } from './openai.js';
import { OpenAIOnboardingProvider } from './onboarding-provider.js';
import { OnboardingEngine } from './onboarding-engine.js';
import { syncProjectSchedule } from '../../api/src/scheduler.js';
import { ProviderError } from './provider.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const messageSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('onboard'),projectId:id,jobId:id}).strict(),
  z.object({ kind: z.literal('kickoff'), projectId: id, scheduledAt: z.string().datetime({ offset: true }), requestId: z.string().min(1).max(200).optional(), trigger: z.enum(['scheduled', 'manual']).optional() }).strict(),
  z.object({ kind: z.literal('prompt'), projectId: id, runId: id, promptId: id }).strict(),
  z.object({ kind: z.literal('retry'), projectId: id, runId: id, requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }).strict(),
  z.object({ kind: z.literal('reconcile') }).strict(),
]);
export const parseScanMessage = (value: unknown): ScanMessage => messageSchema.parse(value);

let scanner: Scanner | undefined;
function awsScanner(): Scanner {
  if (scanner) return scanner;
  let provider: Promise<AnswerProvider> | undefined;
  const load = () => provider ??= createOpenAIProviderFromEnv().catch(error => { provider = undefined; throw error; });
  const runtime=createAwsRuntime();let onboardingProvider:Promise<OpenAIOnboardingProvider>|undefined;
  const onboard=()=>onboardingProvider ||= createResponseProviderFromEnv().then(value=>new OpenAIOnboardingProvider(value)).catch(error=>{onboardingProvider=undefined;throw error;});
  const onboarding=new OnboardingEngine(runtime,{research:async job=>(await onboard()).research(job),brandbook:async(job,research)=>(await onboard()).brandbook(job,research),prompts:async(job,book)=>(await onboard()).prompts(job,book)},syncProjectSchedule);
  scanner = new Scanner({ ...runtime,onboarding, provider: {
    collect: async (prompt, snapshot) => (await load()).collect(prompt, snapshot),
    extract: async (answer, snapshot) => (await load()).extract(answer, snapshot),
  } });
  return scanner;
}

export function createHandler(engine: Scanner, deadLetterArn = process.env.DEAD_LETTER_QUEUE_ARN) {
  return async (event: SQSEvent | ScanMessage): Promise<SQSBatchResponse | { ok: true }> => {
    if ('Records' in event) {
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const record of event.Records) {
        try {
          const message = parseScanMessage(JSON.parse(record.body));
          if (deadLetterArn && record.eventSourceARN === deadLetterArn) await engine.handleDeadLetter(message);
          else await engine.handle(message);
        } catch (error) {
          // Structured operational logs contain identifiers and error codes only, never prompt or response text.
          console.error(JSON.stringify({ event: 'scan_job_failed', messageId: record.messageId, code: error instanceof ProviderError ? error.code : 'job_error' }));
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
      return { batchItemFailures };
    }
    await engine.handle(parseScanMessage(event));
    return { ok: true };
  };
}

export const handler = async (event: SQSEvent | ScanMessage | {kind:'database:migrate'}) => {
  // SQS payload validation rejects maintenance events. Only direct IAM-authorized invocation can migrate.
  if('kind'in event&&event.kind==='database:migrate'){await migrateDatabase(productionDatabase());return {migrated:true};}
  return createHandler(awsScanner())(event);
};
