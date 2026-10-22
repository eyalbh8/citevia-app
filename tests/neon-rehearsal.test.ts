import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PromptResult, ScanRun } from '@citevia/core';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { migrateDatabase, type SqlDatabase } from '../packages/storage/src/sql.js';
import { PostgresRepository } from '../packages/storage/src/postgres.js';
import { compareInventories, inventoryDatabase } from '../scripts/lib/postgres-migration.js';
import { assertTypedBackfills, compareLocaleChecks, localeChecks, originalTableFingerprints,
  repositoryReadSmoke, repositoryWriteCanary } from '../scripts/lib/neon-rehearsal.js';
import { instant, project, snapshot } from '../apps/scanner/test/fixtures.js';

describe('isolated Neon rehearsal verification', () => {
  it('preserves all original columns through additive migrations and rolls back both repository write paths', async () => {
    const db = await localPostgres(undefined, { migrate: false });
    try {
      await db.exec('CREATE TABLE citevia_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of (await readdir('database/migrations')).filter(name => /^00\d_|010_/.test(name)).sort()) {
        const source = await readFile(`database/migrations/${name}`, 'utf8');
        await db.exec(source);
        await db.query('INSERT INTO citevia_migrations(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(source).digest('hex')]);
      }
      const repo = new PostgresRepository(db);
      await repo.saveProject(project, null);
      const run: ScanRun = { id: 'run_0123456789abcdef01234567', projectId: project.id, scheduledAt: instant, createdAt: instant,
        status: 'completed', trigger: 'manual', snapshot, totalCount: 1, terminalCount: 1, succeededCount: 1,
        capturedCount: 1, resultVersion: 4, deadlineAt: instant, expiresAt: 2000000000, completedAt: instant };
      const result: PromptResult = { projectId: project.id, runId: run.id, promptId: project.prompts[0].id,
        responseId: `${run.id}~${project.prompts[0].id}`, prompt: project.prompts[0], status: 'succeeded',
        version: 1, attempts: 1, capturedAt: instant, citationCount: 0, sourceCount: 0, expiresAt: run.expiresAt };
      await repo.createRun(run, [result]);
      await db.query("INSERT INTO users(id,email,name,updated_at) VALUES('11111111-1111-1111-1111-111111111111','private@example.test','Private Name',now())");
      const original = await inventoryDatabase(db);
      const sourceLocale = await localeChecks(db);
      expect(JSON.stringify(sourceLocale)).not.toContain('private@example.test');
      expect(sourceLocale.email).toMatchObject({ users: 1, lower_collisions: 0 });
      await migrateDatabase(db);
      expect(await originalTableFingerprints(db, original)).toEqual(original.tables);
      expect(await assertTypedBackfills(db)).toEqual({ runMismatches: 0, observationMismatches: 0 });
      expect(compareLocaleChecks(sourceLocale, await localeChecks(db))).toMatchObject({ compatibleExistingData: true, stableByteOrdering: true });
      expect(await repositoryReadSmoke(db)).toMatchObject({ projects: 1, runs: 1, results: 1, answerPages: 1 });
      const beforeCanary = await inventoryDatabase(db);
      const rollback = new Error('rollback rehearsal');
      await expect(db.transaction(async tx => {
        const saved: SqlDatabase = { ...tx, close: async () => {}, transaction: async work => {
          await tx.query('SAVEPOINT canary');
          try { const value = await work(tx); await tx.query('RELEASE SAVEPOINT canary'); return value; }
          catch (error) { await tx.query('ROLLBACK TO SAVEPOINT canary'); throw error; }
        } };
        expect(await repositoryWriteCanary(saved)).toEqual({ skipped: false, writes: 2 });
        throw rollback;
      })).rejects.toBe(rollback);
      expect(compareInventories(beforeCanary, await inventoryDatabase(db)).equal).toBe(true);
      await db.query("UPDATE citevia_runs SET succeeded_count=99 WHERE project_id=$1", [project.id]);
      await expect(assertTypedBackfills(db)).rejects.toThrow('backfill');
      // Original-column fingerprinting still detects evidence changes at the same row count.
      await db.query("UPDATE users SET name='Changed' WHERE email='private@example.test'");
      expect(await originalTableFingerprints(db, original)).not.toEqual(original.tables);
    } finally { await db.close(); }
  }, 30000);
  it('separates existing-data compatibility from deliberate default order changes', () => {
    const source = { environment: {}, email: { lower_collisions: 0 }, fields: [], probes: [],
      ordering: { default_order: ['a','A'], byte_order: ['A','a'] }, traffic: {} };
    const target = structuredClone(source); target.ordering.default_order.reverse();
    expect(compareLocaleChecks(source, target)).toMatchObject({ compatibleExistingData: true, defaultOrderingChanged: true, stableByteOrdering: true });
    target.email.lower_collisions = 1;
    expect(compareLocaleChecks(source, target)).toMatchObject({ compatibleExistingData: false, criticalDifferences: ['email'] });
  });
});
