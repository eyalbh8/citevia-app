import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';

// Read-only by construction. Never print credentials, URLs, SQL, or customer rows.
const { values } = parseArgs({ options: { 'secret-arn': { type: 'string' } } });
let client: Client | undefined;
try {
  if (!values['secret-arn']) throw new Error('Provide --secret-arn');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: values['secret-arn'] }));
  client = new Client({ ...externalDatabaseConfig(secret.SecretString || ''), query_timeout: 20000,
    application_name: 'citevia-security-inspection' });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '20s'");
  const identity = (await client.query(`SELECT current_user AS username, current_database() AS database,
    current_setting('server_version') AS server_version,
    r.rolsuper AS superuser, r.rolcreatedb AS create_database, r.rolcreaterole AS create_role,
    r.rolreplication AS replication, r.rolbypassrls AS bypass_rls,
    pg_has_role(current_user, d.datdba, 'USAGE') AS database_owner,
    has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
    has_database_privilege(current_user, current_database(), 'TEMP') AS can_create_temporary_objects
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  const memberships = (await client.query(`SELECT role.rolname AS role_name, membership.admin_option
    FROM pg_auth_members membership JOIN pg_roles role ON role.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname=current_user ORDER BY role.rolname`)).rows;
  const roleDefaults = (await client.query(`SELECT COALESCE(d.datname, '*') AS database, settings.setconfig AS defaults
    FROM pg_db_role_setting settings LEFT JOIN pg_database d ON d.oid=settings.setdatabase
    JOIN pg_roles r ON r.oid=settings.setrole WHERE r.rolname=current_user
    AND (settings.setdatabase=0 OR d.datname=current_database()) ORDER BY database`)).rows;
  const schema = (await client.query(`SELECT count(*)::integer AS tables,
    count(*) FILTER (WHERE pg_has_role(current_user,c.relowner,'USAGE'))::integer AS owned_tables,
    count(*) FILTER (WHERE c.relrowsecurity)::integer AS rls_tables,
    count(*) FILTER (WHERE has_table_privilege(current_user,c.oid,'TRUNCATE'))::integer AS truncatable_tables,
    count(*) FILTER (WHERE has_table_privilege(current_user,c.oid,'TRIGGER'))::integer AS triggerable_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows[0];
  const constraints = (await client.query(`SELECT count(*) FILTER (WHERE NOT convalidated)::integer AS unvalidated_constraints
    FROM pg_constraint WHERE connamespace='public'::regnamespace`)).rows[0];
  const indexes = (await client.query(`SELECT count(*) FILTER (WHERE NOT i.indisvalid)::integer AS invalid_indexes,
    count(*) FILTER (WHERE NOT i.indisready)::integer AS unready_indexes
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'`)).rows[0];
  const sizes = (await client.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
    coalesce(sum(n_dead_tup),0)::text AS estimated_dead_rows,
    coalesce(sum(seq_scan),0)::text AS sequential_scans,
    coalesce(sum(idx_scan),0)::text AS index_scans FROM pg_stat_user_tables`)).rows[0];
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ readOnly: true, identity, memberships, roleDefaults, schema, constraints, indexes, sizes }, null, 2));
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(JSON.stringify({ event: 'database_security_inspection_failed', code: code && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'inspection_error' }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
