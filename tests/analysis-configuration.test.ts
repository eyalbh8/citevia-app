import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository, PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { newProject } from './fixtures/scanner.js';
import { configureAnalysis, openConfigurationDatabase, runConfigureAnalysisCli } from '../scripts/configure-analysis.js';

describe('future analysis model configuration', () => {
  it('previews retiring accounts without writes and excludes custom choices without an explicit project', async () => {
    const repository = new MemoryRepository();
    const old = { ...newProject({ id: 'retiring' }), extractionModel: 'gpt-4.1-mini-2025-04-14' };
    const custom = { ...newProject({ id: 'custom' }), extractionModel: 'custom-model' };
    await repository.saveProject(old, null);
    await repository.saveProject(custom, null);
    const save = vi.spyOn(repository, 'saveProject');
    const report = await configureAnalysis(repository, ['retiring', 'custom']);
    expect(save).not.toHaveBeenCalled();
    expect(report).toMatchObject({ mode: 'preview', updated: 0, changes: [{ projectId: 'retiring', from: old.extractionModel, to: 'gpt-6-luna', status: 'planned' }] });
    expect(report.changes).toHaveLength(1);
    expect(await repository.getProject(old.id)).toEqual(old);
    expect(await repository.getProject(custom.id)).toEqual(custom);
  });
  it('applies the selected analysis model with CAS while retaining collection, content and saved run settings', async () => {
    const repository = new MemoryRepository();
    const old = { ...newProject({ id: 'retiring' }), extractionModel: 'gpt-4.1-mini' };
    await repository.saveProject(old, null);
    const save = vi.spyOn(repository, 'saveProject');
    const runWrite = vi.spyOn(repository, 'createRun');
    const report = await configureAnalysis(repository, [old.id], { apply: true }, new Date('2026-10-22T12:00:00Z'));
    expect(report.updated).toBe(1);
    expect(save).toHaveBeenCalledWith({ ...old, extractionModel: 'gpt-6-luna', version: old.version + 1, updatedAt: '2026-10-22T12:00:00.000Z' }, old.version);
    const current = await repository.getProject(old.id);
    expect(current?.generationModel).toBe(old.generationModel);
    expect(current?.scanProviders).toEqual(old.scanProviders);
    expect(runWrite).not.toHaveBeenCalled();
  });
  it('requires explicit project scope to change a custom model and reports concurrent-edit conflicts without retry', async () => {
    const repository = new MemoryRepository();
    const custom = { ...newProject({ id: 'custom' }), extractionModel: 'custom-model' };
    await repository.saveProject(custom, null);
    const save = vi.spyOn(repository, 'saveProject').mockResolvedValue(false);
    const report = await configureAnalysis(repository, [custom.id], { project: custom.id, apply: true });
    expect(report).toMatchObject({ conflicts: 1, updated: 0, changes: [{ projectId: custom.id, status: 'conflict' }] });
    expect(save).toHaveBeenCalledOnce();
    expect(await repository.getProject(custom.id)).toEqual(custom);
  });
  it('does not create a missing local database even for a preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'citevia-configure-analysis-'));
    try {
      await expect(openConfigurationDatabase('local', directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('runs a read-only SQL preview and closes the connection without modifying project rows', async () => {
    const db = await localPostgres();
    const repository = new PostgresRepository(db);
    const project = { ...newProject({ id: 'postgres-retiring' }), extractionModel: 'gpt-4.1-mini-2025-04-14' };
    await repository.saveProject(project, null);
    const transaction = vi.spyOn(db, 'transaction');
    const before = (await db.query('SELECT data FROM citevia_projects WHERE id=$1', [project.id])).rows;
    const close = vi.spyOn(db, 'close').mockResolvedValue();
    try {
      const report = JSON.parse(await runConfigureAnalysisCli(['--mode', 'local'], async () => db));
      expect(report).toMatchObject({ mode: 'preview', changes: [{ projectId: project.id, status: 'planned' }] });
      expect(transaction).not.toHaveBeenCalled();
      expect((await db.query('SELECT data FROM citevia_projects WHERE id=$1', [project.id])).rows).toEqual(before);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      await db.close();
    }
  });
});
