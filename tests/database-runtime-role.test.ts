import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { PostgresRepository, type SqlDatabase, type SqlSession } from '@citevia/storage';
import { planRuntimeRole, provisionRuntimeRole, runtimeRoleName, runtimeTables } from '../scripts/lib/database-runtime-role.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

let owner: SqlDatabase, runtime: SqlDatabase;
const role = 'citevia_runtime_test';
beforeAll(async () => {
  owner = await localPostgres();
  await provisionRuntimeRole(owner, { role, database: String((await owner.query('SELECT current_database() AS name')).rows[0].name) }, 'a'.repeat(48));
  const transaction = <T>(work: (tx: SqlSession) => Promise<T>) => owner.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return work(tx);
  });
  runtime = { transaction, query: (sql, params) => transaction(tx => tx.query(sql, params)),
    exec: sql => transaction(tx => tx.exec(sql)), close: async () => {} };
}, 30000);
afterAll(async () => { await owner?.close(); });

describe('restricted database runtime role', () => {
  it('covers the schema explicitly without granting unrelated legacy tables or the migration ledger', async () => {
    const plan = await planRuntimeRole(owner, 'citevia_runtime_next');
    expect(plan.missingTables).toEqual([]);
    expect(plan.tables).toHaveLength(runtimeTables.length);
    expect(plan.publicSchemaCreate).toBe(false);
    expect(plan.publicTablePrivileges).toEqual([]);
    const permissions = (await owner.query<{ name: string; crud: boolean; truncate: boolean; trigger: boolean }>(`SELECT c.relname AS name,
      has_table_privilege($1,c.oid,'SELECT') AND has_table_privilege($1,c.oid,'INSERT') AND
      has_table_privilege($1,c.oid,'UPDATE') AND has_table_privilege($1,c.oid,'DELETE') AS crud,
      has_table_privilege($1,c.oid,'TRUNCATE') AS truncate, has_table_privilege($1,c.oid,'TRIGGER') AS trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`, [role])).rows;
    for (const row of permissions) {
      expect(row.crud, row.name).toBe((runtimeTables as readonly string[]).includes(row.name));
      expect(row.truncate, row.name).toBe(false);
      expect(row.trigger, row.name).toBe(false);
    }
  });
  it('preserves repository identity, account, project and membership read/write behavior', async () => {
    const repository = new PostgresRepository(runtime);
    const identity = testIdentity('runtime-role-owner');
    const user = await repository.syncUser(identity);
    const project = newProject({ id: 'runtime-role-project', name: 'Runtime role canary', prompts: ['Which service works?'] });
    await repository.saveProject(project, null);
    await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
    expect((await repository.getUser(identity.subject))?.id).toBe(user.id);
    expect((await repository.getProject(project.id))?.name).toBe(project.name);
    expect((await repository.listProjectSummaries(identity.subject, { offset: 0, limit: 10 })).items[0].id).toBe(project.id);
  });
  it.each([
    'SELECT * FROM citevia_migrations',
    'SELECT * FROM data_center_records',
    'CREATE TABLE public.runtime_forbidden (id integer)',
    'ALTER TABLE public.users ADD COLUMN runtime_forbidden integer',
    'DROP TABLE public.citevia_cost_events',
    'TRUNCATE public.analytics_events',
    'CREATE ROLE runtime_forbidden',
  ])('denies runtime SQL: %s', async sql => {
    await expect(runtime.exec(sql)).rejects.toMatchObject({ code: '42501' });
  });
  it('sets server-side login defaults for standalone pooled statements', async () => {
    const settings = (await owner.query<{ settings: string[] }>(`SELECT s.setconfig AS settings
      FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole
      JOIN pg_database d ON d.oid=s.setdatabase WHERE r.rolname=$1 AND d.datname=current_database()`, [role])).rows[0].settings;
    expect(settings).toEqual(expect.arrayContaining(['statement_timeout=15000ms', 'lock_timeout=5000ms',
      'idle_in_transaction_session_timeout=15000ms', 'search_path=public']));
  });
  it('never replaces an existing login or password', async () => {
    const database = String((await owner.query('SELECT current_database() AS name')).rows[0].name);
    await expect(provisionRuntimeRole(owner, { role, database }, 'b'.repeat(48))).rejects.toThrow('already exists');
  });
  it('refuses PUBLIC privileges that would make the restriction ineffective', async () => {
    const database = String((await owner.query('SELECT current_database() AS name')).rows[0].name);
    await owner.exec('GRANT SELECT ON public.data_center_records TO PUBLIC');
    try {
      await expect(provisionRuntimeRole(owner, { role: 'citevia_runtime_refused', database }, 'c'.repeat(48))).rejects.toThrow('PUBLIC');
      expect((await owner.query("SELECT 1 FROM pg_roles WHERE rolname='citevia_runtime_refused'")).rows).toHaveLength(0);
    } finally { await owner.exec('REVOKE SELECT ON public.data_center_records FROM PUBLIC'); }
  });
  it.each(['owner', 'citevia_runtime_"; DROP TABLE users; --', 'citevia_runtime_', 'citevia_runtime_ADMIN'])('rejects unsafe or ambiguous role %s', name => {
    expect(() => runtimeRoleName(name)).toThrow('Runtime role must start');
  });
});
