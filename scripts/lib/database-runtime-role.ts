import type { SqlDatabase, SqlSession } from '../../packages/storage/src/sql.js';
import { databaseTimeouts, type DatabaseTimeouts } from '../../packages/storage/src/database-config.js';

// This is intentionally explicit. Migrations must extend this list and refresh
// grants before a release starts using a new table. Unrelated legacy tables and
// the migration ledger are not accessible to the application's login.
export const runtimeTables = [
  'accounts', 'account_settings', 'analytics_events', 'competitors', 'prompt_responses',
  'prompts', 'recommendations', 'results', 'scans', 'topics', 'tracked_recommendations',
  'user_accounts', 'users',
  'citevia_agent_images', 'citevia_agent_posts', 'citevia_analysis_batches',
  'citevia_citation_captures', 'citevia_cost_events', 'citevia_dispatch_accounts',
  'citevia_dispatch_jobs', 'citevia_dispatch_state', 'citevia_geo_backlink_activities',
  'citevia_geo_backlink_candidates', 'citevia_geo_backlink_ledger', 'citevia_geo_backlink_performance',
  'citevia_geo_backlink_recommendations', 'citevia_geo_backlink_reports', 'citevia_identities',
  'citevia_mcp_connections', 'citevia_mcp_records', 'citevia_mcp_request_limits',
  'citevia_onboarding_jobs', 'citevia_projects', 'citevia_prompt_results',
  'citevia_provider_admission', 'citevia_provider_leases', 'citevia_response_citations',
  'citevia_runs', 'citevia_social_occurrences', 'citevia_social_publications',
  'citevia_tracked_url_matches', 'citevia_tracked_urls', 'citevia_traffic_installations',
  'citevia_website_health_audits',
] as const;

export interface RuntimeRolePlan {
  role: string;
  database: string;
  executor: string;
  roleExists: boolean;
  tables: string[];
  missingTables: string[];
  sequences: string[];
  publicSchemaCreate: boolean;
  publicDatabaseCreate: boolean;
  publicTablePrivileges: string[];
  publicSecurityDefiners: string[];
  timeouts: DatabaseTimeouts;
}

export function runtimeRoleName(role: string): string {
  if (!/^citevia_runtime_[a-z0-9_]{1,40}$/.test(role))
    throw new Error('Runtime role must start with citevia_runtime_ and contain only lowercase letters, digits and underscores');
  return role;
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function planRuntimeRole(sql: SqlSession, role: string): Promise<RuntimeRolePlan> {
  runtimeRoleName(role);
  const identity = (await sql.query<{ database: string; executor: string; role_exists: boolean }>(
    'SELECT current_database() AS database, current_user AS executor, EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists', [role])).rows[0];
  const tables = (await sql.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
    AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[...runtimeTables]])).rows.map(row => row.name);
  const sequences = (await sql.query<{ name: string }>(`SELECT DISTINCT s.relname AS name FROM pg_class s
    JOIN pg_namespace n ON n.oid=s.relnamespace JOIN pg_depend d ON d.objid=s.oid
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
    WHERE n.nspname='public' AND tn.nspname='public' AND s.relkind='S' AND d.deptype IN ('a','i')
    AND t.relname=ANY($1::text[]) ORDER BY s.relname`, [tables])).rows.map(row => row.name);
  const publicCreate = (await sql.query<{ schema_create: boolean; database_create: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE') AS schema_create,
    EXISTS(SELECT 1 FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE') AS database_create`)).rows[0];
  const publicTablePrivileges = (await sql.query<{ name: string }>(`SELECT DISTINCT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND a.grantee=0 ORDER BY c.relname`)).rows.map(row => row.name);
  const publicSecurityDefiners = (await sql.query<{ name: string }>(`SELECT p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.prosecdef AND a.grantee=0 AND a.privilege_type='EXECUTE' ORDER BY p.proname`)).rows.map(row => row.name);
  return { role, database: identity.database, executor: identity.executor, roleExists: identity.role_exists,
    tables, missingTables: runtimeTables.filter(table => !tables.includes(table)), sequences,
    publicSchemaCreate: publicCreate.schema_create, publicDatabaseCreate: publicCreate.database_create,
    publicTablePrivileges, publicSecurityDefiners, timeouts: databaseTimeouts() };
}

/** Creates only a fresh role. It never rewrites existing credentials or global PUBLIC grants. */
export async function provisionRuntimeRole(db: SqlDatabase, expected: { role: string; database: string }, password: string) {
  runtimeRoleName(expected.role);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(password)) throw new Error('Use a generated runtime password of at least 40 URL-safe characters');
  return db.transaction(async tx => {
    const plan = await planRuntimeRole(tx, expected.role);
    if (plan.database !== expected.database) throw new Error('Runtime role target database does not match');
    if (plan.roleExists) throw new Error('Runtime role already exists; refusing to replace existing credentials or grants');
    if (plan.missingTables.length) throw new Error('Required runtime tables are missing; apply and verify migrations first');
    if (plan.publicSchemaCreate || plan.publicDatabaseCreate || plan.publicTablePrivileges.length || plan.publicSecurityDefiners.length)
      throw new Error('PUBLIC has privileges that bypass runtime isolation; review and fix them before provisioning');
    const role = identifier(plan.role), database = identifier(plan.database);
    // The generated password cannot contain SQL syntax; callers must never log query text.
    await tx.exec(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await tx.exec(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await tx.exec(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await tx.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${plan.tables.map(table => `public.${identifier(table)}`).join(', ')} TO ${role}`);
    if (plan.sequences.length)
      await tx.exec(`GRANT USAGE ON SEQUENCE ${plan.sequences.map(sequence => `public.${identifier(sequence)}`).join(', ')} TO ${role}`);
    for (const [name, timeout] of [['statement_timeout', plan.timeouts.statement], ['lock_timeout', plan.timeouts.lock],
      ['idle_in_transaction_session_timeout', plan.timeouts.idleTransaction]] as const)
      await tx.exec(`ALTER ROLE ${role} IN DATABASE ${database} SET ${name} = '${timeout}ms'`);
    await tx.exec(`ALTER ROLE ${role} IN DATABASE ${database} SET search_path = public`);
    return { ...plan, roleExists: true };
  });
}
