import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { allocateScanSchedule, isCurrentScheduledOccurrence, markScheduleSynced, nextProjectScan, scanSlotCron, type Project, type ScanSchedule } from '@citevia/core';
import { MemoryRepository, PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { projectScheduleName, repairProjectSchedules, syncProjectSchedule } from '../apps/api/src/scheduler.js';
import { configureSchedules, runConfigureSchedulesCli } from '../scripts/configure-schedules.js';
import { newProject } from './fixtures/scanner.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('stable twice-weekly fleet scheduling', () => {
  it('gives a small fleet two scan days with 30-minute starts, then spreads 100 accounts without moving anyone', () => {
    const schedules: ScanSchedule[] = [];
    for (let account = 0; account < 100; account++) schedules.push(allocateScanSchedule(schedules));
    expect(schedules.slice(0, 3).map(schedule => schedule.slotsUtcMinutes)).toEqual([[360, 5400], [390, 5430], [420, 5460]]);
    expect(schedules.slice(0, 10).every(schedule => Math.floor(schedule.slotsUtcMinutes[0] / 1440) === 0 && Math.floor(schedule.slotsUtcMinutes[1] / 1440) === 3)).toBe(true);
    const slots = schedules.flatMap(schedule => schedule.slotsUtcMinutes).sort((a, b) => a - b);
    expect(new Set(slots).size).toBe(200);
    expect(schedules.every(schedule => schedule.slotsUtcMinutes[1] - schedule.slotsUtcMinutes[0] === 5040)).toBe(true);
    expect(new Set(slots.map(slot => Math.floor(slot / 1440))).size).toBe(7);
    const gaps = slots.map((slot, index) => (slots[(index + 1) % slots.length] - slot + 10080) % 10080);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(75);
    expect(scanSlotCron(360)).toBe('cron(0 6 ? * MON *)');
    expect(scanSlotCron(5400)).toBe('cron(0 18 ? * THU *)');
  });

  it('calculates the actual next slot across week boundaries and DST regardless of display timezone', () => {
    const project = { ...newProject(), scanSchedule: allocateScanSchedule([]) };
    expect(nextProjectScan(project, new Date('2026-10-22T18:00:00Z'))).toBe('2026-10-26T06:00:00.000Z');
    expect(nextProjectScan(project, new Date('2026-10-26T06:00:00Z'))).toBe('2026-10-29T18:00:00.000Z');
    expect(nextProjectScan({ ...project, timezone: 'America/New_York' }, new Date('2026-10-22T18:00:00Z'))).toBe('2026-10-26T06:00:00.000Z');
    expect(nextProjectScan({ ...project, enabled: false })).toBeNull();
    expect(nextProjectScan({ ...project, scanSchedule: { version: 1, slotsUtcMinutes: [0, 0] } })).toBeNull();
  });

  it('honors a custom legacy weekly expression instead of hardcoding Monday06 and hides unsupported predictions', () => {
    const project = { ...newProject(), scheduleExpression: 'cron(30 8 ? * TUE,FRI *)' };
    expect(nextProjectScan(project, new Date('2026-10-22T19:00:00Z'))).toBe('2026-10-23T05:30:00.000Z');
    expect(nextProjectScan({ ...project, scheduleExpression: 'rate(7 days)' })).toBeNull();
  });

  it('rejects delayed legacy events, invented slots and malformed timestamps after migration', () => {
    const project = { ...newProject(), scanSchedule: allocateScanSchedule([]) };
    const current = { scheduleVersion: 1, scheduleSlotUtcMinute: 5400, scheduledAt: '2026-10-22T18:00:00Z' };
    expect(isCurrentScheduledOccurrence(project, current)).toBe(true);
    expect(isCurrentScheduledOccurrence(project, { scheduledAt: current.scheduledAt })).toBe(false);
    expect(isCurrentScheduledOccurrence(project, { ...current, scheduleVersion: 2 })).toBe(false);
    expect(isCurrentScheduledOccurrence(project, { ...current, scheduledAt: '2026-10-22T18:01:00Z' })).toBe(false);
    expect(isCurrentScheduledOccurrence(project, { ...current, scheduledAt: 'invalid' })).toBe(false);
    expect(isCurrentScheduledOccurrence(newProject(), { scheduledAt: current.scheduledAt })).toBe(true);
  });

  it('keeps only the legacy occurrence effective after a full or partial migration failure, then switches once', () => {
    const saved = { ...newProject(), scanSchedule: allocateScanSchedule([]) };
    const legacy = { scheduledAt: '2026-10-26T04:00:00Z' };
    const replacement = { scheduledAt: '2026-10-26T06:00:00Z', scheduleVersion: 1, scheduleSlotUtcMinute: 360 };
    for (const scheduleStatus of ['pending', 'error'] as const) {
      const pending = { ...saved, scheduleStatus };
      expect(isCurrentScheduledOccurrence(pending, legacy)).toBe(true);
      expect(isCurrentScheduledOccurrence(pending, replacement)).toBe(false);
      expect(nextProjectScan(pending, new Date('2026-10-25T12:00:00Z'))).toBe('2026-10-26T04:00:00.000Z');
    }
    const active = markScheduleSynced(saved, '2026-10-25T13:00:00.000Z');
    expect(isCurrentScheduledOccurrence(active, legacy)).toBe(false);
    expect(isCurrentScheduledOccurrence(active, replacement)).toBe(true);
    // Later routine settings synchronization cannot reactivate the disabled legacy schedule.
    for (const scheduleStatus of ['pending', 'error'] as const) {
      expect(isCurrentScheduledOccurrence({ ...active, scheduleStatus }, legacy)).toBe(false);
      expect(isCurrentScheduledOccurrence({ ...active, scheduleStatus }, replacement)).toBe(true);
      expect(nextProjectScan({ ...active, scheduleStatus }, new Date('2026-10-25T12:00:00Z'))).toBe('2026-10-26T06:00:00.000Z');
    }
  });

  for (const backend of ['memory', 'postgres'] as const) it(`${backend} assigns once under concurrent onboarding and protects concurrent configuration edits`, async () => {
    const db = backend === 'postgres' ? await localPostgres() : null;
    const repository = db ? new PostgresRepository(db) : new MemoryRepository();
    try {
      const projects = Array.from({ length: 12 }, (_, index) => newProject({ id: `account-${index}` }));
      for (const project of projects) await repository.saveProject(project, null);
      const allocated = await Promise.all(projects.map(project => repository.ensureProjectScanSchedule(project.id)));
      expect(new Set(allocated.flatMap(project => project!.scanSchedule!.slotsUtcMinutes)).size).toBe(24);
      const again = await Promise.all(Array.from({ length: 5 }, () => repository.ensureProjectScanSchedule(projects[0].id)));
      expect(again.every(project => JSON.stringify(project?.scanSchedule) === JSON.stringify(allocated[0]?.scanSchedule))).toBe(true);
      expect(again.every(project => project?.version === allocated[0]?.version)).toBe(true);
      expect(await repository.saveProject({ ...projects[0], name: 'stale write', version: 2 }, 1)).toBe(false);
      const custom = { ...newProject({ id: 'custom' }), scheduleExpression: 'cron(0 8 ? * MON *)' };
      await repository.saveProject(custom, null);
      expect(await repository.ensureProjectScanSchedule(custom.id)).toEqual(custom);
      expect((await repository.ensureProjectScanSchedule(custom.id, { migrateCustom: true }))?.scanSchedule).toBeDefined();
    } finally { await db?.close(); }
  }, 30000);

  it('previews migrations without writes, preserves custom cron and repairs failed synchronization using the same slots', async () => {
    const repository = new MemoryRepository();
    const first = newProject({ id: 'first' }), second = newProject({ id: 'second' });
    const custom = { ...newProject({ id: 'custom' }), scheduleExpression: 'cron(0 8 ? * MON *)' };
    for (const project of [first, second, custom]) await repository.saveProject(project, null);
    const sync = vi.fn().mockRejectedValueOnce(new Error('AWS unavailable')).mockResolvedValue(undefined);
    const preview = await configureSchedules(repository, [first, second, custom], {}, sync);
    expect(preview.changes.map(change => change.status)).toEqual(['planned', 'planned', 'custom-preserved']);
    expect(sync).not.toHaveBeenCalled();
    expect(await repository.getProject(first.id)).toEqual(first);
    const failed = await configureSchedules(repository, [first, second, custom], { apply: true }, sync);
    expect(failed.errors).toBe(1);
    const savedSlots = (await repository.getProject(first.id))?.scanSchedule;
    const repaired = await configureSchedules(repository, [first], { apply: true }, sync);
    expect(repaired.synced).toBe(1);
    expect((await repository.getProject(first.id))?.scanSchedule?.slotsUtcMinutes).toEqual(savedSlots?.slotsUtcMinutes);
    expect((await repository.getProject(first.id))?.scanSchedule?.activatedAt).toBeDefined();
    expect(await repository.getProject(custom.id)).toEqual(custom);
  });

  it('keeps the command preview read-only and includes assignments outside the selected account', async () => {
    const db = await localPostgres();
    const repository = new PostgresRepository(db);
    const existing = { ...newProject({ id: 'existing' }), scanSchedule: allocateScanSchedule([]) };
    const next = newProject({ id: 'next' });
    await repository.saveProject(existing, null);
    await repository.saveProject(next, null);
    const transaction = vi.spyOn(db, 'transaction');
    const close = vi.spyOn(db, 'close').mockResolvedValue();
    try {
      const preview = JSON.parse(await runConfigureSchedulesCli(['--project', next.id], async () => db));
      expect(preview.changes).toEqual([expect.objectContaining({ projectId: next.id, slotsUtcMinutes: [390, 5430], status: 'planned' })]);
      expect(transaction).not.toHaveBeenCalled();
      expect(await repository.getProject(next.id)).toEqual(next);
      expect(close).toHaveBeenCalledOnce();
    } finally { close.mockRestore(); await db.close(); }
  }, 30000);
});

describe('automatic schedule repair', () => {
  it('repairs at most five accounts, isolates a cloud failure and reapplies a concurrent edit with CAS', async () => {
    const repository = new MemoryRepository();
    const projects = Array.from({ length: 7 }, (_, index) => ({ ...newProject({ id: `repair-${index}` }), scheduleStatus: 'pending' as const }));
    for (const project of projects) await repository.saveProject(project, null);
    const calls: Project[] = [];
    const now = () => new Date('2026-10-25T13:00:00.000Z');
    const outcomes = await repairProjectSchedules(repository, projects, { now, sync: async project => {
      calls.push(project);
      if (project.id === 'repair-0') throw new Error('AWS unavailable');
      if (project.id === 'repair-1' && project.enabled) await repository.saveProject({ ...project, enabled: false,
        version: project.version + 1 }, project.version);
    } });
    expect(outcomes).toHaveLength(5);
    expect(outcomes[0]).toEqual({ projectId: 'repair-0', status: 'error' });
    expect(outcomes.slice(1).every(outcome => outcome.status === 'synced')).toBe(true);
    expect(calls.filter(project => project.id === 'repair-1').map(project => project.enabled)).toEqual([true, false]);
    expect(await repository.getProject('repair-0')).toMatchObject({ scheduleStatus: 'error', updatedAt: now().toISOString() });
    expect((await repository.getProject('repair-0'))?.scanSchedule?.activatedAt).toBeUndefined();
    expect(await repository.getProject('repair-1')).toMatchObject({ enabled: false, scheduleStatus: 'synced',
      scanSchedule: { activatedAt: now().toISOString() } });
    expect((await repository.getProject('repair-5'))?.scanSchedule).toBeUndefined();
    const retry = await repairProjectSchedules(repository, [projects[0]], { now, sync: async () => {} });
    expect(retry).toEqual([{ projectId: 'repair-0', status: 'synced' }]);
    expect((await repository.getProject('repair-0'))?.scanSchedule?.activatedAt).toBe(now().toISOString());
  });
});

describe('EventBridge schedule synchronization', () => {
  function environment() {
    vi.stubEnv('APP_MODE', 'aws');
    vi.stubEnv('SCHEDULE_GROUP', 'fleet');
    vi.stubEnv('QUEUE_ARN', 'arn:queue');
    vi.stubEnv('SCHEDULER_ROLE_ARN', 'arn:role');
  }
  it('creates two independent UTC schedules before disabling legacy and sends versioned occurrences', async () => {
    environment();
    const project: Project = { ...newProject(), scanSchedule: allocateScanSchedule([]) };
    const name = projectScheduleName(project.id);
    const send = vi.spyOn(SchedulerClient.prototype, 'send').mockImplementation(async (command: any) => {
      if (command instanceof GetScheduleCommand && command.input.Name !== name) throw Object.assign(new Error(), { name: 'ResourceNotFoundException' });
      return {};
    });
    await syncProjectSchedule(project);
    const writes = send.mock.calls.map(([command]) => command).filter(command => command instanceof CreateScheduleCommand || command instanceof UpdateScheduleCommand) as (CreateScheduleCommand | UpdateScheduleCommand)[];
    expect(writes.map(command => command.input.Name)).toEqual([`${name}-v1-0`, `${name}-v1-1`, name]);
    expect(writes.map(command => command.input.ScheduleExpression)).toEqual(['cron(0 6 ? * MON *)', 'cron(0 18 ? * THU *)', project.scheduleExpression]);
    expect(writes.slice(0, 2).map(command => command.input.ScheduleExpressionTimezone)).toEqual(['UTC', 'UTC']);
    expect(JSON.parse(writes[1].input.Target!.Input!)).toMatchObject({ scheduleVersion: 1, scheduleSlotUtcMinute: 5400 });
    expect(writes[2].input.State).toBe('DISABLED');
  });

  it('leaves legacy enabled when a replacement fails, then repairs idempotently', async () => {
    environment();
    const project = { ...newProject(), scanSchedule: allocateScanSchedule([]) };
    const name = projectScheduleName(project.id);
    const send = vi.spyOn(SchedulerClient.prototype, 'send').mockImplementation(async (command: any) => {
      if (command instanceof UpdateScheduleCommand && command.input.Name === `${name}-v1-1`) throw new Error('service unavailable');
      return {};
    });
    await expect(syncProjectSchedule(project)).rejects.toThrow('service unavailable');
    expect(send.mock.calls.some(([command]) => command instanceof UpdateScheduleCommand && command.input.Name === name)).toBe(false);
    send.mockResolvedValue({} as never);
    await syncProjectSchedule(project);
    expect(send.mock.calls.some(([command]) => command instanceof UpdateScheduleCommand && command.input.Name === name && command.input.State === 'DISABLED')).toBe(true);
  });

  it('updates both schedules when an account is disabled', async () => {
    environment();
    const send = vi.spyOn(SchedulerClient.prototype, 'send').mockResolvedValue({} as never);
    await syncProjectSchedule({ ...newProject(), enabled: false, scanSchedule: allocateScanSchedule([]) });
    const updates = send.mock.calls.filter(([command]) => command instanceof UpdateScheduleCommand).map(([command]) => (command as UpdateScheduleCommand).input);
    expect(updates).toHaveLength(3);
    expect(updates.every(input => input.State === 'DISABLED')).toBe(true);
  });
});
