import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import type { DemoConfig, Project } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';
import { NAYAX_DEMO_ID } from './create-nayax-demo.js';
import { buildServiceDemo } from './create-service-demo.js';

const NAYAX_SOURCE_ACCOUNT_ID = '333d2ee5-e99c-4e69-a59d-43656f6d8244';

/** Replace only Nayax's compact publication catalog, retaining its saved account and scenario. */
export async function refreshNayaxContent(
  repository: Pick<Repository, 'getProject' | 'saveProject'>,
  source: unknown,
  apply = false,
  now = new Date(),
) {
  const existing = await repository.getProject(NAYAX_DEMO_ID);
  if (!existing?.demo || existing.demo.source !== 'igeo-nayax' ||
    existing.demo.sourceAccountId !== NAYAX_SOURCE_ACCOUNT_ID || existing.enabled ||
    existing.brand.name.trim().toLowerCase() !== 'nayax' ||
    !existing.brand.domains.some(domain => /(^|\.)nayax\.com$/i.test(domain)))
    throw new Error('Refusing to change an account without the expected disabled Nayax scenario identity.');
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
    !('id' in source) || source.id !== NAYAX_DEMO_ID ||
    !('anchorDate' in source) || source.anchorDate !== existing.demo.anchorDate)
    throw new Error('Supply one Nayax content source with the existing account ID and explicit saved anchorDate.');

  const built = buildServiceDemo(source, now.toISOString());
  if (built.brand.name.trim().toLowerCase() !== 'nayax' || built.brand.domains[0] !== 'nayax.com' ||
    built.demo!.startDate !== existing.demo.startDate || built.demo!.endDate !== existing.demo.endDate)
    throw new Error('Nayax content must use nayax.com and preserve the saved scenario timeline.');
  // Compare the same JSON shape returned by PostgreSQL; optional undefined fields are not persisted.
  const trackedUrls: NonNullable<DemoConfig['trackedUrls']> = JSON.parse(JSON.stringify(built.demo!.trackedUrls!));
  const unchanged = isDeepStrictEqual(existing.demo.trackedUrls, trackedUrls);
  const desired: Project = unchanged ? existing : {
    ...existing,
    version: existing.version + 1,
    updatedAt: now.toISOString(),
    demo: { ...existing.demo, trackedUrls },
  };
  const configurationBytes = Buffer.byteLength(JSON.stringify(desired));
  if (configurationBytes > 250000) throw new Error('Compact Nayax configuration exceeds 250 KB.');
  if (!unchanged && apply && !await repository.saveProject(desired, existing.version))
    throw new Error('Nayax account changed concurrently. Retry to inspect it.');

  return {
    status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview',
    projectId: existing.id,
    name: existing.name,
    expectedVersion: existing.version,
    nextVersion: desired.version,
    previousTrackedUrls: existing.demo.trackedUrls?.length || 0,
    trackedUrls: trackedUrls.length,
    officialArticles: trackedUrls.filter(article => !article.demoPost).length,
    demoArticles: trackedUrls.filter(article => article.demoPost).length,
    anchorDate: existing.demo.anchorDate,
    startDate: existing.demo.startDate,
    endDate: existing.demo.endDate,
    publicationsPerWeek: 3,
    configurationBytes,
    persistedSyntheticAnswers: 0,
    persistedSyntheticTrafficEvents: 0,
    paidCalls: 0,
  };
}

export async function runRefreshNayaxContentCli(argv: string[], openDatabase = openConfigurationDatabase) {
  const { values } = parseArgs({ args: argv, options: {
    source: { type: 'string' }, mode: { type: 'string', default: 'local' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return 'Usage: node --env-file-if-exists=.env --import tsx scripts/refresh-nayax-content.ts --source /private/path/nayax-content.json --mode local|aws [--apply]\nDefaults to a read-only preview. Replaces only the selected Nayax scenario publication catalog, retaining its models, prompts and saved timeline. Never calls iGEO or an AI provider. Stop the local app before opening its embedded database.';
  if (!values.source || !['local', 'aws'].includes(values.mode))
    throw new Error('Supply --source and choose --mode local|aws.');
  const source = JSON.parse(await readFile(resolve(values.source), 'utf8'));
  const db = await openDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    return JSON.stringify(await refreshNayaxContent(new PostgresRepository(db), source, values.apply), null, 2);
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runRefreshNayaxContentCli(process.argv.slice(2)).then(result => console.log(result)).catch(error => {
    console.error(error instanceof Error ? error.message : 'Nayax content refresh failed');
    process.exitCode = 1;
  });
