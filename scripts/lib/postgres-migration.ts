import { createHash } from 'node:crypto';
import type { SqlSession } from '../../packages/storage/src/sql.js';

export interface MigrationEndpoint {
  host: string; port: number; database: string; username: string; password: string;
}
export class MigrationSafetyError extends Error {}
export function parseMigrationEndpoint(value: string): MigrationEndpoint {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new MigrationSafetyError('Use a PostgreSQL connection URL');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!url.hostname || !url.username || !url.password || !/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(database))
    throw new MigrationSafetyError('Connection URL must contain host, database, username and password');
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MigrationSafetyError('Invalid database port');
  return { host: url.hostname.toLowerCase(), port, database,
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}
export function assertMigrationEndpoints(source: MigrationEndpoint, target: MigrationEndpoint) {
  const canonical = (host: string) => host.replace('-pooler.', '.').replace(/\.$/, '');
  if (canonical(source.host) === canonical(target.host) && source.database === target.database)
    throw new MigrationSafetyError('Source and target refer to the same database');
  if (!target.host.endsWith('.neon.tech') || target.host.includes('-pooler.'))
    throw new MigrationSafetyError('Target must be a direct, unpooled Neon endpoint');
}
export function assertMigrationVersions(sourceVersion: number, targetVersion: number, dumpMajor: number, restoreMajor: number) {
  const sourceMajor = Math.floor(sourceVersion / 10000), targetMajor = Math.floor(targetVersion / 10000);
  if (dumpMajor < sourceMajor || targetMajor < sourceMajor || targetMajor < dumpMajor || restoreMajor < dumpMajor)
    throw new MigrationSafetyError('Require source major <= pg_dump major <= target major and pg_restore major >= pg_dump major');
}
export const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
export interface MigrationInventory {
  serverVersion: number;
  database: string;
  environment: Record<string, unknown>;
  schema: Record<string, Record<string, unknown>[]>;
  tables: { name: string; count: string; buckets: Record<string, unknown>[] }[];
  sequences: Record<string, unknown>[];
  migrations: Record<string, unknown>[];
}

/** Must run on one read-only repeatable-read session. No customer row text leaves PostgreSQL. */
export async function inventoryDatabase(db: SqlSession, maxBytes = 512 * 1024 * 1024): Promise<MigrationInventory> {
  // Catalog deparsers qualify visible objects according to the session search path.
  // Keep exact schema fingerprints independent of role/database defaults, locally
  // to the caller's required read-only transaction; retain every schema check.
  await db.query('SET LOCAL search_path = pg_catalog, public');
  const metadata = (await db.query(`SELECT current_database() AS database,current_setting('server_version_num')::int AS version,
    pg_encoding_to_char(encoding) AS encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()`)).rows[0];
  const unsupported = (await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname NOT IN ('public','information_schema') AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r','p','m','f','S','v'))
      OR (n.nspname='public' AND c.relkind='f')`)).rows;
  if (unsupported.length) throw new MigrationSafetyError('Non-public objects or foreign tables require an expanded migration inventory');
  const objects = (await db.query(`SELECT c.relname AS name,c.relkind AS kind,pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','m') ORDER BY c.relname`)).rows;
  if (objects.reduce((sum, row) => sum + Number(row.bytes), 0) > maxBytes)
    throw new MigrationSafetyError('Database exceeds the configured verification byte budget');
  const schema: MigrationInventory['schema'] = {};
  const queries: Record<string, string> = {
    relations: `SELECT c.relname AS name,c.relkind,c.relpersistence,c.relreplident,c.relispartition,c.relrowsecurity,c.relforcerowsecurity,pg_get_partkeydef(c.oid) AS partition_key,
      pg_get_expr(c.relpartbound,c.oid) AS partition_bound FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','m','v','f') ORDER BY c.relname`,
    columns: `SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression,collation_name
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
    constraints: `SELECT r.relname AS table_name,c.conname AS name,c.contype,c.convalidated,pg_get_constraintdef(c.oid,false) AS definition
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' ORDER BY r.relname,c.conname`,
    indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
    functions: `SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY p.proname,arguments`,
    triggers: `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled,pg_get_triggerdef(t.oid,false) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    policies: `SELECT c.relname AS table_name,p.polname AS name,p.polcmd,p.polpermissive,
      ARRAY(SELECT CASE WHEN role_id=0 THEN 'PUBLIC' ELSE r.rolname::text END FROM unnest(p.polroles) role_id
        LEFT JOIN pg_roles r ON r.oid=role_id ORDER BY 1) AS roles,
      pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,p.polname`,
    views: `SELECT c.relname AS name,c.relkind,pg_get_viewdef(c.oid,false) AS definition FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname`,
    enums: `SELECT t.typname,e.enumsortorder,e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`,
    extensions: `SELECT extname,extversion FROM pg_extension ORDER BY extname`,
  };
  for (const [name, query] of Object.entries(queries)) schema[name] = (await db.query(query)).rows;
  const largeObjects = (await db.query('SELECT count(*)::int AS count FROM pg_largeobject_metadata')).rows[0];
  if (Number(largeObjects.count)) throw new MigrationSafetyError('Large objects require an expanded migration verification before cutover');
  const tables: MigrationInventory['tables'] = [];
  for (const object of objects) {
    const buckets = (await db.query(`WITH hashed AS (
      SELECT encode(sha256(convert_to(to_jsonb(row_value)::text,'UTF8')),'hex') AS h FROM public.${identifier(String(object.name))} row_value
    ) SELECT substring(h from 1 for 2) AS bucket,count(*)::text AS count,
      encode(sha256(convert_to(string_agg(h,'' ORDER BY h),'UTF8')),'hex') AS hash
      FROM hashed GROUP BY substring(h from 1 for 2) ORDER BY bucket`)).rows;
    tables.push({ name: String(object.name), count: buckets.reduce((sum, row) => sum + BigInt(String(row.count)), 0n).toString(), buckets });
  }
  const sequenceMetadata = (await db.query(`SELECT sequencename AS name,data_type,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text
    FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)).rows;
  const sequences = [];
  for (const sequence of sequenceMetadata) {
    const state = (await db.query(`SELECT last_value::text,is_called FROM public.${identifier(String(sequence.name))}`)).rows[0];
    sequences.push({ ...sequence, ...state });
  }
  const hasLedger = objects.some(row => row.name === 'citevia_migrations');
  const migrations = hasLedger ? (await db.query('SELECT name,checksum FROM public.citevia_migrations ORDER BY name')).rows : [];
  return { serverVersion: Number(metadata.version), database: String(metadata.database),
    environment: { encoding: metadata.encoding, datcollate: metadata.datcollate, datctype: metadata.datctype }, schema, tables, sequences, migrations };
}

export function compareInventories(source: MigrationInventory, target: MigrationInventory) {
  const differences: string[] = [];
  for (const name of ['schema', 'tables', 'sequences', 'migrations'] as const)
    if (JSON.stringify(source[name]) !== JSON.stringify(target[name])) differences.push(name);
  const schemaDifferences = [...new Set([...Object.keys(source.schema), ...Object.keys(target.schema)])]
    .filter(name => JSON.stringify(source.schema[name]) !== JSON.stringify(target.schema[name]));
  return { equal: differences.length === 0, differences, schemaDifferences,
    localeChanged: JSON.stringify(source.environment) !== JSON.stringify(target.environment) };
}
export function inventoryDigest(inventory: MigrationInventory) {
  return createHash('sha256').update(JSON.stringify({ schema: inventory.schema, tables: inventory.tables,
    sequences: inventory.sequences, migrations: inventory.migrations })).digest('hex');
}
export async function assertAppliedMigrationChecksums(inventory: MigrationInventory,
  readMigration: (name: string) => Promise<string>) {
  for (const migration of inventory.migrations) {
    const name = String(migration.name);
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) throw new MigrationSafetyError('Unrecognized applied migration name');
    const checksum = createHash('sha256').update(await readMigration(name)).digest('hex');
    if (checksum !== migration.checksum) throw new MigrationSafetyError('An applied migration checksum differs from this checkout');
  }
}
export function dumpArguments(path: string, snapshot: string) {
  return ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=15s', `--snapshot=${snapshot}`, `--file=${path}`];
}
export function restoreArguments(path: string, database: string) {
  return ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${database}`, path];
}
