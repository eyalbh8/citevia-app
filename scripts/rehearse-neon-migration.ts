import { Client, type ClientConfig } from 'pg';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, open, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrateDatabase, type SqlDatabase, type SqlSession } from '../packages/storage/src/sql.js';
import { assertAppliedMigrationChecksums, assertMigrationEndpoints, assertMigrationVersions, compareInventories,
  dumpArguments, inventoryDatabase, inventoryDigest, MigrationSafetyError, parseMigrationEndpoint,
  restoreArguments, type MigrationEndpoint } from './lib/postgres-migration.js';
import { assertTypedBackfills, compareLocaleChecks, localeChecks, originalTableFingerprints,
  repositoryReadSmoke, repositoryWriteCanary } from './lib/neon-rehearsal.js';

const { values, positionals } = parseArgs({ options: {
  apply: { type: 'boolean', default: false }, 'connections-file': { type: 'string' },
  'output-dir': { type: 'string' }, 'expected-target-host': { type: 'string' }, 'rehearsal-branch-id': { type: 'string' },
  'pg-dump': { type: 'string', default: 'pg_dump' }, 'pg-restore': { type: 'string', default: 'pg_restore' },
  help: { type: 'boolean', default: false },
} });
const usage = `Usage: node --import tsx scripts/rehearse-neon-migration.ts
  --connections-file /private/connections.json --output-dir /private/rehearsal
  --expected-target-host ep-child.region.aws.neon.tech --rehearsal-branch-id br-child [--apply]
  [--pg-dump /path/pg_dump] [--pg-restore /path/pg_restore]
Source stays read-only and live; only the explicitly isolated target branch is restored/migrated.
Preview is default. This script never switches the app, claims cutover readiness, or deletes resources.`;
interface Connections { sourceDatabaseUrl: string; targetDatabaseUrl: string; sourcePgHostaddr?: string;
  sourcePgSslRootcert?: string; targetPgSslRootcert?: string }
let stage = 'arguments';
async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
}
const session = (client: Client): SqlSession => ({ query: async (sql, params) => {
  const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount };
}, exec: sql => client.query(sql) });
function database(client: Client, savepoints = false): SqlDatabase {
  const db = session(client);
  return { ...db, close: async () => {}, transaction: async work => {
    await client.query(savepoints ? 'SAVEPOINT citevia_rehearsal' : 'BEGIN');
    try { const result = await work(db); await client.query(savepoints ? 'RELEASE SAVEPOINT citevia_rehearsal' : 'COMMIT'); return result; }
    catch (error) { await client.query(savepoints ? 'ROLLBACK TO SAVEPOINT citevia_rehearsal' : 'ROLLBACK'); throw error; }
  } };
}
async function beginReadOnly(client: Client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL TIME ZONE 'UTC'"); await client.query("SET LOCAL DateStyle='ISO, YMD'");
  await client.query('SET LOCAL extra_float_digits=3'); await client.query("SET LOCAL bytea_output='hex'");
  await client.query('SET LOCAL row_security=off');
  if ((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on')
    throw new MigrationSafetyError('Source/read verification transaction is not read-only');
}
async function connect(endpoint: MigrationEndpoint, hostaddr?: string, caPath?: string) {
  const config: ClientConfig = { host: hostaddr || endpoint.host, port: endpoint.port, user: endpoint.username,
    password: endpoint.password, database: endpoint.database, application_name: 'citevia-isolated-rehearsal',
    ssl: { rejectUnauthorized: true, servername: endpoint.host,
      ...(caPath && caPath !== 'system' ? { ca: await readFile(caPath, 'utf8') } : {}) },
    enableChannelBinding: true, connectionTimeoutMillis: 30000, statement_timeout: 120000, lock_timeout: 15000 };
  const client = new Client(config); await client.connect(); return client;
}
async function tool(command: string, args: string[], endpoint?: MigrationEndpoint, hostaddr?: string, caPath?: string, source = false) {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore','pipe','pipe'], env: endpoint ? {
      PATH: process.env.PATH, LANG: 'C.UTF-8', PGHOST: endpoint.host, PGPORT: String(endpoint.port),
      PGDATABASE: endpoint.database, PGUSER: endpoint.username, PGPASSWORD: endpoint.password,
      ...(hostaddr ? { PGHOSTADDR: hostaddr } : {}), PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath || 'system',
      PGCHANNELBINDING: 'prefer', PGCONNECT_TIMEOUT: '30', PGAPPNAME: 'citevia-isolated-rehearsal',
      ...(source ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}),
    } : { PATH: process.env.PATH } });
    let output = ''; child.stdout.on('data', chunk => { if (output.length < 32768) output += chunk.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new MigrationSafetyError('PostgreSQL executable could not start')));
    child.on('close', code => code === 0 ? resolveOutput(output)
      : reject(new MigrationSafetyError(`Native PostgreSQL tool failed with status ${code}`)));
  });
}
async function hashFile(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
const major = (version: string) => {
  const match = version.match(/PostgreSQL\) (\d+)\./); if (!match) throw new MigrationSafetyError('Unknown PostgreSQL tool version'); return Number(match[1]);
};
async function main() {
  if (values.help) { console.log(usage); return; }
  if (positionals.length || !values['connections-file'] || !values['output-dir'] || !values['expected-target-host'] || !values['rehearsal-branch-id'])
    throw new MigrationSafetyError(usage);
  const credentialsPath = resolve(values['connections-file']);
  const permissions = await lstat(credentialsPath);
  if (!permissions.isFile() || (permissions.mode & 0o077)) throw new MigrationSafetyError('Connection file must be a private regular file (0600)');
  const connections = JSON.parse(await readFile(credentialsPath, 'utf8')) as Connections;
  const sourceEndpoint = parseMigrationEndpoint(connections.sourceDatabaseUrl);
  const targetEndpoint = parseMigrationEndpoint(connections.targetDatabaseUrl);
  assertMigrationEndpoints(sourceEndpoint, targetEndpoint);
  if (targetEndpoint.host !== values['expected-target-host'] || !/^br-[a-z0-9-]+$/.test(values['rehearsal-branch-id']))
    throw new MigrationSafetyError('Isolated branch identity does not match explicit rehearsal arguments');
  const output = resolve(values['output-dir']);
  const archive = resolve(output, 'source.snapshot.dump');
  const dumpMajor = major(await tool(values['pg-dump'], ['--version']));
  const restoreMajor = major(await tool(values['pg-restore'], ['--version']));
  let source: Client | undefined, target: Client | undefined;
  try {
    stage = 'read-only-source-connection';
    source = await connect(sourceEndpoint, connections.sourcePgHostaddr, connections.sourcePgSslRootcert);
    await beginReadOnly(source);
    stage = 'read-only-target-connection';
    target = await connect(targetEndpoint, undefined, connections.targetPgSslRootcert);
    await beginReadOnly(target);
    stage = 'inventory';
    const original = await inventoryDatabase(session(source));
    await assertAppliedMigrationChecksums(original, name => readFile(resolve('database/migrations', name), 'utf8'));
    const emptyTarget = await inventoryDatabase(session(target));
    assertMigrationVersions(original.serverVersion, emptyTarget.serverVersion, dumpMajor, restoreMajor);
    if (emptyTarget.tables.length || emptyTarget.sequences.length ||
      ['functions','views','enums'].some(key => emptyTarget.schema[key].length))
      throw new MigrationSafetyError('Rehearsal target must be empty; use a fresh isolated branch');
    const sourceLocale = await localeChecks(session(source));
    if (!values.apply) {
      console.log(JSON.stringify({ rehearsal: true, dryRun: true, branchId: values['rehearsal-branch-id'],
        sourceTables: original.tables.length, sourceDigest: inventoryDigest(original), cutoverReady: false })); return;
    }
    await mkdir(output, { recursive: true, mode: 0o700 });
    if ((await lstat(output)).mode & 0o077) throw new MigrationSafetyError('Rehearsal directory must have mode 0700');
    await privateJson(resolve(output, 'source-inventory.json'), original);
    await privateJson(resolve(output, 'source-locale.json'), sourceLocale);
    const file = await open(archive, 'wx', 0o600); await file.close();
    stage = 'snapshot-export';
    const snapshot = String((await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot);
    await tool(values['pg-dump'], dumpArguments(archive, snapshot), sourceEndpoint,
      connections.sourcePgHostaddr, connections.sourcePgSslRootcert, true);
    await chmod(archive, 0o600);
    await source.query('COMMIT'); await source.end(); source = undefined;
    const archiveSha256 = await hashFile(archive);
    await privateJson(`${archive}.manifest.json`, { format: 1, purpose: 'isolated-rehearsal', createdAt: new Date().toISOString(),
      branchId: values['rehearsal-branch-id'], archiveSha256, archiveBytes: (await lstat(archive)).size,
      dumpMajor, source: original, cutoverReady: false, sourceMayHaveAdvanced: true });
    stage = 'isolated-target-restore';
    await target.query('COMMIT');
    await tool(values['pg-restore'], restoreArguments(archive, targetEndpoint.database), targetEndpoint, undefined, connections.targetPgSslRootcert);
    await beginReadOnly(target);
    const copied = await inventoryDatabase(session(target));
    await privateJson(resolve(output, 'restored-inventory.json'), copied);
    const exactCopy = compareInventories(original, copied);
    if (!exactCopy.equal) throw new MigrationSafetyError(`Exact-copy rehearsal verification failed: ${exactCopy.differences.map(name => name === 'schema' ? `schema (${exactCopy.schemaDifferences.join(', ')})` : name).join(', ')}`);
    const targetLocale = await localeChecks(session(target));
    const localeComparison = compareLocaleChecks(sourceLocale, targetLocale);
    await privateJson(resolve(output, 'locale-comparison.json'), { source: sourceLocale, target: targetLocale, comparison: localeComparison });
    if (!localeComparison.compatibleExistingData || !localeComparison.stableByteOrdering)
      throw new MigrationSafetyError('Locale behavior differs for existing business data; review private comparison report');
    stage = 'target-additive-migrations';
    await target.query('COMMIT');
    await migrateDatabase(database(target));
    await beginReadOnly(target);
    const migrated = await inventoryDatabase(session(target));
    await assertAppliedMigrationChecksums(migrated, name => readFile(resolve('database/migrations', name), 'utf8'));
    await privateJson(resolve(output, 'migrated-inventory.json'), migrated);
    const preserved = await originalTableFingerprints(session(target), original);
    await privateJson(resolve(output, 'preserved-original-table-fingerprints.json'), preserved);
    if (JSON.stringify(preserved) !== JSON.stringify(original.tables))
      throw new MigrationSafetyError('Additive migrations changed an original table column value or row');
    if (migrated.migrations.length !== 13) throw new MigrationSafetyError('Expected all13 checksum-verified application migrations');
    const typedBackfills = await assertTypedBackfills(session(target));
    stage = 'repository-read-smoke';
    const reads = await repositoryReadSmoke(database(target));
    await target.query('COMMIT');
    stage = 'rolled-back-repository-write-canary';
    await target.query('BEGIN');
    let canary;
    try { canary = await repositoryWriteCanary(database(target, true)); }
    finally { await target.query('ROLLBACK'); }
    await beginReadOnly(target);
    const afterRollback = await inventoryDatabase(session(target));
    if (!compareInventories(migrated, afterRollback).equal)
      throw new MigrationSafetyError('Write canary rollback changed persisted target data');
    const report = { purpose: 'isolated-rehearsal', branchId: values['rehearsal-branch-id'],
      sourceReadOnly: true, sourceMayHaveAdvanced: true, applicationEndpointSwitched: false, cutoverReady: false,
      exactCopyVerified: true, originalDataPreservedAfterMigrations: true,
      sourceMajor: Math.floor(original.serverVersion / 10000), targetMajor: Math.floor(copied.serverVersion / 10000),
      sourceTables: original.tables.length, sourceRows: original.tables.reduce((total, table) => total + BigInt(table.count), 0n).toString(),
      sourceDigest: inventoryDigest(original), archiveSha256, migrations: migrated.migrations.length,
      localeComparison, typedBackfills, reads, canary: { ...canary, rolledBackAndVerified: true } };
    await privateJson(resolve(output, 'rehearsal-report.json'), report);
    console.log(JSON.stringify(report));
  } finally {
    if (source) { await source.query('ROLLBACK').catch(() => {}); await source.end(); }
    if (target) { await target.query('ROLLBACK').catch(() => {}); await target.end(); }
  }
}
main().catch(error => {
  console.error(JSON.stringify({ stage, error: error instanceof MigrationSafetyError ? error.message : 'Rehearsal failed; inspect connection/version/schema prerequisites privately',
    code: typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined,
    sourceModified: false, applicationEndpointSwitched: false, cutoverReady: false })); process.exitCode = 1;
});
