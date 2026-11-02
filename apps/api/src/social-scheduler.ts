import { createHash } from 'node:crypto';
import { CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand, SchedulerClient, type CreateScheduleCommandInput } from '@aws-sdk/client-scheduler';
import { socialGenerationCron, type Project } from '@citevia/core';
import type { Repository } from '@citevia/storage';

export const socialScheduleName = (projectId: string, index: number) =>
  `citevia-social-${createHash('sha256').update(projectId).digest('hex').slice(0, 24)}-${index}`;

/** Name zero prepares a calendar period; remaining legacy per-slot names are removed on every repair. */
export async function syncSocialSchedule(project: Project, options: {
  mode?: string;
  client?: Pick<SchedulerClient, 'send'>;
} = {}): Promise<void> {
  if (project.demo || (options.mode ?? process.env.APP_MODE) === 'local') return;
  const settings = project.socialAutomation;
  if (!settings) return;
  const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
  const GroupName = required('SCHEDULE_GROUP');
  const client = options.client ?? new SchedulerClient({ maxAttempts: 3 });
  for (let start = 0; start < 28; start += 4) {
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, 28 - start) }, async (_, offset) => {
      const index = start + offset, Name = socialScheduleName(project.id, index);
      if (index !== 0 || !settings.enabled || !settings.slots.length) {
        try { await client.send(new DeleteScheduleCommand({ Name, GroupName })); }
        catch (error) { if ((error as Error).name !== 'ResourceNotFoundException') throw error; }
        return;
      }
      const input: CreateScheduleCommandInput = {
        Name, GroupName, ScheduleExpression: socialGenerationCron(settings), ScheduleExpressionTimezone: settings.timezone,
        FlexibleTimeWindow: { Mode: 'OFF' }, State: 'ENABLED',
        Target: { Arn: required('QUEUE_ARN'), RoleArn: required('SCHEDULER_ROLE_ARN'),
          Input: JSON.stringify({ kind: 'social-generation', projectId: project.id, revision: settings.revision,
            trigger: 'scheduled', scheduledAt: '<aws.scheduler.scheduled-time>' }),
          RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 3 },
          ...(process.env.DLQ_ARN ? { DeadLetterConfig: { Arn: process.env.DLQ_ARN } } : {}),
        },
      };
      try { await client.send(new CreateScheduleCommand(input)); }
      catch (error) {
        if ((error as Error).name !== 'ConflictException') throw error;
        await client.send(new UpdateScheduleCommand(input));
      }
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

export async function repairSocialSchedule(repository: Pick<Repository, 'getProject' | 'saveProject'>,
  projectId: string, sync = syncSocialSchedule, now = () => new Date()): Promise<Project> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const project = await repository.getProject(projectId);
    if (!project) throw new Error('Account missing');
    if (!project.socialAutomation) return project;
    try { await sync(project); }
    catch (error) {
      if (await repository.saveProject({ ...project, version: project.version + 1, updatedAt: now().toISOString(),
        socialAutomation: { ...project.socialAutomation, scheduleStatus: 'error' } }, project.version)) throw error;
      // This failed writer may have overwritten a newer writer's schedules. Repair
      // the latest revision even when that newer writer had marked itself synced.
      continue;
    }
    const saved: Project = { ...project, version: project.version + 1, updatedAt: now().toISOString(),
      socialAutomation: { ...project.socialAutomation, scheduleStatus: 'synced' } };
    if (await repository.saveProject(saved, project.version)) return saved;
  }
  const latest = await repository.getProject(projectId);
  if (latest?.socialAutomation) await repository.saveProject({ ...latest, version: latest.version + 1,
    updatedAt: now().toISOString(), socialAutomation: { ...latest.socialAutomation, scheduleStatus: 'pending' } }, latest.version);
  throw new Error('Concurrent social schedule changes');
}
