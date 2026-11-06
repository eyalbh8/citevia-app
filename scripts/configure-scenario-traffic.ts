import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveReportId } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';
import budgets from './scenario-traffic-budgets.json';

/** Set a traffic-only budget without altering saved answers, visibility, tracked content or scan schedules. */
export async function configureScenarioTraffic(
  repository: Pick<Repository, 'getProject' | 'saveProject'>,
  id: string,
  monthlyVisits: number,
  monthlyGrowth: number,
  apply = false,
  now = new Date(),
) {
  if (!Number.isSafeInteger(monthlyVisits) || monthlyVisits < 1 || monthlyVisits > 100_000 ||
    !Number.isFinite(monthlyGrowth) || monthlyGrowth < 0 || monthlyGrowth > .25)
    throw new Error('Choose integer monthly visits from 1 to 100000 and monthly growth from 0 to 0.25.');
  const projectId = resolveReportId(id);
  if (!/^[a-z0-9_-]+$/i.test(projectId)) throw new Error('Choose a valid account ID.');
  const saved = await repository.getProject(projectId);
  if (!saved || saved.id !== projectId || saved.enabled !== false || saved.demo?.version !== 1 ||
    saved.demo.presentation?.reportingOnly || !Number.isSafeInteger(saved.version) || saved.version < 1)
    throw new Error('Traffic budgets require a saved, disabled scenario account.');
  const traffic = saved.demo.traffic;
  const unchanged = traffic?.monthlyVisits === monthlyVisits && traffic?.monthlyGrowth === monthlyGrowth;
  if (!unchanged) {
    const next = { ...saved, version: saved.version + 1, updatedAt: now.toISOString(),
      demo: { ...saved.demo, traffic: { ...traffic, monthlyVisits, monthlyGrowth } } };
    if (apply && !await repository.saveProject(next, saved.version))
      throw new Error('Account changed concurrently; retry to inspect it.');
  }
  return { status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview', projectId, name: saved.name,
    version: saved.version + (unchanged || !apply ? 0 : 1), monthlyVisits, monthlyGrowth };
}

export async function runConfigureScenarioTrafficCli(argv: string[], openDatabase = openConfigurationDatabase) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'local' }, project: { type: 'string' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return 'Usage: node --env-file-if-exists=.env --import tsx scripts/configure-scenario-traffic.ts --mode local|aws [--project ID] [--apply]\nRead-only preview by default. Selects only the accounts listed in scripts/scenario-traffic-budgets.json. --apply updates their traffic budgets with version checks. No scans, traffic events, schema changes or source-record replacements. Stop the local app before opening its embedded database.';
  if (!['local', 'aws'].includes(values.mode) || (values.project !== undefined && !values.project.trim()))
    throw new Error('Choose --mode local|aws and an optional account ID; use --help.');
  const selected = values.project ? budgets.filter(row => row.id === resolveReportId(values.project!)) : budgets;
  if (!selected.length) throw new Error('The selected account has no configured traffic budget.');
  const db = await openDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const repository = new PostgresRepository(db);
    const changes = [];
    for (const row of selected) {
      const saved = await repository.getProject(row.id);
      if (!saved || saved.name !== row.name || !saved.brand.domains.includes(row.domain))
        throw new Error(`The saved identity does not match the configured ${row.name} account.`);
      // Apply against the same snapshot whose identity was checked, so a rename
      // or other concurrent edit is rejected by the version check.
      changes.push(await configureScenarioTraffic({ getProject: async () => saved,
        saveProject: (project, expected) => repository.saveProject(project, expected) },
      row.id, row.monthlyVisits, row.monthlyGrowth, values.apply));
    }
    return JSON.stringify({ mode: values.apply ? 'apply' : 'preview', backend: values.mode, changes }, null, 2);
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConfigureScenarioTrafficCli(process.argv.slice(2)).then(console.log).catch(error => {
    console.error(error instanceof Error ? error.message : 'Traffic configuration failed.');
    process.exitCode = 1;
  });
}
