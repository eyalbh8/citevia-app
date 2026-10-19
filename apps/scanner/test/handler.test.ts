import { describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { createHandler, parseScanMessage } from '../src/handler.js';
import type { Scanner } from '../src/engine.js';
import { instant } from './fixtures.js';

const message = { kind: 'prompt', projectId: 'project-1', runId: 'run-1', promptId: 'prompt-1' };
const record = (id: string, body: unknown, arn = 'queue-arn') => ({ messageId: id, body: JSON.stringify(body), eventSourceARN: arn });
describe('Lambda event adapter', () => {
  it('rejects malformed or unsafe internal messages', () => {
    expect(() => parseScanMessage({ ...message, projectId: '../../other-project' })).toThrow();
    expect(() => parseScanMessage({ ...message, unexpected: 'data' })).toThrow();
    expect(parseScanMessage({ kind: 'kickoff', projectId: 'project-1', scheduledAt: instant })).toMatchObject({ kind: 'kickoff' });
  });
  it('returns partial batch failures and routes DLQ deliveries explicitly', async () => {
    const handle = vi.fn().mockRejectedValueOnce(new Error('retry'));
    const handleDeadLetter = vi.fn();
    const engine = { handle, handleDeadLetter } as unknown as Scanner;
    const event = { Records: [record('failed', message), record('dead-letter', message, 'dlq-arn')] } as SQSEvent;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createHandler(engine, 'dlq-arn')(event);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'failed' }] });
    expect(handle).toHaveBeenCalledOnce();
    expect(handleDeadLetter).toHaveBeenCalledWith(message);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'scan_job_failed', messageId: 'failed', code: 'job_error' }));
    log.mockRestore();
  });
  it('accepts direct reconciliation without initializing a provider', async () => {
    const handle = vi.fn();
    const result = await createHandler({ handle } as unknown as Scanner)({ kind: 'reconcile' });
    expect(result).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledWith({ kind: 'reconcile' });
  });
});
