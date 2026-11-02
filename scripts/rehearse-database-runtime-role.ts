import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';
import { migrateDatabase, type SqlDatabase, type SqlSession } from '../packages/storage/src/sql.js';
import { planRuntimeRole, provisionRuntimeRole } from './lib/database-runtime-role.js';
import { repositoryReadSmoke, repositoryWriteCanary } from './lib/neon-rehearsal.js';

const { values } = parseArgs({ options: {
  'source-secret-arn': { type: 'string' }, 'branch-host': { type: 'string' }, 'branch-id': { type: 'string' },
  apply: { type: 'boolean', default: false }, role: { type: 'string', default: 'citevia_runtime_rehearsal' },
} });
let owner: Client | undefined, runtime: Client | undefined, stage = 'arguments';
const wrap = (client: Client, nested = false): SqlDatabase => {
  const session: SqlSession = { query: async (sql, params) => { const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; }, exec: sql => client.query(sql) };
  return { ...session, close: async () => {}, transaction: async work => {
    await client.query(nested ? 'SAVEPOINT runtime_canary' : 'BEGIN');
    try {
      const result = await work(session); await client.query(nested ? 'RELEASE SAVEPOINT runtime_canary' : 'COMMIT'); return result;
    } catch (error) { await client.query(nested ? 'ROLLBACK TO SAVEPOINT runtime_canary' : 'ROLLBACK').catch(() => {}); throw error; }
  } };
};
try {
  if (!values['source-secret-arn'] || !values['branch-host'] || !/^br-[a-z0-9-]+$/.test(values['branch-id'] || '')) throw new Error('Missing rehearsal arguments');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: values['source-secret-arn'] }));
  const source = externalDatabaseConfig(secret.SecretString || '');
  const host = values['branch-host'];
  if (host === source.host?.replace('-pooler.', '.') || /-pooler\./i.test(host) || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host))
    throw new Error('Rehearsal requires a distinct direct Neon child-branch endpoint');
  stage = 'connect-isolated-branch';
  // Only the explicitly supplied child host is contacted. Production is never connected.
  owner = new Client({ ...source, host, ssl: { rejectUnauthorized: true, servername: host }, query_timeout: 250000,
    application_name: 'citevia-role-rehearsal-owner' });
  await owner.connect();
  const db = wrap(owner);
  await owner.query('BEGIN READ ONLY');
  const plan = await planRuntimeRole(db, values.role);
  await owner.query('ROLLBACK');
  if (!values.apply) console.log(JSON.stringify({ dryRun: true, branchId: values['branch-id'], ...plan }, null, 2));
  else {
    stage = 'rehearse-owner-migration';
    await migrateDatabase(db);
    const migrations = Number((await owner.query('SELECT count(*) AS count FROM citevia_migrations')).rows[0].count);
    stage = 'rehearse-role-provisioning';
    const password = randomBytes(36).toString('base64url');
    const created = await provisionRuntimeRole(db, { role: values.role, database: String(source.database) }, password);
    const pooledHost = host.replace('.', '-pooler.');
    runtime = new Client({ ...source, host: pooledHost, user: values.role, password, query_timeout: 20000,
      ssl: { rejectUnauthorized: true, servername: pooledHost }, application_name: 'citevia-role-rehearsal-runtime' });
    await runtime.connect();
    const runtimeDb = wrap(runtime);
    stage = 'verify-pooled-login-defaults';
    const defaults = (await runtime.query(`SELECT current_user AS role, current_setting('statement_timeout') AS statement_timeout,
      current_setting('lock_timeout') AS lock_timeout, current_setting('idle_in_transaction_session_timeout') AS idle_transaction_timeout`)).rows[0];
    if (defaults.role !== values.role || defaults.statement_timeout !== '15s' || defaults.lock_timeout !== '5s' || defaults.idle_transaction_timeout !== '15s')
      throw new Error('Pooled runtime login did not preserve role defaults');
    stage = 'representative-runtime-reads';
    const reads = await repositoryReadSmoke(runtimeDb);
    stage = 'rolled-back-scanner-write-canary';
    await runtime.query('BEGIN');
    let writes;
    try { writes = await repositoryWriteCanary(wrap(runtime, true)); }
    finally { await runtime.query('ROLLBACK'); }
    stage = 'verify-permission-denials';
    let permissionDenials = 0;
    for (const sql of ['SELECT * FROM citevia_migrations', 'SELECT * FROM data_center_records',
      'CREATE TABLE public.runtime_forbidden (id integer)', 'ALTER TABLE public.users ADD COLUMN runtime_forbidden integer',
      'DROP TABLE public.citevia_cost_events', 'TRUNCATE public.analytics_events', 'CREATE ROLE runtime_forbidden']) {
      try { await runtime.query(sql); throw new Error('Runtime accepted a forbidden operation'); }
      catch (error) { if ((error as { code?: string }).code !== '42501') throw error; permissionDenials++; }
    }
    stage = 'verify-server-statement-deadline';
    let statementCancelled = false;
    try { await runtime.query('SELECT pg_sleep(16)'); }
    catch (error) { if ((error as { code?: string }).code !== '57014') throw error; statementCancelled = true; }
    if (!statementCancelled) throw new Error('Runtime statement deadline did not cancel');
    stage = 'verify-server-lock-deadline';
    await owner.query('BEGIN');
    let lockCancelled = false;
    try {
      await owner.query('LOCK TABLE citevia_provider_admission IN ACCESS EXCLUSIVE MODE');
      try { await runtime.query('SELECT count(*) FROM citevia_provider_admission'); }
      catch (error) { if ((error as { code?: string }).code !== '55P03') throw error; lockCancelled = true; }
    } finally { await owner.query('ROLLBACK'); }
    if (!lockCancelled) throw new Error('Runtime lock deadline did not cancel');
    await runtime.query('SELECT 1');
    console.log(JSON.stringify({ dryRun: false, branchId: values['branch-id'], productionConnected: false,
      migrationsVerified: migrations, tablesGranted: created.tables.length, pooledDefaults: defaults,
      reads, scannerWritesRolledBack: writes, permissionDenials, statementCancelled, lockCancelled, healthyAfterCancellation: true }, null, 2));
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(JSON.stringify({ event: 'runtime_role_rehearsal_failed', stage,
    code: code && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'rehearsal_check_failed' }));
  process.exitCode = 1;
} finally { await runtime?.end().catch(() => {}); await owner?.end().catch(() => {}); }
