import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand, type SchedulerClient } from '@aws-sdk/client-scheduler';
import { MemoryRepository } from '@citevia/storage';
import type { Project } from '@citevia/core';
import { repairSocialSchedule, socialScheduleName, syncSocialSchedule } from '../apps/api/src/social-scheduler.js';
import { newProject } from './fixtures/scanner.js';

function project(): Project { return { ...newProject(), socialAutomation: { enabled: true, createBlogDrafts: true, revision: 1,
  timezone: 'Asia/Nicosia', slots: [{ id: 'monday', dayOfWeek: 1, time: '09:30' }, { id: 'friday', dayOfWeek: 5, time: '18:00' }],
  effectiveFrom: '2026-11-02T00:00:00Z', scheduleStatus: 'pending' } }; }
afterEach(() => vi.unstubAllEnvs());
describe('social schedules', () => {
  it('creates exact local weekly slots and removes obsolete bounded schedule names', async () => {
    for (const key of ['SCHEDULE_GROUP', 'QUEUE_ARN', 'SCHEDULER_ROLE_ARN']) vi.stubEnv(key, key);
    const calls: (CreateScheduleCommand | UpdateScheduleCommand | DeleteScheduleCommand)[] = [];
    const client = { send: vi.fn(async (command: typeof calls[number]) => {
      calls.push(command);
      if (command instanceof CreateScheduleCommand && command.input.Name?.endsWith('-0')) throw Object.assign(new Error(), { name: 'ConflictException' });
      if (command instanceof DeleteScheduleCommand) throw Object.assign(new Error(), { name: 'ResourceNotFoundException' });
      return {};
    }) } as unknown as Pick<SchedulerClient, 'send'>;
    const value = project();
    await syncSocialSchedule(value, { mode: 'aws', client });
    const updates = calls.filter(call => call instanceof UpdateScheduleCommand);
    expect(updates[0].input).toMatchObject({ Name: socialScheduleName(value.id, 0), ScheduleExpression: 'cron(30 9 ? * MON *)',
      ScheduleExpressionTimezone: 'Asia/Nicosia', FlexibleTimeWindow: { Mode: 'OFF' }, State: 'ENABLED' });
    expect(JSON.parse(updates[0].input.Target!.Input!)).toEqual({ kind: 'social-occurrence', projectId: value.id,
      revision: 1, slotId: 'monday', scheduledAt: '<aws.scheduler.scheduled-time>' });
    expect(calls.filter(call => call instanceof DeleteScheduleCommand)).toHaveLength(26);
  });
  it('disables all slots on pause without creating new schedules', async () => {
    vi.stubEnv('SCHEDULE_GROUP', 'group');
    const send = vi.fn(async (_command: DeleteScheduleCommand) => ({}));
    const value = project(); value.socialAutomation!.enabled = false;
    await syncSocialSchedule(value, { mode: 'aws', client: { send } as unknown as Pick<SchedulerClient, 'send'> });
    expect(send).toHaveBeenCalledTimes(28);
    expect(send.mock.calls.every(([call]) => call instanceof DeleteScheduleCommand)).toBe(true);
  });
  it('repairs a newer revision after an older writer partially overwrites schedules then fails', async () => {
    const repository = new MemoryRepository(), value = project();
    await repository.saveProject(value, null);
    const sync = vi.fn(async (incoming: Project) => {
      if (incoming.socialAutomation?.revision === 1) {
        await repository.saveProject({ ...incoming, version: incoming.version + 1,
          socialAutomation: { ...incoming.socialAutomation, revision: 2, scheduleStatus: 'synced' } }, incoming.version);
        throw new Error('old scheduler request failed');
      }
    });
    const saved = await repairSocialSchedule(repository, value.id, sync);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(saved.socialAutomation).toMatchObject({ revision: 2, scheduleStatus: 'synced' });
  });
});
