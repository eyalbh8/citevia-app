import { CreateScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand, type CreateScheduleCommandInput } from '@aws-sdk/client-scheduler';
import { markScheduleSynced, scanSlotCron, validScanSchedule, type Project } from '@citevia/core';
import type { Repository } from '@citevia/storage';
import { createHash } from 'node:crypto';

export const projectScheduleName = (projectId: string) =>
  `citevia-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}`;

export async function syncProjectSchedule(project: Project, options: { mode?: 'local' | 'aws' } = {}): Promise<void> {
  if ((options.mode || process.env.APP_MODE) === 'local') return;
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  if (project.scanSchedule && !validScanSchedule(project.scanSchedule)) throw new Error('Invalid saved scan schedule');
  const client = new SchedulerClient({ maxAttempts: 3 });
  const name = projectScheduleName(project.id), GroupName = required('SCHEDULE_GROUP');
  const base: CreateScheduleCommandInput = {
    Name: name, GroupName, ScheduleExpression: project.scheduleExpression, ScheduleExpressionTimezone: project.timezone,
    FlexibleTimeWindow: { Mode: 'OFF' }, State: project.enabled ? 'ENABLED' : 'DISABLED',
    Target: { Arn: required('QUEUE_ARN'), RoleArn: required('SCHEDULER_ROLE_ARN'),
      Input: JSON.stringify({ kind: 'kickoff', projectId: project.id, scheduledAt: '<aws.scheduler.scheduled-time>', trigger: 'scheduled' }),
      RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 3 },
      ...(process.env.DLQ_ARN ? { DeadLetterConfig: { Arn: process.env.DLQ_ARN } } : {}),
    },
  };
  const exists = async (Name: string) => {
    try { await client.send(new GetScheduleCommand({ Name, GroupName })); return true; }
    catch (error) { if ((error as Error).name !== 'ResourceNotFoundException') throw error; return false; }
  };
  const upsert = async (input: CreateScheduleCommandInput) => {
    if (await exists(input.Name!)) { await client.send(new UpdateScheduleCommand(input)); return; }
    try { await client.send(new CreateScheduleCommand(input)); }
    catch (error) {
      // Concurrent repair may have created it after our read. Reapply this saved version.
      if ((error as Error).name !== 'ConflictException') throw error;
      await client.send(new UpdateScheduleCommand(input));
    }
  };
  if (!project.scanSchedule) { await upsert(base); return; }
  for (const [index, slot] of project.scanSchedule.slotsUtcMinutes.entries()) {
    await upsert({ ...base, Name: `${name}-v1-${index}`, ScheduleExpression: scanSlotCron(slot), ScheduleExpressionTimezone: 'UTC',
      Target: { ...base.Target!, Input: JSON.stringify({ kind: 'kickoff', projectId: project.id,
        scheduledAt: '<aws.scheduler.scheduled-time>', trigger: 'scheduled',
        scheduleVersion: project.scanSchedule.version, scheduleSlotUtcMinute: slot }) } });
  }
  // Never disable the old schedule until both replacements were successfully applied.
  // Scanner occurrence validation also rejects deliveries from the obsolete schedule.
  if (await exists(name)) await client.send(new UpdateScheduleCommand({ ...base, State: 'DISABLED' }));
}

/** Bounded maintenance repair. Caller selects oldest pending/error rows so failures rotate fairly. */
export async function repairProjectSchedules(
  repository: Pick<Repository, 'getProject' | 'ensureProjectScanSchedule' | 'saveProject'>,
  projects: Project[],
  options: { sync?: (project: Project) => Promise<void>; now?: () => Date } = {},
): Promise<{ projectId: string; status: 'synced' | 'skipped' | 'error' }[]> {
  const outcomes: { projectId: string; status: 'synced' | 'skipped' | 'error' }[] = [];
  const sync = options.sync || syncProjectSchedule, now = options.now || (() => new Date());
  for (const selected of projects.slice(0, 5)) {
    try {
      let repaired = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await repository.getProject(selected.id);
        if (!current || !['pending', 'error'].includes(current.scheduleStatus || '')) {
          outcomes.push({ projectId: selected.id, status: 'skipped' });
          repaired = true;
          break;
        }
        const latest = await repository.ensureProjectScanSchedule(selected.id);
        if (!latest) throw new Error('Account missing');
        await sync(latest);
        if (await repository.saveProject(markScheduleSynced(latest, now().toISOString()), latest.version)) {
          outcomes.push({ projectId: selected.id, status: 'synced' });
          repaired = true;
          break;
        }
        // An edit won the race; synchronize its fresh settings before marking success.
      }
      if (!repaired) throw new Error('Concurrent schedule changes');
    } catch {
      const latest = await repository.getProject(selected.id);
      if (latest && latest.scheduleStatus !== 'synced') await repository.saveProject({ ...latest,
        scheduleStatus: 'error', version: latest.version + 1, updatedAt: now().toISOString() }, latest.version);
      outcomes.push({ projectId: selected.id, status: 'error' });
    }
  }
  return outcomes;
}
