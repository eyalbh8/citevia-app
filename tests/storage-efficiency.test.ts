import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import type { PromptResult, ScanRun } from '@citevia/core';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { cleanupExpiredAuthState, collectStorageAudit, compactEvidenceDuplicates, rehydrateRunManifests, MemoryArtifacts, PostgresRepository, uuidFor, type SqlDatabase } from '@citevia/storage';
import { analysis, captured, instant, project as fixture, snapshot } from '../apps/scanner/test/fixtures.js';

let db: SqlDatabase;
let repository: PostgresRepository;
beforeAll(async () => {
  db = await localPostgres();
  repository = new PostgresRepository(db);
  await repository.saveProject(fixture, null);
}, 30000);
afterAll(async () => { await db?.close(); });

function manifest(id: string, createdAt = instant) {
  const run: ScanRun = { id, projectId: fixture.id, scheduledAt: createdAt, createdAt,
    status: 'queued', trigger: 'manual', snapshot, totalCount: 1, terminalCount: 0,
    succeededCount: 0, capturedCount: 0, resultVersion: 0, deadlineAt: instant, expiresAt: 2000000000 };
  const result: PromptResult = { projectId: fixture.id, runId: id, promptId: fixture.prompts[0].id,
    responseId: `${id}~${fixture.prompts[0].id}`, prompt: fixture.prompts[0], status: 'queued',
    version: 0, attempts: 0, citationCount: 0, sourceCount: 0, expiresAt: run.expiresAt };
  return { run, result };
}

describe('storage efficiency with preserved scan semantics', () => {
  it('keeps JSON current during mixed-version rollout before enabling compact writes', async () => {
    const dualWrite = new PostgresRepository(db, { compactRunState: false });
    const { run, result } = manifest('dual-write-rollout');
    const second: PromptResult = { ...result, promptId: fixture.prompts[1].id,
      prompt: fixture.prompts[1], responseId: `${run.id}~${fixture.prompts[1].id}` };
    run.totalCount = 2;
    await dualWrite.createRun(run, [result, second]);
    const succeeded: PromptResult = { ...result, version: 1, status: 'succeeded', capturedAt: instant };
    expect(await dualWrite.commitResult(succeeded, result)).toBe(true);
    const canonical = (await dualWrite.getRun(fixture.id, run.id))!;
    const jsonRun = (await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data as ScanRun;
    expect(jsonRun).toEqual(canonical);
    // Reproduce the old scanner's locked JSON-only update for a different prompt.
    await db.transaction(async tx => {
      const legacyRun = (await tx.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2 FOR UPDATE', [fixture.id, run.id])).rows[0].data as ScanRun;
      const next = { ...second, status: 'succeeded', version: 1, capturedAt: instant };
      await tx.query('UPDATE citevia_prompt_results SET data=$4::jsonb,version=1 WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3 AND version=0',
        [fixture.id, run.id, second.promptId, JSON.stringify(next)]);
      legacyRun.terminalCount++;
      legacyRun.succeededCount++;
      legacyRun.capturedCount++;
      legacyRun.resultVersion++;
      await tx.query('UPDATE citevia_runs SET data=$3::jsonb,status=$4,result_version=$5,terminal_count=$6 WHERE project_id=$1 AND id=$2',
        [fixture.id, run.id, JSON.stringify(legacyRun), legacyRun.status, legacyRun.resultVersion, legacyRun.terminalCount]);
    });
    expect(await dualWrite.getRun(fixture.id, run.id)).toMatchObject({ succeededCount: 2, terminalCount: 2, capturedCount: 2, resultVersion: 2 });
    expect(await dualWrite.finalizeRun(fixture.id, run.id, 2, 'completed', 'dual-summary', instant)).toBe(true);
    const completed = await dualWrite.getRun(fixture.id, run.id);
    expect((await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data).toEqual(completed);
    // After old invocations drain, switching to compact writes preserves counters
    // and stops rewriting the frozen JSON manifest.
    const compact = new PostgresRepository(db, { compactRunState: true });
    expect(await compact.commitResult({ ...succeeded, status: 'queued', version: 2 }, succeeded)).toBe(true);
    expect(await compact.getRun(fixture.id, run.id)).toMatchObject({ succeededCount: 1, terminalCount: 1, resultVersion: 3 });
    expect((await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data).toEqual(completed);
    vi.stubEnv('CITEVIA_COMPACT_RUN_STATE', 'false');
    try {
      const configured = new PostgresRepository(db);
      await configured.markRunRunning(fixture.id, run.id, instant);
      expect((await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data).toEqual(await configured.getRun(fixture.id, run.id));
    } finally { vi.unstubAllEnvs(); }
  });

  it('backfills typed state and original observation dates for populated pre-optimization databases', async () => {
    const legacy = await localPostgres(undefined, { migrate: false });
    try {
      for (const name of (await readdir('database/migrations')).filter(name => /^00\d_|010_/.test(name)).sort())
        await legacy.exec(await readFile(`database/migrations/${name}`, 'utf8'));
      const { run, result } = manifest('existing-history', '2026-10-22T08:00:00.000Z');
      Object.assign(run, { status: 'completed', succeededCount: 1, capturedCount: 1, terminalCount: 1,
        resultVersion: 9, completedAt: instant, summaryVersion: 9, summaryKey: 'historical-summary' });
      Object.assign(result, { status: 'succeeded', capturedAt: instant, version: 4 });
      const accountId = uuidFor(fixture.id);
      const scanId = uuidFor(`${fixture.id}:scan:${run.id}`);
      await legacy.query('INSERT INTO accounts(id,title,updated_at) VALUES($1,$2,now())', [accountId, fixture.name]);
      await legacy.query('INSERT INTO citevia_projects(id,account_id,version,data) VALUES($1,$2,1,$3::jsonb)', [fixture.id, accountId, JSON.stringify(fixture)]);
      await legacy.query("INSERT INTO scans(id,account_id,scheduled_by,updated_at) VALUES($1,$2,'manual',now())", [scanId, accountId]);
      await legacy.query(`INSERT INTO citevia_runs(project_id,id,scan_id,status,scheduled_at,result_version,terminal_count,total_count,data)
        VALUES($1,$2,$3,'completed',$4,9,1,1,$5::jsonb)`, [fixture.id, run.id, scanId, run.scheduledAt, JSON.stringify(run)]);
      await legacy.query('INSERT INTO citevia_prompt_results(project_id,run_id,prompt_id,version,data) VALUES($1,$2,$3,4,$4::jsonb)',
        [fixture.id, run.id, result.promptId, JSON.stringify(result)]);
      const transition = new PostgresRepository(legacy);
      expect(await transition.getRun(fixture.id, run.id)).toEqual(run);
      expect((await transition.listPromptHistory(fixture.id, instant, instant)).results).toEqual([result]);
      const retried: PromptResult = { ...result, status: 'queued', version: 5 };
      expect(await transition.commitResult(retried, result)).toBe(true);
      await transition.markRunRunning(fixture.id, run.id, instant);
      const succeeded: PromptResult = { ...retried, status: 'succeeded', version: 6 };
      expect(await transition.commitResult(succeeded, retried)).toBe(true);
      expect(await transition.finalizeRun(fixture.id, run.id, 11, 'completed', 'legacy-finalized', instant)).toBe(true);
      const expected = (await transition.getRun(fixture.id, run.id))!;
      await transition.saveMeasurement(succeeded, expected, captured(), analysis(captured()));
      expect((await legacy.query('SELECT id FROM prompt_responses')).rows).toHaveLength(1);
      await legacy.exec(await readFile('database/migrations/011_storage_efficiency.sql', 'utf8'));
      const restored = new PostgresRepository(legacy);
      expect(await restored.getRun(fixture.id, run.id)).toEqual(expected);
      expect((await restored.listPromptHistory(fixture.id, instant, instant)).results).toEqual([succeeded]);
      // The old capability result can be cached when011 commits. The locked row
      // still selects the correct new write path without clobbering typed state.
      expect(await transition.commitResult({ ...succeeded, status: 'queued', version: 7 }, succeeded)).toBe(true);
      expect((await legacy.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data).toEqual(expected);
      expect(await restored.getRun(fixture.id, run.id)).toMatchObject({ status: 'running', terminalCount: 0, resultVersion: 12 });
    } finally { await legacy.close(); }
  });

  it('hydrates checkpoints and completed history while the immutable run manifest stays unchanged', async () => {
    const { run, result } = manifest('typed-state');
    await repository.createRun(run, [result]);
    const next: PromptResult = { ...result, version: 1, status: 'succeeded', capturedAt: instant };
    expect(await repository.commitResult(next, result)).toBe(true);
    expect(await repository.commitResult(next, result)).toBe(false);
    const checkpoint = await repository.getRun(fixture.id, run.id);
    expect(checkpoint).toMatchObject({ status: 'running', terminalCount: 1, succeededCount: 1,
      capturedCount: 1, resultVersion: 1, snapshot });
    expect((await repository.listActiveRuns()).find(item => item.id === run.id)).toEqual(checkpoint);
    expect(await repository.finalizeRun(fixture.id, run.id, 0, 'completed', 'stale', instant)).toBe(false);
    expect(await repository.finalizeRun(fixture.id, run.id, 1, 'completed', 'summary', instant)).toBe(true);
    const completed = await repository.getRun(fixture.id, run.id);
    expect(completed).toMatchObject({ status: 'completed', completedAt: instant, summaryKey: 'summary', summaryVersion: 1 });
    expect((await repository.listRuns(fixture.id)).find(item => item.id === run.id)).toEqual(completed);
    expect((await repository.listPromptHistory(fixture.id, instant, instant)).runs.find(item => item.id === run.id)).toEqual(completed);
    expect((await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, run.id])).rows[0].data).toEqual(run);
    const retried: PromptResult = { ...next, status: 'queued', version: 2 };
    expect(await repository.commitResult(retried, next)).toBe(true);
    expect(await repository.getRun(fixture.id, run.id)).toMatchObject({ status: 'running', terminalCount: 0, succeededCount: 0, resultVersion: 2 });
    expect((await repository.getRun(fixture.id, run.id))?.completedAt).toBeUndefined();
  });

  it('accepts legacy JSON writers and indexes reanalysis by original capture time', async () => {
    const createdAt = '2026-10-22T08:00:00.000Z';
    const { run, result } = manifest('legacy-writer', createdAt);
    await repository.createRun(run, [result]);
    await db.query(`UPDATE citevia_runs SET status='running',result_version=3,terminal_count=1,data=$3::jsonb
      WHERE project_id=$1 AND id=$2`, [fixture.id, run.id,
      JSON.stringify({ ...run, status: 'running', succeededCount: 1, capturedCount: 1,
        resultVersion: 3, terminalCount: 1, startedAt: instant })]);
    expect(await repository.getRun(fixture.id, run.id)).toMatchObject({ resultVersion: 3, succeededCount: 1, capturedCount: 1, startedAt: instant });
    const next: PromptResult = { ...result, status: 'succeeded', capturedAt: instant, version: 1 };
    await db.query('UPDATE citevia_prompt_results SET data=$4::jsonb,version=$5 WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3',
      [fixture.id, run.id, result.promptId, JSON.stringify(next), next.version]);
    const history = await repository.listPromptHistory(fixture.id, instant, instant, result.promptId);
    expect(history.results.find(item => item.runId === run.id)).toEqual(next);
    expect((await repository.listPromptHistory(fixture.id, createdAt, createdAt)).results.some(item => item.runId === run.id)).toBe(false);
    const indexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='citevia_prompt_results'");
    expect(indexes.rows).toEqual(expect.arrayContaining([{ indexname: 'citevia_results_period_idx' }, { indexname: 'citevia_results_prompt_period_idx' }]));
  });

  it('keeps normalized analysis available without duplicating raw receipts and makes native entity writes opt-in', async () => {
    const { run, result } = manifest('compact-evidence');
    const answer = captured();
    const saved = analysis(answer);
    const succeeded: PromptResult = { ...result, version: 1, status: 'succeeded', capturedAt: instant,
      captureKey: 'capture-original', analysisKey: 'analysis-original', target: saved.brands[0], brands: saved.brands };
    await repository.createRun(run, [succeeded]);
    await repository.saveMeasurement(succeeded, run, answer, saved);
    const native = (await db.query('SELECT json_response FROM prompt_responses WHERE id=$1',
      [uuidFor(`${fixture.id}:response:${succeeded.responseId}`)])).rows[0].json_response as Record<string, unknown>;
    expect(native).toMatchObject({ evidenceStorage: 'artifacts', measurement: { captureKey: succeeded.captureKey, analysisKey: succeeded.analysisKey } });
    expect(native).not.toHaveProperty('nativeResponse');
    expect(native).not.toHaveProperty('blocks');
    expect(native.analysis).not.toHaveProperty('raw');
    expect((await repository.listSavedAnalyses(fixture.id, [{ responseId: succeeded.responseId, captureKey: succeeded.captureKey!, analysisKey: succeeded.analysisKey }]))[0].analysis?.brands).toEqual(saved.brands);
    expect((await db.query('SELECT id FROM results WHERE scan_id=$1', [uuidFor(`${fixture.id}:scan:${run.id}`)])).rows).toEqual([]);
    const writes: string[] = [];
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(work => originalTransaction(tx => work({ ...tx,
      query: async (sql, params) => { writes.push(sql); return tx.query(sql, params); },
    })));
    await repository.saveMeasurement(succeeded, run, answer, saved);
    expect(writes.some(sql => /INSERT INTO prompt_responses|DELETE FROM citevia_response_citations/.test(sql))).toBe(false);
    vi.restoreAllMocks();
    const legacy = new PostgresRepository(db, { writeCompatibilityResults: true });
    await legacy.saveMeasurement(succeeded, run, answer, saved);
    expect((await db.query('SELECT id FROM results WHERE scan_id=$1', [uuidFor(`${fixture.id}:scan:${run.id}`)])).rows.length).toBeGreaterThan(0);
    expect(saved.raw).toEqual({ fixture: true });
    expect(answer.raw).toEqual({ fixture: true });
  });
});

describe('bounded storage maintenance', () => {
  it('rehydrates JSON for controlled rollback without changing canonical state or immutable snapshots', async () => {
    const before = await repository.getRun(fixture.id, 'typed-state');
    const preview = await rehydrateRunManifests(db);
    expect(preview.dryRun).toBe(true);
    expect(preview.needsRehydration).toBeGreaterThan(0);
    const applied = await rehydrateRunManifests(db, { dryRun: false });
    expect(applied.updated).toBe(applied.needsRehydration);
    const persisted = (await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [fixture.id, 'typed-state'])).rows[0].data;
    expect(persisted).toEqual(before);
    expect(await repository.getRun(fixture.id, 'typed-state')).toEqual(before);
    expect((await rehydrateRunManifests(db)).needsRehydration).toBe(0);
    const page = await rehydrateRunManifests(db, { limit: 1 });
    expect(page.scanned).toBe(1);
    expect((await rehydrateRunManifests(db, { after: page.nextCursor!, limit: 1 })).scanned).toBe(1);
    await expect(rehydrateRunManifests(db, { after: 'bad' })).rejects.toThrow('cursor');
  });

  it('opens a database for read-only maintenance without creating schema', async () => {
    const empty = await localPostgres(undefined, { migrate: false });
    try {
      expect((await collectStorageAudit(empty)).tables).toEqual([]);
    } finally { await empty.close(); }
  });

  it('compacts only exact duplicates with readable original capture and analysis artifacts', async () => {
    const artifacts = new MemoryArtifacts();
    const ids: Record<string, string> = {};
    for (const kind of ['verified', 'missing', 'mismatch']) {
      const { run, result } = manifest(`legacy-raw-${kind}`);
      const answer = captured();
      const saved = analysis(answer);
      const succeeded: PromptResult = { ...result, status: 'succeeded', captureKey: `legacy/${kind}/capture`,
        analysisKey: `legacy/${kind}/analysis`, capturedAt: instant, target: saved.brands[0], brands: saved.brands };
      await repository.createRun(run, [succeeded]);
      await repository.saveMeasurement(succeeded, run, answer, saved);
      const id = uuidFor(`${fixture.id}:response:${succeeded.responseId}`);
      ids[kind] = id;
      await db.query(`UPDATE prompt_responses SET json_response=jsonb_set(json_response || jsonb_build_object('nativeResponse',$2::jsonb),
        '{analysis,raw}',$3::jsonb) WHERE id=$1`, [id, JSON.stringify(answer.raw), JSON.stringify(saved.raw)]);
      if (kind !== 'missing') {
        await artifacts.put(succeeded.captureKey!, kind === 'mismatch' ? { ...answer, text: 'Another answer' } : answer);
        await artifacts.put(succeeded.analysisKey!, saved);
      }
    }
    const preview = await compactEvidenceDuplicates(db, artifacts);
    expect(preview).toMatchObject({ dryRun: true, scanned: 3, verified: 1, compacted: 0,
      skipped: { artifact_missing: 1, artifact_mismatch: 1 } });
    expect((await db.query('SELECT json_response FROM prompt_responses WHERE id=$1', [ids.verified])).rows[0].json_response).toHaveProperty('nativeResponse');
    const applied = await compactEvidenceDuplicates(db, artifacts, { dryRun: false });
    expect(applied).toMatchObject({ dryRun: false, verified: 1, compacted: 1 });
    const saved = (await db.query('SELECT json_response FROM prompt_responses WHERE id=$1', [ids.verified])).rows[0].json_response as any;
    expect(saved).not.toHaveProperty('nativeResponse');
    expect(saved.analysis).not.toHaveProperty('raw');
    expect(saved.analysis.brands).toEqual(analysis(captured()).brands);
    expect((await artifacts.get<any>('legacy/verified/capture')).raw).toEqual({ fixture: true });
    expect((await artifacts.get<any>('legacy/verified/analysis')).raw).toEqual({ fixture: true });
    expect((await db.query('SELECT json_response FROM prompt_responses WHERE id=$1', [ids.missing])).rows[0].json_response).toHaveProperty('nativeResponse');
    await expect(compactEvidenceDuplicates(db, artifacts, { limit: 501 })).rejects.toThrow('Compaction limit');
    await expect(compactEvidenceDuplicates(db, artifacts, { afterId: 'not-a-cursor' })).rejects.toThrow('cursor');
  });

  it('previews expired auth cleanup, respects bounds, and preserves active and non-expiring state', async () => {
    await db.query(`INSERT INTO citevia_mcp_records(kind,id,data,expires_at) VALUES
      ('access','expired-a','{}','2026-01-01'),('refresh','expired-b','{}','2026-01-02'),
      ('access','active','{}','2027-01-01'),('client','permanent','{}',NULL)`);
    await db.query(`INSERT INTO citevia_mcp_request_limits(bucket,window_start,request_count) VALUES
      ('stale','2026-01-01',1),('current','2026-10-22',1)`);
    const now = new Date('2026-10-22T12:00:00Z');
    expect(await cleanupExpiredAuthState(db, { now, limit: 1 })).toMatchObject({ dryRun: true, expiredRecords: 1, staleRateLimitBuckets: 1 });
    expect((await db.query('SELECT id FROM citevia_mcp_records')).rows).toHaveLength(4);
    expect(await cleanupExpiredAuthState(db, { now, limit: 1, dryRun: false })).toMatchObject({ expiredRecords: 1, staleRateLimitBuckets: 1 });
    expect((await db.query('SELECT id FROM citevia_mcp_records ORDER BY id')).rows).toEqual([{ id: 'active' }, { id: 'expired-b' }, { id: 'permanent' }]);
    expect((await db.query('SELECT bucket FROM citevia_mcp_request_limits')).rows).toEqual([{ bucket: 'current' }]);
    await expect(cleanupExpiredAuthState(db, { limit: 5000 })).rejects.toThrow('Cleanup limit');
    const audit = await collectStorageAudit(db);
    expect(audit.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'citevia_runs' })]));
    expect(audit.foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ child_table: 'citevia_runs', parent_table: 'citevia_projects' })]));
  });
});
