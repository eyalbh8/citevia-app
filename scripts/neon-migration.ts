import { Client, type ClientConfig } from 'pg';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SqlSession } from '@citevia/storage';
import { assertAppliedMigrationChecksums, assertMigrationEndpoints, assertMigrationVersions, compareInventories, dumpArguments,
  inventoryDatabase, inventoryDigest, parseMigrationEndpoint, restoreArguments,
  MigrationSafetyError, type MigrationEndpoint, type MigrationInventory } from './lib/postgres-migration.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  apply: { type: 'boolean', default: false }, 'writers-paused': { type: 'boolean', default: false },
  archive: { type: 'string' }, 'max-bytes': { type: 'string' }, 'pg-dump': { type: 'string', default: 'pg_dump' },
  'pg-restore': { type: 'string', default: 'pg_restore' }, help: { type: 'boolean', default: false },
} });
const usage = `Usage: node --import tsx scripts/neon-migration.ts inspect|dump|restore|verify
  --archive /private/path/source.dump [--apply --writers-paused] [--max-bytes 536870912]
  [--pg-dump /path/to/pg_dump] [--pg-restore /path/to/pg_restore]
Requires SOURCE_DATABASE_URL and direct TARGET_DATABASE_URL in environment. Never prints URLs/passwords.
Optional SOURCE_PGHOSTADDR (SSM loopback), SOURCE_PGSSLROOTCERT and TARGET_PGSSLROOTCERT.
Preview is the default. Dump/restore require both explicit flags; no schema migrations or cutover occur here.`;

interface Manifest { format: 1; createdAt: string; archiveSha256: string; archiveBytes: number; dumpMajor: number; source: MigrationInventory }
const wrap = (client: Client): SqlSession => ({ query: async (sql, params) => {
  const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount };
}, exec: sql => client.query(sql) });
async function digestFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function toolEnvironment(endpoint: MigrationEndpoint, prefix: 'SOURCE' | 'TARGET') {
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', PGHOST: endpoint.host,
    ...(process.env[`${prefix}_PGHOSTADDR`] ? { PGHOSTADDR: process.env[`${prefix}_PGHOSTADDR`]! } : {}),
    PGPORT: String(endpoint.port), PGDATABASE: endpoint.database, PGUSER: endpoint.username, PGPASSWORD: endpoint.password,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env[`${prefix}_PGSSLROOTCERT`] || 'system',
    PGCHANNELBINDING: 'prefer', PGCONNECT_TIMEOUT: '30', PGAPPNAME: 'citevia-neon-migration' };
}
async function runTool(command: string, args: string[], endpoint?: MigrationEndpoint, prefix: 'SOURCE' | 'TARGET' = 'SOURCE') {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(command, args, { shell: false, env: endpoint ? toolEnvironment(endpoint, prefix) : { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    // Do not relay stderr, which can contain authentication/connection details.
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { if (output.length < 32768) output += chunk.toString(); });
    child.on('error', () => reject(new MigrationSafetyError('PostgreSQL executable could not start')));
    child.on('close', code => code === 0 ? resolveOutput(output) : reject(new MigrationSafetyError(`PostgreSQL executable failed with status ${code}; source and target were not switched`)));
  });
}
async function connect(endpoint: MigrationEndpoint, prefix: 'SOURCE' | 'TARGET') {
  const root = process.env[`${prefix}_PGSSLROOTCERT`];
  const config: ClientConfig = { host: process.env[`${prefix}_PGHOSTADDR`] || endpoint.host,
    port: endpoint.port, user: endpoint.username, password: endpoint.password, database: endpoint.database,
    ssl: { rejectUnauthorized: true, servername: endpoint.host,
      ...(root && root !== 'system' ? { ca: await readFile(root, 'utf8') } : {}) },
    application_name: 'citevia-neon-migration', connectionTimeoutMillis: 30000,
    enableChannelBinding: true,
    statement_timeout: 120000, lock_timeout: 15000 };
  const client = new Client(config);
  await client.connect();
  return client;
}
async function begin(client: Client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL DateStyle='ISO, YMD'");
  await client.query("SET LOCAL extra_float_digits=3");
  await client.query("SET LOCAL bytea_output='hex'");
  await client.query('SET LOCAL row_security=off');
}

async function main() {
  if (values.help) { console.log(usage); return; }
  const operation = positionals[0];
  if (positionals.length !== 1 || !['inspect','dump','restore','verify'].includes(operation)) throw new MigrationSafetyError(usage);
  if (!process.env.SOURCE_DATABASE_URL || !process.env.TARGET_DATABASE_URL)
    throw new MigrationSafetyError('SOURCE_DATABASE_URL and direct TARGET_DATABASE_URL are required');
  const sourceEndpoint = parseMigrationEndpoint(process.env.SOURCE_DATABASE_URL);
  const targetEndpoint = parseMigrationEndpoint(process.env.TARGET_DATABASE_URL);
  assertMigrationEndpoints(sourceEndpoint, targetEndpoint);
  if (values.apply && !['dump','restore'].includes(operation)) throw new MigrationSafetyError('Apply only belongs to dump/restore');
  if (values.apply && !values['writers-paused']) throw new MigrationSafetyError('Pause and drain all source writers before applying');
  const maxBytes = Number(values['max-bytes'] || 536870912);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MigrationSafetyError('Invalid verification byte budget');
  const archive = values.archive ? resolve(values.archive) : undefined;
  if (operation !== 'inspect' && !archive) throw new MigrationSafetyError('An archive path is required');
  const dumpVersion = await runTool(values['pg-dump'], ['--version']);
  const restoreVersion = await runTool(values['pg-restore'], ['--version']);
  const major = (value: string) => { const result = value.match(/PostgreSQL\) (\d+)\./); if (!result) throw new MigrationSafetyError('Unknown PostgreSQL tool version'); return Number(result[1]); };
  const source = await connect(sourceEndpoint, 'SOURCE');
  let target: Client | undefined;
  try {
    target = await connect(targetEndpoint, 'TARGET');
    await begin(source); await begin(target);
    const sourceInventory = await inventoryDatabase(wrap(source), maxBytes);
    await assertAppliedMigrationChecksums(sourceInventory, name => readFile(resolve('database/migrations', name), 'utf8'));
    const targetInventory = await inventoryDatabase(wrap(target), maxBytes);
    assertMigrationVersions(sourceInventory.serverVersion, targetInventory.serverVersion, major(dumpVersion), major(restoreVersion));
    const summary = { sourceMajor: Math.floor(sourceInventory.serverVersion / 10000), targetMajor: Math.floor(targetInventory.serverVersion / 10000),
      sourceTables: sourceInventory.tables.length, targetTables: targetInventory.tables.length,
      sourceRows: sourceInventory.tables.reduce((sum, table) => sum + BigInt(table.count), 0n).toString(),
      sourceDigest: inventoryDigest(sourceInventory), dryRun: !values.apply };
    if (operation === 'inspect') { console.log(JSON.stringify({ operation, ...summary })); return; }
    if (operation === 'dump') {
      if (!values.apply) { console.log(JSON.stringify({ operation, ...summary, archive })); return; }
      await mkdir(dirname(archive!), { recursive: true, mode: 0o700 });
      if (((await stat(dirname(archive!))).mode & 0o077) !== 0)
        throw new MigrationSafetyError('Use a private archive directory with mode 0700');
      const file = await open(archive!, 'wx', 0o600); await file.close();
      const snapshot = String((await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot);
      await runTool(values['pg-dump'], dumpArguments(archive!, snapshot), sourceEndpoint);
      await chmod(archive!, 0o600);
      await source.query('COMMIT'); await begin(source);
      const unchanged = compareInventories(sourceInventory, await inventoryDatabase(wrap(source), maxBytes));
      if (!unchanged.equal) throw new MigrationSafetyError('Source changed during export; do not restore this archive');
      const manifest: Manifest = { format: 1, createdAt: new Date().toISOString(), archiveSha256: await digestFile(archive!),
        archiveBytes: (await stat(archive!)).size, dumpMajor: major(dumpVersion), source: sourceInventory };
      await writeFile(`${archive}.manifest.json`, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ operation, ...summary, archive, archiveSha256: manifest.archiveSha256 }));
      return;
    }
    const manifest = JSON.parse(await readFile(`${archive}.manifest.json`, 'utf8')) as Manifest;
    if (manifest.format !== 1 || !manifest.source || manifest.archiveSha256 !== await digestFile(archive!))
      throw new MigrationSafetyError('Archive manifest/hash validation failed');
    assertMigrationVersions(manifest.source.serverVersion, targetInventory.serverVersion, manifest.dumpMajor, major(restoreVersion));
    if (!compareInventories(manifest.source, sourceInventory).equal)
      throw new MigrationSafetyError('Source differs from the exported manifest; pause/drain writers and export again');
    if (operation === 'restore') {
      if (targetInventory.tables.length || targetInventory.sequences.length ||
        ['functions','views','enums'].some(name => targetInventory.schema[name].length))
        throw new MigrationSafetyError('Restore requires an empty target; create a fresh branch/database instead of overwriting');
      if (!values.apply) { console.log(JSON.stringify({ operation, ...summary, archive })); return; }
      await target.query('COMMIT');
      await runTool(values['pg-restore'], restoreArguments(archive!, targetEndpoint.database), targetEndpoint, 'TARGET');
      await begin(target);
    }
    const comparison = compareInventories(manifest.source, await inventoryDatabase(wrap(target), maxBytes));
    if (!comparison.equal) throw new MigrationSafetyError(`Verification failed: ${comparison.differences.map(name => name === 'schema' ? `schema (${comparison.schemaDifferences.join(', ')})` : name).join(', ')}; keep writers paused and keep Aurora authoritative`);
    // The source snapshot above predates the restore. Recheck a fresh snapshot so a
    // late source writer cannot be hidden by repeatable-read isolation.
    await source.query('COMMIT'); await begin(source);
    if (!compareInventories(manifest.source, await inventoryDatabase(wrap(source), maxBytes)).equal)
      throw new MigrationSafetyError('Source changed during restore or verification; keep writers paused and export again before cutover');
    console.log(JSON.stringify({ operation, ...summary, verified: true, localeChanged: comparison.localeChanged,
      note: 'No application endpoint was switched. Recheck after any target migrations before cutover.' }));
  } finally {
    await source.query('ROLLBACK').catch(() => {}); await source.end();
    if (target) { await target.query('ROLLBACK').catch(() => {}); await target.end(); }
  }
}
main().catch(error => { console.error(error instanceof MigrationSafetyError ? error.message
  : 'Migration command failed. Check credentials, versions, empty target and writer pause; database endpoints were not switched.'); process.exitCode = 1; });
