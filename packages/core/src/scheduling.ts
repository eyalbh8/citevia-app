import type { Project } from './types.js';

export type ScanSchedule = NonNullable<Project['scanSchedule']>;
export const SCAN_WEEK_MINUTES = 7 * 24 * 60;
export const SCAN_INTERVAL_MINUTES = SCAN_WEEK_MINUTES / 2;
export const DEFAULT_SCAN_RUNS_PER_WEEK = 2;
export const MAX_SCAN_RUNS_PER_WEEK = 7;
const mondayEpoch = Date.UTC(2026, 0, 5);
const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function validScanSchedule(schedule: ScanSchedule | undefined): schedule is ScanSchedule {
  return Boolean(schedule && Number.isSafeInteger(schedule.version) && schedule.version > 0 &&
    Array.isArray(schedule.slotsUtcMinutes) && validScanFrequency(schedule.slotsUtcMinutes.length) &&
    schedule.slotsUtcMinutes.every(value => Number.isInteger(value) && value >= 0 && value < SCAN_WEEK_MINUTES) &&
    schedule.slotsUtcMinutes.every((slot, index) =>
      slot === (schedule.slotsUtcMinutes[0] + index * SCAN_WEEK_MINUTES / schedule.slotsUtcMinutes.length) % SCAN_WEEK_MINUTES));
}

function validScanFrequency(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SCAN_RUNS_PER_WEEK;
}

export function projectScanRunsPerWeek(project: Pick<Project, 'scanSchedule' | 'scanRunsPerWeek'>): number {
  if (validScanSchedule(project.scanSchedule)) return project.scanSchedule.slotsUtcMinutes.length;
  return validScanFrequency(project.scanRunsPerWeek!) ? project.scanRunsPerWeek! : DEFAULT_SCAN_RUNS_PER_WEEK;
}

/** The week divides evenly into minutes for every supported frequency, including seven. */
export function resizeScanSchedule(schedule: ScanSchedule, runsPerWeek: number): ScanSchedule {
  if (!validScanSchedule(schedule) || !validScanFrequency(runsPerWeek)) throw new Error('Invalid weekly scan frequency');
  if (schedule.slotsUtcMinutes.length === runsPerWeek) return schedule;
  if (schedule.version === Number.MAX_SAFE_INTEGER) throw new Error('Scan schedule version exhausted');
  return { ...schedule, version: schedule.version + 1,
    slotsUtcMinutes: Array.from({ length: runsPerWeek }, (_, index) =>
      (schedule.slotsUtcMinutes[0] + index * SCAN_WEEK_MINUTES / runsPerWeek) % SCAN_WEEK_MINUTES) };
}

/** Persist the result under a global allocation lock. Existing assignments never move. */
export function allocateScanSchedule(existing: (ScanSchedule | undefined)[], runsPerWeek = DEFAULT_SCAN_RUNS_PER_WEEK): ScanSchedule {
  if (!validScanFrequency(runsPerWeek)) throw new Error('Invalid weekly scan frequency');
  const occupied = [...new Set(existing.filter(validScanSchedule)
    .map(schedule => schedule.slotsUtcMinutes[0] % SCAN_INTERVAL_MINUTES))].sort((a, b) => a - b);
  let phase: number;
  if (occupied.length < 10) {
    // A small fleet runs on two days, 30 minutes between account starts.
    phase = Array.from({ length: 10 }, (_, index) => 360 + index * 30)
      .find(candidate => !occupied.includes(candidate))!;
  } else {
    // As the fleet grows, fill the largest gap across the entire 84-hour cycle.
    let largest = -1;
    phase = occupied[0];
    for (let index = 0; index < occupied.length; index++) {
      const next = index + 1 < occupied.length ? occupied[index + 1] : occupied[0] + SCAN_INTERVAL_MINUTES;
      const gap = next - occupied[index];
      if (gap > largest) {
        largest = gap;
        phase = (occupied[index] + Math.floor(gap / 2)) % SCAN_INTERVAL_MINUTES;
      }
    }
    if (largest < 2) throw new Error('Every weekly scan slot is occupied; increase scheduling resolution before adding accounts.');
  }
  return { version: 1, slotsUtcMinutes: Array.from({ length: runsPerWeek }, (_, index) =>
    (phase + index * SCAN_WEEK_MINUTES / runsPerWeek) % SCAN_WEEK_MINUTES) };
}

/** Explicit legacy edits preserve the next saved start; normal onboarding uses fleet allocation. */
export function allocateProjectScanSchedule(project: Project, existing: (ScanSchedule | undefined)[], from = new Date()): ScanSchedule {
  const runsPerWeek = projectScanRunsPerWeek(project);
  const next = project.scanRunsPerWeek === undefined ? null : nextProjectScan({ ...project, enabled: true }, from);
  if (!next) return allocateScanSchedule(existing, runsPerWeek);
  const anchor = ((Date.parse(next) - mondayEpoch) / 60000 % SCAN_WEEK_MINUTES + SCAN_WEEK_MINUTES) % SCAN_WEEK_MINUTES;
  return { version: 1, slotsUtcMinutes: Array.from({ length: runsPerWeek }, (_, index) =>
    (anchor + index * SCAN_WEEK_MINUTES / runsPerWeek) % SCAN_WEEK_MINUTES) };
}

export function scanSlotCron(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SCAN_WEEK_MINUTES) throw new Error('Invalid weekly scan slot');
  return `cron(${slot % 60} ${Math.floor(slot / 60) % 24} ? * ${dayNames[Math.floor(slot / 1440)]} *)`;
}

export function isCurrentScheduledOccurrence(
  project: Pick<Project, 'scanSchedule' | 'scheduleStatus'>,
  occurrence: { scheduledAt: string; scheduleVersion?: number; scheduleSlotUtcMinute?: number },
): boolean {
  if (!project.scanSchedule) return occurrence.scheduleVersion === undefined;
  // Until the initial replacements synchronize, the legacy schedule is the effective source.
  // activatedAt survives later settings edits, when the legacy schedule is already disabled.
  if (!project.scanSchedule.activatedAt && ['pending', 'error'].includes(project.scheduleStatus || ''))
    return occurrence.scheduleVersion === undefined;
  if (!validScanSchedule(project.scanSchedule) || occurrence.scheduleVersion !== project.scanSchedule.version ||
    !project.scanSchedule.slotsUtcMinutes.includes(occurrence.scheduleSlotUtcMinute!)) return false;
  const timestamp = Date.parse(occurrence.scheduledAt);
  if (!Number.isFinite(timestamp) || timestamp % 60000 !== 0) return false;
  const minute = ((timestamp - mondayEpoch) / 60000 % SCAN_WEEK_MINUTES + SCAN_WEEK_MINUTES) % SCAN_WEEK_MINUTES;
  return minute === occurrence.scheduleSlotUtcMinute;
}

/** Persist with CAS against project.version after the cloud schedules synchronize. */
export function markScheduleSynced(project: Project, at = new Date().toISOString()): Project {
  return { ...project, ...(project.scanSchedule ? { scanSchedule: { ...project.scanSchedule,
    activatedAt: project.scanSchedule.activatedAt || at } } : {}),
    scheduleStatus: 'synced', version: project.version + 1, updatedAt: at };
}

/** Unknown legacy expressions return no prediction instead of a misleading Monday date. */
export function nextProjectScan(
  project: Pick<Project, 'scanSchedule' | 'scheduleExpression' | 'timezone' | 'enabled' | 'scheduleStatus'>,
  from = new Date(),
): string | null {
  if (!project.enabled) return null;
  if (project.scanSchedule && (project.scanSchedule.activatedAt || !['pending', 'error'].includes(project.scheduleStatus || ''))) {
    if (!validScanSchedule(project.scanSchedule)) return null;
    const weekStart = mondayEpoch + Math.floor((from.getTime() - mondayEpoch) / (SCAN_WEEK_MINUTES * 60000)) * SCAN_WEEK_MINUTES * 60000;
    return new Date(Math.min(...project.scanSchedule.slotsUtcMinutes.map(slot => {
      const candidate = weekStart + slot * 60000;
      return candidate > from.getTime() ? candidate : candidate + SCAN_WEEK_MINUTES * 60000;
    }))).toISOString();
  }
  const cron = /^cron\((\d{1,2}) (\d{1,2}) \? \* ([A-Z,]+) \*\)$/.exec(project.scheduleExpression);
  if (!cron || +cron[1] > 59 || +cron[2] > 23) return null;
  const days = cron[3].split(',');
  if (days.some(day => !dayNames.includes(day))) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: project.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const local = parts(from);
  for (let offset = 0; offset <= 7; offset++) {
    const target = new Date(Date.UTC(local.year, local.month - 1, local.day + offset, +cron[2], +cron[1]));
    if (!days.includes(dayNames[(target.getUTCDay() + 6) % 7])) continue;
    let candidate = target.getTime();
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = parts(new Date(candidate));
      candidate += target.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    const actual = parts(new Date(candidate));
    if (actual.year !== target.getUTCFullYear() || actual.month !== target.getUTCMonth() + 1 || actual.day !== target.getUTCDate() ||
      actual.hour !== target.getUTCHours() || actual.minute !== target.getUTCMinutes()) continue;
    if (candidate > from.getTime()) return new Date(candidate).toISOString();
  }
  return null;
}
