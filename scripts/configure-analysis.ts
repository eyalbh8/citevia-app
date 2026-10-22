import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PostgresRepository, productionDatabase, type Repository, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';

export interface ConfigureAnalysisOptions {
  model?: string;
  project?: string;
  apply?: boolean;
}
const retiring = (model: string) => /^gpt-4\.1-mini(?:$|-)/.test(model);

/** Only live project configuration changes. Run snapshots and collection models are never edited. */
export async function configureAnalysis(
  repository: Pick<Repository, 'getProject' | 'saveProject'>,
  projectIds: string[],
  options: ConfigureAnalysisOptions = {},
  now = new Date(),
) {
  const model = options.model ?? 'gpt-6-luna';
  const changes = [];
  for (const id of new Set(projectIds)) {
    if (options.project && id !== options.project) continue;
    const project = await repository.getProject(id);
    if (!project) {
      changes.push({ projectId: id, status: 'missing' });
      continue;
    }
    if (!options.project && !retiring(project.extractionModel)) continue;
    if (project.extractionModel === model) {
      changes.push({ projectId: id, from: project.extractionModel, to: model, status: 'unchanged', version: project.version });
      continue;
    }
    const next = { ...project, extractionModel: model, version: project.version + 1, updatedAt: now.toISOString() };
    const saved = options.apply ? await repository.saveProject(next, project.version) : null;
    changes.push({
      projectId: id, from: project.extractionModel, to: model,
      status: !options.apply ? 'planned' : saved ? 'updated' : 'conflict',
      expectedVersion: project.version, nextVersion: next.version,
    });
  }
  return {
    mode: options.apply ? 'apply' : 'preview',
    scope: options.project ?? 'accounts pinned to retiring gpt-4.1-mini models',
    model,
    appliesTo: 'Future scan analysis. Existing run snapshots and collection/content models retain their saved settings.',
    rollout: 'Evaluate labelled saved answers and provider access before applying the model choice.',
    updated: changes.filter((change) => change.status === 'updated').length,
    conflicts: changes.filter((change) => change.status === 'conflict').length,
    changes,
  };
}

export async function openConfigurationDatabase(mode: 'local' | 'aws', base: string): Promise<SqlDatabase> {
  if (mode === 'aws') return productionDatabase();
  const databasePath = resolve(base, 'postgres');
  await stat(databasePath); // A preview must never create a database or apply schema migrations.
  return localPostgres(databasePath, { migrate: false });
}

export async function runConfigureAnalysisCli(argv: string[], openDatabase = openConfigurationDatabase) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'local' }, model: { type: 'string', default: 'gpt-6-luna' },
    project: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return 'Usage: npm run analysis:configure -- --mode local|aws [--model gpt-6-luna] [--project PROJECT_ID] [--apply]\nDefault is a read-only preview of accounts pinned to retiring gpt-4.1-mini models. --project explicitly selects one account, including custom analysis models. --apply updates future scan analysis with repository compare-and-swap; concurrent edits are reported as conflicts. No paid model calls, schema migrations or saved-run changes. Stop the local app before opening its embedded database.';
  if (!['local', 'aws'].includes(values.mode) || !/^[A-Za-z0-9._:-]{1,200}$/.test(values.model) || (values.project !== undefined && !values.project.trim()))
    throw new Error('Choose --mode local|aws, a model ID and an optional nonempty --project; use --help.');
  const db = await openDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const ids = values.project
      ? [values.project]
      : (await db.query<{ id: string }>(
          `SELECT id FROM citevia_projects WHERE data->>'extractionModel' ~ '^gpt-4[.]1-mini($|-)' ORDER BY id`,
        )).rows.map((row) => row.id);
    const report = await configureAnalysis(new PostgresRepository(db), ids, { model: values.model, project: values.project, apply: values.apply });
    return JSON.stringify({ backend: values.mode, ...report }, null, 2);
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConfigureAnalysisCli(process.argv.slice(2)).then((text) => {
    console.log(text);
    if (text.startsWith('{')) {
      const report = JSON.parse(text);
      if (report.conflicts || report.changes.some((change: { status: string }) => change.status === 'missing')) process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Analysis configuration failed.');
    process.exitCode = 1;
  });
}
