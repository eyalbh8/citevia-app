import { expect, it, vi } from 'vitest';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueue } from '../../../packages/storage/src/aws.js';
import type { ScanMessage } from '@citevia/core';

it('delays every retry message and caps SQS timers at fifteen minutes', async () => {
  const send = vi.fn(async () => ({}));
  const queue = new SqsQueue({ send } as unknown as SQSClient, 'queue-url');
  const messages: ScanMessage[] = Array.from({ length: 11 }, (_, index) => ({ kind: 'prompt', projectId: 'account', runId: 'run', promptId: `prompt-${index}` }));
  await queue.send(messages, 1800);
  expect(send).toHaveBeenCalledTimes(2);
  for (const [command] of send.mock.calls as unknown as [{ input: { Entries: { DelaySeconds: number; MessageBody: string }[] } }][]) {
    expect(command.input.Entries.every((entry) => entry.DelaySeconds === 900)).toBe(true);
    expect(command.input.Entries.every((entry) => JSON.parse(entry.MessageBody).runId === 'run')).toBe(true);
  }
});

it('surfaces a partially rejected retry enqueue so durable reconciliation can repair it', async () => {
  const send = vi.fn(async () => ({ Failed: [{ Id: '0', Code: 'ServiceUnavailable' }] }));
  const queue = new SqsQueue({ send } as unknown as SQSClient, 'queue-url');
  await expect(queue.send([{ kind: 'prompt', projectId: 'account', runId: 'run', promptId: 'prompt' }], 60)).rejects.toThrow('Queue rejected 1 jobs');
});
