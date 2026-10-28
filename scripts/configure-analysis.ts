import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ANALYSIS_MODEL } from '@citevia/core';
import { PostgresRepository, productionDatabase, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { configureAnalysis } from '../apps/scanner/src/analysis-configuration.js';
export { configureAnalysis, type ConfigureAnalysisOptions } from '../apps/scanner/src/analysis-configuration.js';

export async function openConfigurationDatabase(mode: 'local' | 'aws', base: string): Promise<SqlDatabase> {
  if (mode === 'aws') return productionDatabase();
  const databasePath = resolve(base, 'postgres');
  await stat(databasePath); // A preview must never create a database or apply schema migrations.
  return localPostgres(databasePath, { migrate: false });
}

export async function runConfigureAnalysisCli(argv: string[], openDatabase = openConfigurationDatabase) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'local' }, model: { type: 'string', default: DEFAULT_ANALYSIS_MODEL },
    project: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return `Usage: npm run analysis:configure -- --mode local|aws [--model ${DEFAULT_ANALYSIS_MODEL}] [--project PROJECT_ID] [--apply]\nDefault is a read-only preview of all accounts using non-Gemini analysis models, including GPT Luna. --project explicitly selects one account, including existing Gemini models. --apply updates future scan analysis with repository compare-and-swap; concurrent edits are reported as conflicts. No paid model calls, schema migrations or saved-run changes. Stop the local app before opening its embedded database.`;
  if (!['local', 'aws'].includes(values.mode) || !/^[A-Za-z0-9._:-]{1,160}$/.test(values.model) || (values.project !== undefined && !values.project.trim()))
    throw new Error('Choose --mode local|aws, a model ID and an optional nonempty --project; use --help.');
  const db = await openDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const ids = values.project
      ? [values.project]
      : (await db.query<{ id: string }>(
          `SELECT id FROM citevia_projects WHERE COALESCE(data->>'extractionModel', '') !~ '^gemini-' ORDER BY id`,
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
