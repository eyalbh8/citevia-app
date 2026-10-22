import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ScanMessage } from '@citevia/core';
import type { ArtifactStore, JobQueue, Runtime } from './contracts.js';
import { PostgresRepository } from './postgres.js';
import { productionDatabase } from './sql.js';

export class S3Artifacts implements ArtifactStore {
  constructor(private client: S3Client, private bucket: string) {}
  async get<T>(key: string): Promise<T | null> { try { const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key:key })); if (!result.Body) throw new Error('Empty artifact'); return JSON.parse(await result.Body.transformToString()); } catch (error) { if (['NoSuchKey','NotFound'].includes((error as Error).name)) return null; throw error; } }
  async put(key: string, value: unknown) { await this.client.send(new PutObjectCommand({ Bucket:this.bucket, Key:key, Body: JSON.stringify(value), ContentType:'application/json', ServerSideEncryption:'AES256' })); }
}
export class SqsQueue implements JobQueue {
  constructor(private client: SQSClient, private url: string) {}
  async send(messages: ScanMessage[], delaySeconds = 0) {
    const delay = Math.min(900, Math.max(0, Math.ceil(Number.isFinite(delaySeconds) ? delaySeconds : 0)));
    for (let offset=0;offset<messages.length;offset+=10) {
      const result = await this.client.send(new SendMessageBatchCommand({ QueueUrl:this.url, Entries: messages.slice(offset,offset+10).map((message,i)=>({ Id:String(i), MessageBody:JSON.stringify(message), ...('projectId' in message ? { MessageGroupId: message.projectId } : {}), ...(delay ? { DelaySeconds: delay } : {}) })) }));
      if (result.Failed?.length) throw new Error(`Queue rejected ${result.Failed.length} jobs; unfinished manifest will be recovered`);
    }
  }
}
let cached: Runtime | undefined;
export function createAwsRuntime(): Runtime {
  if (cached) return cached;
  const env = (name: string) => { const value=process.env[name]; if(!value) throw new Error(`Missing ${name}`); return value; };
  const config = { maxAttempts: 3 };
  cached = {repository:new PostgresRepository(productionDatabase()),artifacts:new S3Artifacts(new S3Client(config),env('EVIDENCE_BUCKET')),queue:new SqsQueue(new SQSClient(config),env('QUEUE_URL'))};
  return cached;
}
