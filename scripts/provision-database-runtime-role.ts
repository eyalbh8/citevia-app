import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';
import type { SqlDatabase } from '../packages/storage/src/sql.js';
import { planRuntimeRole, provisionRuntimeRole, runtimeRoleName } from './lib/database-runtime-role.js';

const { values } = parseArgs({ options: {
  'secret-arn': { type: 'string' }, 'expected-host': { type: 'string' }, 'expected-database': { type: 'string' },
  role: { type: 'string' }, apply: { type: 'boolean', default: false },
  'runtime-host': { type: 'string' }, 'credentials-file': { type: 'string' }, help: { type: 'boolean', default: false },
} });
const usage = `Usage: node --import tsx scripts/provision-database-runtime-role.ts
  --secret-arn OWNER_SECRET --expected-host DIRECT_HOST --expected-database DATABASE --role citevia_runtime_v1
  [--apply --runtime-host POOLED_HOST --credentials-file /private/directory/runtime.json]
Preview is read-only and default. Apply creates a new login only; it never switches the app or overwrites an existing role.
Rehearse on an isolated Neon branch before production. The credential directory must have mode 0700.`;
let client: Client | undefined, stage = 'arguments', credentialsWritten = false;
try {
  if (values.help) { console.log(usage); }
  else {
    if (!values['secret-arn'] || !values['expected-host'] || !values['expected-database'] || !values.role)
      throw new Error('Required arguments are missing');
    runtimeRoleName(values.role);
    stage = 'load-owner-secret';
    const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: values['secret-arn'] }));
    const config = externalDatabaseConfig(secret.SecretString || '');
    // An explicitly verified direct Neon endpoint may be derived from the same branch's pooled credential.
    const directHost = /\.neon\.tech$/i.test(config.host || '') ? config.host!.replace('-pooler.', '.') : config.host;
    if (directHost !== values['expected-host'] || config.database !== values['expected-database'] || /-pooler\./i.test(directHost || ''))
      throw new Error('Owner endpoint does not match the expected direct target');
    stage = 'connect-direct';
    client = new Client({ ...config, host: directHost,
      ssl: { rejectUnauthorized: true, servername: directHost }, query_timeout: 30000,
      application_name: 'citevia-runtime-role-provisioner' });
    await client.connect();
    const connected = client;
    const db: SqlDatabase = {
      query: async (sql, params) => { const result = await connected.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; },
      exec: sql => connected.query(sql), close: async () => {},
      transaction: async work => {
        await connected.query(values.apply ? 'BEGIN' : 'BEGIN READ ONLY');
        try {
          await connected.query("SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
          const result = await work(db); await connected.query('COMMIT'); return result;
        } catch (error) { await connected.query('ROLLBACK').catch(() => {}); throw error; }
      },
    };
    stage = 'preview';
    const plan = await db.transaction(tx => planRuntimeRole(tx, values.role!));
    if (!values.apply) console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    else {
      stage = 'validate-private-credential-output';
      if (!values['credentials-file'] || !values['runtime-host']) throw new Error('Apply requires a private credential output and runtime host');
      const runtimeHost = values['runtime-host'];
      if (runtimeHost.replace('-pooler.', '.') !== directHost || !/\.neon\.tech$/i.test(runtimeHost))
        throw new Error('Runtime host must belong to the same Neon endpoint');
      const output = resolve(values['credentials-file']);
      const parent = await lstat(dirname(output));
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077))
        throw new Error('Credential directory must be a private directory (0700)');
      const password = randomBytes(36).toString('base64url');
      // Save before the commit: if the network fails after COMMIT, recovery still has the new credential.
      await writeFile(output, JSON.stringify({ host: runtimeHost, port: config.port, database: config.database,
        username: values.role, password }), { mode: 0o600, flag: 'wx' });
      credentialsWritten = true;
      stage = 'create-runtime-role';
      const applied = await provisionRuntimeRole(db, { role: values.role, database: values['expected-database'] }, password);
      console.log(JSON.stringify({ dryRun: false, applied: true, database: applied.database, role: applied.role,
        tablesGranted: applied.tables.length, sequencesGranted: applied.sequences.length, timeouts: applied.timeouts,
        privateCredentialWritten: true, applicationSwitched: false }, null, 2));
    }
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(JSON.stringify({ event: 'runtime_role_provision_failed', stage,
    code: code && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'safety_check_failed',
    privateCredentialPreserved: credentialsWritten, usage: stage === 'arguments' ? usage : undefined }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
