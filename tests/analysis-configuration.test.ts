import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANALYSIS_MODEL } from '@citevia/core';
import { MemoryRepository, MemoryArtifacts, MemoryQueue, PostgresRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { testIdentity } from './fixtures/users.js';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { newProject } from './fixtures/scanner.js';
import { configureAnalysis, openConfigurationDatabase, runConfigureAnalysisCli } from '../scripts/configure-analysis.js';

describe('future analysis model configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('previews every non-Gemini account without writes and preserves existing Gemini choices', async () => {
    const repository = new MemoryRepository();
    const old = { ...newProject({ id: 'retiring' }), extractionModel: 'gpt-4.1-mini-2025-04-14' };
    const luna = { ...newProject({ id: 'luna' }), extractionModel: 'gpt-6-luna' };
    const custom = { ...newProject({ id: 'custom' }), extractionModel: 'custom-model' };
    const gemini = { ...newProject({ id: 'gemini' }), extractionModel: 'gemini-custom' };
    for (const project of [old, luna, custom, gemini]) await repository.saveProject(project, null);
    const save = vi.spyOn(repository, 'saveProject');
    const report = await configureAnalysis(repository, ['retiring', 'luna', 'custom', 'gemini', 'luna']);
    expect(save).not.toHaveBeenCalled();
    expect(report).toMatchObject({ mode: 'preview', updated: 0, model: DEFAULT_ANALYSIS_MODEL });
    expect(report.changes).toEqual([old, luna, custom].map((project) => ({ projectId: project.id, from: project.extractionModel, to: DEFAULT_ANALYSIS_MODEL, status: 'planned', expectedVersion: project.version, nextVersion: project.version + 1 })));
    for (const project of [old, luna, custom, gemini]) expect(await repository.getProject(project.id)).toEqual(project);
  });
  it('applies the selected analysis model with CAS while retaining collection, content and saved run settings', async () => {
    const repository = new MemoryRepository();
    const old = { ...newProject({ id: 'retiring' }), extractionModel: 'gpt-4.1-mini' };
    await repository.saveProject(old, null);
    const save = vi.spyOn(repository, 'saveProject');
    const runWrite = vi.spyOn(repository, 'createRun');
    const report = await configureAnalysis(repository, [old.id], { apply: true }, new Date('2026-10-22T12:00:00Z'));
    expect(report.updated).toBe(1);
    expect(save).toHaveBeenCalledWith({ ...old, extractionModel: DEFAULT_ANALYSIS_MODEL, version: old.version + 1, updatedAt: '2026-10-22T12:00:00.000Z' }, old.version);
    const current = await repository.getProject(old.id);
    expect(current?.generationModel).toBe(old.generationModel);
    expect(current?.scanProviders).toEqual(old.scanProviders);
    expect(runWrite).not.toHaveBeenCalled();
  });
  it('reports concurrent-edit conflicts without retry', async () => {
    const repository = new MemoryRepository();
    const custom = { ...newProject({ id: 'custom' }), extractionModel: 'custom-model' };
    await repository.saveProject(custom, null);
    const save = vi.spyOn(repository, 'saveProject').mockResolvedValue(false);
    const report = await configureAnalysis(repository, [custom.id], { project: custom.id, apply: true });
    expect(report).toMatchObject({ conflicts: 1, updated: 0, changes: [{ projectId: custom.id, status: 'conflict' }] });
    expect(save).toHaveBeenCalledOnce();
    expect(await repository.getProject(custom.id)).toEqual(custom);
  });
  it('requires explicit project scope to change an existing Gemini model', async () => {
    const repository = new MemoryRepository();
    const project = { ...newProject({ id: 'gemini' }), extractionModel: 'gemini-custom' };
    await repository.saveProject(project, null);
    const report = await configureAnalysis(repository, [project.id], { project: project.id, apply: true });
    expect(report).toMatchObject({ updated: 1, changes: [{ projectId: project.id, from: 'gemini-custom', to: DEFAULT_ANALYSIS_MODEL, status: 'updated' }] });
    const save = vi.spyOn(repository, 'saveProject');
    expect(await configureAnalysis(repository, [project.id], { project: project.id, apply: true })).toMatchObject({ updated: 0, changes: [{ status: 'unchanged' }] });
    expect(save).not.toHaveBeenCalled();
  });
  it.each([
    { analysis: '', legacy: '', expected: DEFAULT_ANALYSIS_MODEL },
    { analysis: '', legacy: 'gpt-6-luna', expected: 'gpt-6-luna' },
    { analysis: 'gemini-custom', legacy: 'gpt-6-luna', expected: 'gemini-custom' },
  ])('uses provider-neutral onboarding defaults with explicit legacy compatibility ($expected)', async ({ analysis, legacy, expected }) => {
    vi.stubEnv('ANALYSIS_MODEL', analysis);
    vi.stubEnv('OPENAI_EXTRACTION_MODEL', legacy);
    vi.stubEnv('OPENAI_GENERATION_MODEL', 'saved-collection-model');
    const repository = new MemoryRepository();
    const owner = await repository.syncUser(testIdentity('owner'));
    const runtime = { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
    const { items } = await createAccounts(runtime, owner.subject, 'analysis-defaults', { accounts: [{ name: 'Acme', website: 'https://acme.com', region: 'US', language: 'en' }] }, new Date('2026-10-28T12:00:00Z'), 100);
    expect(items[0].project.extractionModel).toBe(expected);
    expect(items[0].project.generationModel).toBe('saved-collection-model');
    expect(items[0].project.scanProviders?.map(({ provider }) => provider)).toEqual(['openai', 'perplexity', 'gemini']);
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
    const projects = [
      { ...newProject({ id: 'postgres-retiring' }), extractionModel: 'gpt-4.1-mini-2025-04-14' },
      { ...newProject({ id: 'postgres-luna' }), extractionModel: 'gpt-6-luna' },
      { ...newProject({ id: 'postgres-gemini' }), extractionModel: DEFAULT_ANALYSIS_MODEL },
    ];
    for (const project of projects) await repository.saveProject(project, null);
    const transaction = vi.spyOn(db, 'transaction');
    const before = (await db.query('SELECT data FROM citevia_projects ORDER BY id')).rows;
    const close = vi.spyOn(db, 'close').mockResolvedValue();
    try {
      const report = JSON.parse(await runConfigureAnalysisCli(['--mode', 'local'], async () => db));
      expect(report).toMatchObject({ mode: 'preview', changes: [{ projectId: 'postgres-luna', status: 'planned' }, { projectId: 'postgres-retiring', status: 'planned' }] });
      expect(report.changes).toHaveLength(2);
      expect(transaction).not.toHaveBeenCalled();
      expect((await db.query('SELECT data FROM citevia_projects ORDER BY id')).rows).toEqual(before);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      await db.close();
    }
  });
});
