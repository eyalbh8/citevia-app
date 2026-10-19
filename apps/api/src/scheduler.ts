import { CreateScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import type { Project } from '@citevia/core';
import { createHash } from 'node:crypto';

export async function syncProjectSchedule(project: Project): Promise<void> {
  if (process.env.APP_MODE === 'local') return;
  const required = (name: string) => { const value=process.env[name]; if(!value) throw new Error(`Missing ${name}`); return value; };
  const client = new SchedulerClient({ maxAttempts: 3 });
  const Name = `citevia-${createHash('sha256').update(project.id).digest('hex').slice(0,32)}`, GroupName = required('SCHEDULE_GROUP');
  const input = {
    Name, GroupName, ScheduleExpression: project.scheduleExpression, ScheduleExpressionTimezone: project.timezone,
    FlexibleTimeWindow: { Mode: 'OFF' as const }, State: project.enabled ? 'ENABLED' as const : 'DISABLED' as const,
    Target: { Arn: required('QUEUE_ARN'), RoleArn: required('SCHEDULER_ROLE_ARN'),
      Input: JSON.stringify({ kind:'kickoff', projectId:project.id, scheduledAt:'<aws.scheduler.scheduled-time>', trigger:'scheduled' }),
      RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 3 },
      ...(process.env.DLQ_ARN ? { DeadLetterConfig:{ Arn:process.env.DLQ_ARN } } : {}),
    },
  };
  try { await client.send(new GetScheduleCommand({ Name, GroupName })); await client.send(new UpdateScheduleCommand(input)); }
  catch(error) { if((error as Error).name!=='ResourceNotFoundException') throw error; await client.send(new CreateScheduleCommand(input)); }
}
