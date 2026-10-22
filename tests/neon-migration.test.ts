import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { migrateDatabase } from '../packages/storage/src/sql.js';
import { assertAppliedMigrationChecksums, assertMigrationEndpoints, assertMigrationVersions, compareInventories, dumpArguments,
  inventoryDatabase, inventoryDigest, parseMigrationEndpoint, restoreArguments } from '../scripts/lib/postgres-migration.js';

describe('Neon PostgreSQL migration safety', () => {
  it('rejects source/target aliases and pooled restore endpoints without exposing credentials', () => {
    const source = parseMigrationEndpoint('postgresql://user:encoded%40password@source.rds.amazonaws.com/citevia');
    const target = parseMigrationEndpoint('postgresql://user:password@ep-target.region.aws.neon.tech/citevia');
    expect(source.password).toBe('encoded@password');
    expect(() => assertMigrationEndpoints(source, target)).not.toThrow();
    expect(() => assertMigrationEndpoints(target, { ...target, host: 'ep-target-pooler.region.aws.neon.tech', port: 6432 })).toThrow('same database');
    expect(() => assertMigrationEndpoints(source, { ...target, host: 'ep-target-pooler.region.aws.neon.tech' })).toThrow('unpooled');
    expect(() => parseMigrationEndpoint('postgresql://user:password@source.rds.amazonaws.com/host%3Devil')).toThrow('database');
  });
  it('gates tool/server compatibility and emits complete, non-destructive native-tool plans', () => {
    expect(() => assertMigrationVersions(160009, 170006, 17, 17)).not.toThrow();
    expect(() => assertMigrationVersions(160009, 160009, 17, 17)).toThrow('target major');
    expect(() => assertMigrationVersions(180000, 180000, 17, 17)).toThrow('source major');
    expect(() => assertMigrationVersions(160009, 170006, 17, 16)).toThrow('pg_restore');
    expect(dumpArguments('/private/archive.dump', 'snapshot-id')).toContain('--format=custom');
    expect(dumpArguments('/private/archive.dump', 'snapshot-id').some(arg => /table|schema|exclude/.test(arg))).toBe(false);
    const restore = restoreArguments('/private/archive.dump', 'citevia');
    expect(restore).toContain('--single-transaction');
    expect(restore).toContain('--exit-on-error');
    expect(restore).not.toContain('--clean');
    expect(restore).not.toContain('--create');
    expect(restore.join(' ')).not.toContain('postgresql://');
  });
  it.each(['pg_catalog, public', ''])('migrates into public and restores the caller path %j', async path => {
    const db = await localPostgres(undefined, { migrate: false });
    try {
      await db.query("SELECT set_config('search_path',$1,false)", [path]);
      const callerPath = (await db.query('SHOW search_path')).rows[0].search_path;
      await migrateDatabase(db);
      expect((await db.query('SHOW search_path')).rows[0].search_path).toBe(callerPath);
      const names = ['accounts', 'citevia_analysis_batches', 'citevia_cost_events', 'citevia_migrations', 'citevia_runs'];
      expect((await db.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=ANY($1::text[]) ORDER BY c.relname`, [names])).rows)
        .toEqual(names.map(name => ({ schema: 'public', name })));
      expect((await db.query('SELECT name FROM public.citevia_migrations')).rows).toHaveLength(13);
      // Re-entry uses the same public ledger even when the caller has no visible schema.
      await migrateDatabase(db);
      expect((await db.query('SELECT name FROM public.citevia_migrations')).rows).toHaveLength(13);
      expect((await db.query('SHOW search_path')).rows[0].search_path).toBe(callerPath);
    } finally { await db.close(); }
  }, 30000);
  it('compares exact schema under a canonical transaction-local path despite an empty target default', async () => {
    const source = await localPostgres(undefined, { migrate: false });
    const target = await localPostgres(undefined, { migrate: false });
    try {
      const ddl = `CREATE SEQUENCE event_sequence;
        CREATE TABLE parents(id bigint PRIMARY KEY);
        CREATE TABLE events(id bigint PRIMARY KEY DEFAULT nextval('event_sequence'),parent_id bigint REFERENCES parents(id));
        INSERT INTO parents VALUES(1); INSERT INTO events(parent_id) VALUES(1);`;
      await source.exec(ddl); await target.exec(ddl);
      const originalPath = (await target.query('SHOW search_path')).rows[0].search_path;
      const original = await source.transaction(async tx => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return inventoryDatabase(tx);
      });
      const copied = await target.transaction(async tx => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await tx.query("SET LOCAL search_path = ''");
        const before = (await tx.query("SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_constraint WHERE conname='events_parent_id_fkey'")).rows[0];
        expect(before.definition).toContain('REFERENCES public.parents(id)');
        const inventory = await inventoryDatabase(tx);
        expect((await tx.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
        expect((await tx.query('SHOW search_path')).rows[0].search_path).toBe('pg_catalog, public');
        return inventory;
      });
      expect(copied.schema).toEqual(original.schema);
      expect(compareInventories(original, copied)).toMatchObject({ equal: true, differences: [], schemaDifferences: [] });
      expect((await target.query('SHOW search_path')).rows[0].search_path).toBe(originalPath);
      const changed = structuredClone(copied);
      changed.schema.constraints[0].definition = 'PRIMARY KEY (parent_id)';
      expect(compareInventories(original, changed)).toMatchObject({ equal: false, differences: ['schema'], schemaDifferences: ['constraints'] });
    } finally { await source.close(); await target.close(); }
  }, 30000);
  it('verifies every table row, migration checksum, sequence and trigger while returning only fingerprints', async () => {
    const source = await localPostgres(undefined, { migrate: false });
    const target = await localPostgres(undefined, { migrate: false });
    try {
      const ddl = `CREATE TABLE citevia_migrations(name text PRIMARY KEY,checksum text,applied_at timestamptz);
        INSERT INTO citevia_migrations VALUES('001_igeo.sql','exact-checksum','2026-10-01T00:00:00Z');
        CREATE SEQUENCE event_sequence;
        CREATE TABLE events(id bigint PRIMARY KEY DEFAULT nextval('event_sequence'),payload jsonb,created_at timestamptz);
        INSERT INTO events(payload,created_at) VALUES('{"private":"saved-answer","value":1}','2026-10-01T00:00:00Z'),
          ('{"private":"second-answer","value":2}','2026-10-02T00:00:00Z');
        CREATE FUNCTION keep_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER keep_event BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION keep_event();`;
      await source.exec(ddl); await target.exec(ddl);
      const original = await inventoryDatabase(source);
      const matching = { ...original, migrations: [{ name: '001_igeo.sql', checksum: createHash('sha256').update('schema').digest('hex') }] };
      await expect(assertAppliedMigrationChecksums(matching, async () => 'schema')).resolves.toBeUndefined();
      await expect(assertAppliedMigrationChecksums(matching, async () => 'changed')).rejects.toThrow('checksum');
      await expect(assertAppliedMigrationChecksums({ ...matching, migrations: [{ name: '../private', checksum: 'x' }] }, async () => 'schema')).rejects.toThrow('name');
      expect(original.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'events', count: '2' })]));
      expect(original.schema.triggers).toHaveLength(1);
      expect(original.sequences[0]).toMatchObject({ name: 'event_sequence', last_value: '2', is_called: true });
      expect(JSON.stringify(original)).not.toContain('saved-answer');
      expect(compareInventories(original, await inventoryDatabase(target)).equal).toBe(true);
      const originalDigest = inventoryDigest(original);
      await target.query("UPDATE events SET payload=payload || '{\"changed\":true}'::jsonb WHERE id=1");
      const changed = await inventoryDatabase(target);
      expect(changed.tables.find(table => table.name === 'events')!.count).toBe('2');
      expect(compareInventories(original, changed).differences).toContain('tables');
      expect(inventoryDigest(changed)).not.toBe(originalDigest);
      await target.query("SELECT nextval('event_sequence')");
      expect(compareInventories(original, await inventoryDatabase(target)).differences).toContain('sequences');
      await target.query("UPDATE citevia_migrations SET checksum='different'");
      expect(compareInventories(original, await inventoryDatabase(target)).differences).toContain('migrations');
      await target.exec('ALTER TABLE events ENABLE ROW LEVEL SECURITY; CREATE POLICY view_events ON events FOR SELECT TO PUBLIC USING (id>0)');
      const policyChanged = await inventoryDatabase(target);
      expect(policyChanged.schema.policies).toEqual([expect.objectContaining({ name: 'view_events', roles: ['PUBLIC'] })]);
      expect(compareInventories(original, policyChanged).differences).toContain('schema');
      await expect(inventoryDatabase(source, 1)).rejects.toThrow('byte budget');
    } finally { await source.close(); await target.close(); }
  }, 30000);
});
