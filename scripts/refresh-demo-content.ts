import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { trackedUrlKey, normalizeDomain, type Project } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';

/** Prune only demo catalog entries; retain all scenario settings and enrollment dates. */
export async function refreshDemoContent(
  repository: Pick<Repository, 'getProject' | 'saveProject'>,
  projectId: string,
  verifiedUrls: string[],
  apply = false,
  now = new Date(),
) {
  const project = await repository.getProject(projectId);
  if (!project?.demo || project.enabled || project.demo.presentation?.reportingOnly)
    throw new Error('Only disabled demo scenarios with generated tracking can be refreshed.');
  const verified = new Set(verifiedUrls.map(trackedUrlKey).filter(Boolean));
  const owns = (url: string) => {
    const domain = normalizeDomain(new URL(url).hostname);
    return !!domain && project.brand.domains.some(owned => domain === normalizeDomain(owned) || domain.endsWith(`.${normalizeDomain(owned)}`));
  };
  const seen = new Set<string>();
  const trackedUrls = (project.demo.trackedUrls || []).filter(item => {
    const key = trackedUrlKey(item.url);
    if (!key || seen.has(key) || item.demoPost || !verified.has(key) || !owns(item.url)) return false;
    seen.add(key);
    return true;
  });
  if (!trackedUrls.length) throw new Error(`No verified official articles remain for ${projectId}.`);
  const unchanged = isDeepStrictEqual(project.demo.trackedUrls, trackedUrls);
  const next: Project = { ...project, demo: { ...project.demo, trackedUrls }, version: project.version + 1, updatedAt: now.toISOString() };
  if (apply && !unchanged && !await repository.saveProject(next, project.version))
    throw new Error(`Concurrent update for ${projectId}. Refresh the plan before retrying.`);
  return { projectId, status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview',
    previousUrls: project.demo.trackedUrls?.length || 0, trackedUrls: trackedUrls.length,
    pastUrls: trackedUrls.filter(item => item.publishedAt <= now.toISOString()).length,
    futureUrls: trackedUrls.filter(item => item.publishedAt > now.toISOString()).length };
}

export async function runRefreshDemoContentCli(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    plan: { type: 'string' }, mode: { type: 'string', default: 'local' }, apply: { type: 'boolean', default: false },
  } });
  if (!values.plan || !['local', 'aws'].includes(values.mode))
    throw new Error('Usage: node --import tsx scripts/refresh-demo-content.ts --plan verified-plan.json --mode local|aws [--apply]');
  const plan: unknown = JSON.parse(await readFile(resolve(values.plan), 'utf8'));
  if (!Array.isArray(plan) || !plan.length || plan.some(row => !row || typeof row.projectId !== 'string' ||
    !Array.isArray(row.verifiedUrls) || row.verifiedUrls.some((url: unknown) => typeof url !== 'string')))
    throw new Error('Supply an array of {projectId, verifiedUrls} entries checked against public websites.');
  const db = await openConfigurationDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const repository = new PostgresRepository(db), results = [];
    for (const row of plan) results.push(await refreshDemoContent(repository, row.projectId, row.verifiedUrls, values.apply));
    return results;
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runRefreshDemoContentCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error instanceof Error ? error.message : 'Demo catalog refresh failed'); process.exitCode = 1;
  });
