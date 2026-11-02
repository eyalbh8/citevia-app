import { parseArgs } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';
import type { SqlDatabase } from '../packages/storage/src/sql.js';
import { planRuntimeRole, provisionRuntimeRole } from './lib/database-runtime-role.js';
import { repositoryReadSmoke } from './lib/neon-rehearsal.js';

// Credentials stay in process memory and Secrets Manager throughout this rollout.
// Creates additive resources only: no existing secret or role is overwritten, and
// application configuration is left to the independently reviewed deployment.
const { values } = parseArgs({ options: {
  'source-secret-arn': { type: 'string' }, 'expected-host': { type: 'string' }, 'expected-database': { type: 'string' },
  'runtime-secret-name': { type: 'string' }, 'migration-secret-name': { type: 'string' },
  role: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
const secrets = new SecretsManagerClient({});
let owner: Client | undefined, runtime: Client | undefined, stage = 'arguments';
const createdSecretArns: string[] = [];
const database = (client: Client): SqlDatabase => {
  const db: SqlDatabase = { query: async (sql, params) => {
    const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount };
  }, exec: sql => client.query(sql), close: async () => {}, transaction: async work => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
      const result = await work(db); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  } };
  return db;
};
try {
  for (const key of ['source-secret-arn', 'expected-host', 'expected-database', 'runtime-secret-name', 'migration-secret-name', 'role'] as const)
    if (!values[key]) throw new Error('Missing required argument');
  if (values['runtime-secret-name'] === values['migration-secret-name'] ||
      ![values['runtime-secret-name'], values['migration-secret-name']].every(name => /^citevia\/[a-z0-9/_-]+$/.test(name!)))
    throw new Error('New secrets require distinct citevia/ names');
  stage = 'load-source-secret';
  const source = await secrets.send(new GetSecretValueCommand({ SecretId: values['source-secret-arn'] }));
  const config = externalDatabaseConfig(source.SecretString || '');
  const directHost = config.host!.replace('-pooler.', '.');
  if (directHost !== values['expected-host'] || config.database !== values['expected-database'] || !/\.neon\.tech$/i.test(directHost))
    throw new Error('Source credential does not match the expected database endpoint');
  stage = 'check-new-secret-names';
  for (const name of [values['runtime-secret-name'], values['migration-secret-name']]) {
    try { await secrets.send(new DescribeSecretCommand({ SecretId: name })); throw new Error('Destination secret already exists'); }
    catch (error) { if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error; }
  }
  stage = 'preview-runtime-role';
  owner = new Client({ ...config, host: directHost, ssl: { rejectUnauthorized: true, servername: directHost },
    application_name: 'citevia-credential-preparation', query_timeout: 30000 });
  await owner.connect();
  await owner.query('BEGIN READ ONLY');
  const plan = await planRuntimeRole(database(owner), values.role!);
  await owner.query('ROLLBACK');
  if (plan.roleExists || plan.missingTables.length || plan.publicSchemaCreate || plan.publicDatabaseCreate ||
      plan.publicTablePrivileges.length || plan.publicSecurityDefiners.length)
    throw new Error('Runtime role preview found an unsafe or already existing target');
  if (!values.apply) console.log(JSON.stringify({ dryRun: true, plan,
    runtimeSecretName: values['runtime-secret-name'], migrationSecretName: values['migration-secret-name'], sourceSecretPreserved: true }, null, 2));
  else {
    const pooledHost = directHost.replace('.', '-pooler.');
    const password = randomBytes(36).toString('base64url');
    const credentials = { host: pooledHost, port: config.port, database: config.database, username: values.role, password };
    stage = 'create-runtime-secret';
    // Save the credential before committing the role, so an ambiguous COMMIT is recoverable.
    const runtimeSecret = await secrets.send(new CreateSecretCommand({ Name: values['runtime-secret-name'],
      ClientRequestToken: randomUUID(), SecretString: JSON.stringify(credentials),
      Description: 'Citevia restricted PostgreSQL runtime login; API and scanner only',
      Tags: [{ Key: 'Application', Value: 'citevia' }, { Key: 'Purpose', Value: 'runtime-database' }] }));
    if (!runtimeSecret.ARN) throw new Error('Runtime secret creation returned no ARN');
    createdSecretArns.push(runtimeSecret.ARN);
    stage = 'provision-runtime-role';
    await provisionRuntimeRole(database(owner), { role: values.role!, database: values['expected-database']! }, password);
    stage = 'create-migration-secret';
    const migrationSecret = await secrets.send(new CreateSecretCommand({ Name: values['migration-secret-name'],
      ClientRequestToken: randomUUID(), SecretString: JSON.stringify({ host: directHost, port: config.port,
        database: config.database, username: config.user, password: config.password }),
      Description: 'Citevia PostgreSQL direct owner connection; dedicated IAM migration function only',
      Tags: [{ Key: 'Application', Value: 'citevia' }, { Key: 'Purpose', Value: 'migration-database' }] }));
    if (!migrationSecret.ARN) throw new Error('Migration secret creation returned no ARN');
    createdSecretArns.push(migrationSecret.ARN);
    stage = 'verify-new-runtime-secret';
    const saved = await secrets.send(new GetSecretValueCommand({ SecretId: runtimeSecret.ARN }));
    runtime = new Client({ ...externalDatabaseConfig(saved.SecretString || ''), query_timeout: 20000,
      application_name: 'citevia-restricted-runtime-verification' });
    await runtime.connect();
    await runtime.query('BEGIN READ ONLY');
    const identity = (await runtime.query(`SELECT current_user AS role, r.rolsuper AS superuser,
      r.rolcreatedb AS create_database, r.rolcreaterole AS create_role, r.rolreplication AS replication,
      r.rolbypassrls AS bypass_rls, has_schema_privilege(current_user,'public','CREATE') AS create_in_public,
      current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout,
      current_setting('idle_in_transaction_session_timeout') AS idle_transaction_timeout
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    if (identity.role !== values.role || ['superuser','create_database','create_role','replication','bypass_rls','create_in_public'].some(key => identity[key]))
      throw new Error('New runtime role has unexpected elevated privileges');
    const reads = await repositoryReadSmoke(database(runtime));
    await runtime.query('ROLLBACK');
    console.log(JSON.stringify({ applied: true, runtimeSecretArn: runtimeSecret.ARN, migrationSecretArn: migrationSecret.ARN,
      runtimeIdentity: identity, representativeReads: reads, tablesGranted: plan.tables.length,
      sourceSecretPreserved: true, existingRolesUnchanged: true, customerDataChanged: false, applicationSwitched: false }, null, 2));
  }
} catch (error) {
  const code = (error as { code?: string; name?: string }).code || (error as { name?: string }).name;
  console.error(JSON.stringify({ event: 'database_credential_preparation_failed', stage,
    code: code && /^[A-Za-z0-9_]{3,64}$/.test(code) ? code : 'safety_check_failed',
    createdSecretArns, sourceSecretPreserved: true, applicationSwitched: false }));
  process.exitCode = 1;
} finally { await runtime?.end().catch(() => {}); await owner?.end().catch(() => {}); }
