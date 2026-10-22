import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { allocateScanSchedule, markScheduleSynced, nextProjectScan, WEEKLY_SCHEDULE, type Project } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { syncProjectSchedule } from '../apps/api/src/scheduler.js';
import { openConfigurationDatabase } from './configure-analysis.js';

export async function configureSchedules(
  repository: Pick<Repository, 'ensureProjectScanSchedule' | 'getProject' | 'saveProject'>,
  projects: Project[],
  options: { apply?: boolean; project?: string; migrateCustom?: boolean } = {},
  sync: (project: Project) => Promise<void> = syncProjectSchedule,
  now = new Date(),
) {
  if (options.migrateCustom && !options.project) throw new Error('--migrate-custom requires an explicit --project.');
  const occupied = projects.map(project => project.scanSchedule);
  const changes: { projectId: string; status: string; slotsUtcMinutes?: [number, number]; nextScanAt?: string | null }[] = [];
  for (const project of projects) {
    if (options.project && project.id !== options.project) continue;
    if (!project.scanSchedule && project.scheduleExpression !== WEEKLY_SCHEDULE && !options.migrateCustom) {
      changes.push({ projectId: project.id, status: 'custom-preserved' });
      continue;
    }
    if (!options.apply) {
      const scanSchedule = project.scanSchedule || allocateScanSchedule(occupied);
      if (!project.scanSchedule) occupied.push(scanSchedule);
      changes.push({ projectId: project.id, status: project.scanSchedule ? 'assigned' : 'planned',
        slotsUtcMinutes: scanSchedule.slotsUtcMinutes, nextScanAt: nextProjectScan({ ...project, scanSchedule }, now) });
      continue;
    }
    let synced: Project | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await repository.ensureProjectScanSchedule(project.id, { migrateCustom: options.migrateCustom });
        if (!latest) throw new Error('Account missing');
        await sync(latest);
        const next = markScheduleSynced(latest, now.toISOString());
        if (await repository.saveProject(next, latest.version)) { synced = next; break; }
      }
      if (!synced) throw new Error('Concurrent account changes');
      changes.push({ projectId: project.id, status: 'synced', slotsUtcMinutes: synced.scanSchedule?.slotsUtcMinutes,
        nextScanAt: nextProjectScan(synced, now) });
    } catch {
      // Keep the assigned slots for a repeatable repair; never silently move accounts on retry.
      const latest = await repository.getProject(project.id);
      if (latest) await repository.saveProject({ ...latest, scheduleStatus: 'error', version: latest.version + 1 }, latest.version);
      changes.push({ projectId: project.id, status: 'sync-error', slotsUtcMinutes: latest?.scanSchedule?.slotsUtcMinutes });
    }
  }
  return { mode: options.apply ? 'apply' : 'preview', scansPerWeek: 2,
    timing: 'UTC slots 84 hours apart. Existing slots remain stable as accounts join.',
    synced: changes.filter(change => change.status === 'synced').length,
    errors: changes.filter(change => change.status === 'sync-error').length, changes };
}

export async function runConfigureSchedulesCli(argv: string[], openDatabase = openConfigurationDatabase) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'local' }, project: { type: 'string' },
    apply: { type: 'boolean', default: false }, 'migrate-custom': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return 'Usage: npm run schedules:configure -- --mode local|aws [--project PROJECT_ID] [--migrate-custom] [--apply]\nDefault is a read-only preview. --apply assigns stable twice-weekly slots and synchronizes EventBridge schedules. Custom cron remains unchanged unless --project and --migrate-custom are both supplied. This creates future schedules; it does not enqueue a scan now. Stop the local app before opening its embedded database.';
  if (!['local', 'aws'].includes(values.mode) || (values.project !== undefined && !values.project.trim()) || (values['migrate-custom'] && !values.project))
    throw new Error('Choose --mode local|aws and an optional --project; --migrate-custom requires --project.');
  const db = await openDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    // Include all assignments even for a one-account migration so preview allocation reflects the fleet.
    const projects = (await db.query<{ data: Project }>('SELECT data FROM citevia_projects ORDER BY data->>\'createdAt\',id')).rows.map(row => row.data);
    if (values.project && !projects.some(project => project.id === values.project)) throw new Error('Account missing');
    return JSON.stringify({ backend: values.mode, ...await configureSchedules(new PostgresRepository(db), projects,
      { apply: values.apply, project: values.project, migrateCustom: values['migrate-custom'] },
      values.mode === 'local' ? async () => {} : project => syncProjectSchedule(project, { mode: 'aws' })) }, null, 2);
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConfigureSchedulesCli(process.argv.slice(2)).then(text => {
    console.log(text);
    if (text.startsWith('{') && JSON.parse(text).errors) process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Schedule configuration failed.'); process.exitCode = 1; });
}
