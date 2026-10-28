import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const cloud = vi.hoisted(() => ({
  runtime: vi.fn(), database: vi.fn(), repository: vi.fn(),
  query: vi.fn(), provider: vi.fn(), response: vi.fn(),
}));
vi.mock('@citevia/storage', async (load) => ({
  ...await load<typeof import('@citevia/storage')>(),
  createAwsRuntime: cloud.runtime,
  productionDatabase: cloud.database,
  PostgresRepository: cloud.repository,
}));
vi.mock('../apps/scanner/src/providers.js', async (load) => ({
  ...await load<typeof import('../apps/scanner/src/providers.js')>(),
  createScanProviderFromEnv: cloud.provider,
}));
vi.mock('../apps/scanner/src/openai.js', async (load) => ({
  ...await load<typeof import('../apps/scanner/src/openai.js')>(),
  createResponseProviderFromEnv: cloud.response,
}));

import { DEFAULT_ANALYSIS_MODEL } from '@citevia/core';
import { MemoryRepository } from '@citevia/storage';
import { createHandler, handler, parseScanMessage } from '../apps/scanner/src/handler.js';
import type { Scanner } from '../apps/scanner/src/engine.js';
import { newProject } from './fixtures/scanner.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CITEVIA_MAINTENANCE_MODE', 'false');
  cloud.database.mockReturnValue({ query: cloud.query });
});
afterEach(() => vi.unstubAllEnvs());

async function configuration() {
  const repository = new MemoryRepository();
  const projects = [
    { ...newProject({ id: 'old-model' }), extractionModel: 'gpt-4.1-mini-2025-04-14' },
    { ...newProject({ id: 'luna-model' }), extractionModel: 'gpt-6-luna' },
    { ...newProject({ id: 'gemini-model' }), extractionModel: 'gemini-custom' },
  ];
  for (const project of projects) await repository.saveProject(project, null);
  cloud.repository.mockImplementation(function () { return repository; });
  cloud.query.mockResolvedValue({ rows: projects.map(({ id }) => ({ id })) });
  return { repository, projects };
}

function expectNoPaidRuntime() {
  expect(cloud.runtime).not.toHaveBeenCalled();
  expect(cloud.provider).not.toHaveBeenCalled();
  expect(cloud.response).not.toHaveBeenCalled();
}

describe('IAM-only analysis configuration maintenance', () => {
  it('defaults to a read-only Gemini preview with no provider or scan initialization', async () => {
    const { repository, projects } = await configuration();
    const save = vi.spyOn(repository, 'saveProject');
    const createRun = vi.spyOn(repository, 'createRun');
    const report = await handler({ kind: 'analysis:configure' });
    expect(report).toMatchObject({ mode: 'preview', model: DEFAULT_ANALYSIS_MODEL, updated: 0, conflicts: 0, changes: [
      { projectId: 'old-model', status: 'planned', to: DEFAULT_ANALYSIS_MODEL },
      { projectId: 'luna-model', status: 'planned', to: DEFAULT_ANALYSIS_MODEL },
    ] });
    expect(cloud.query).toHaveBeenCalledOnce();
    expect(cloud.query.mock.calls[0][0]).toMatch(/extractionModel.*!~ '\^gemini-'/);
    expect(save).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    for (const project of projects) expect(await repository.getProject(project.id)).toEqual(project);
    expectNoPaidRuntime();
  });

  it('applies future non-Gemini analysis settings with compare-and-swap and preserves collection models', async () => {
    const { repository, projects } = await configuration();
    const save = vi.spyOn(repository, 'saveProject');
    const createRun = vi.spyOn(repository, 'createRun');
    const report = await handler({ kind: 'analysis:configure', apply: true });
    expect(report).toMatchObject({ mode: 'apply', updated: 2, conflicts: 0 });
    expect(save).toHaveBeenCalledTimes(2);
    for (const project of projects.slice(0, 2)) {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: project.id, extractionModel: DEFAULT_ANALYSIS_MODEL, version: project.version + 1 }), project.version);
      expect(await repository.getProject(project.id)).toMatchObject({ extractionModel: DEFAULT_ANALYSIS_MODEL, generationModel: project.generationModel, scanProviders: project.scanProviders });
    }
    expect(await repository.getProject(projects[2].id)).toEqual(projects[2]);
    expect(createRun).not.toHaveBeenCalled();
    expectNoPaidRuntime();
  });

  it('allows explicit project/model scope without querying or changing other account settings', async () => {
    const { repository, projects } = await configuration();
    const report = await handler({ kind: 'analysis:configure', projectId: 'gemini-model', model: DEFAULT_ANALYSIS_MODEL, apply: true });
    expect(report).toMatchObject({ scope: 'gemini-model', updated: 1, changes: [{ projectId: 'gemini-model', from: 'gemini-custom', to: DEFAULT_ANALYSIS_MODEL, status: 'updated' }] });
    expect(cloud.query).not.toHaveBeenCalled();
    for (const project of projects.slice(0, 2)) expect(await repository.getProject(project.id)).toEqual(project);
    expectNoPaidRuntime();
  });

  it.each([
    { model: 'gpt-6-luna' },
    { model: 'gemini-invalid/model' },
    { model: '' },
    { apply: 'true' },
    { apply: 1 },
    { projectId: 'invalid/account' },
    { extra: 'unknown-field' },
  ])('rejects invalid or unknown options before accessing the database: %j', async (options) => {
    await expect(handler({ kind: 'analysis:configure', ...options } as Parameters<typeof handler>[0])).rejects.toMatchObject({ name: 'ZodError' });
    expect(cloud.database).not.toHaveBeenCalled();
    expect(cloud.repository).not.toHaveBeenCalled();
    expect(cloud.query).not.toHaveBeenCalled();
    expectNoPaidRuntime();
  });

  it('rejects configuration maintenance delivered through SQS', async () => {
    const payload = { kind: 'analysis:configure', apply: true };
    expect(() => parseScanMessage(payload)).toThrow();
    const handle = vi.fn();
    const handleDeadLetter = vi.fn();
    const queueHandler = createHandler({ handle, handleDeadLetter } as unknown as Scanner);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await queueHandler({ Records: [{ messageId: 'configure-via-queue', body: JSON.stringify(payload), eventSourceARN: 'source-arn' }] } as SQSEvent)).toEqual({ batchItemFailures: [{ itemIdentifier: 'configure-via-queue' }] });
    } finally { log.mockRestore(); }
    expect(handle).not.toHaveBeenCalled();
    expect(handleDeadLetter).not.toHaveBeenCalled();
    expect(cloud.database).not.toHaveBeenCalled();
  });

  it('blocks direct configuration during the maintenance freeze before database or provider access', async () => {
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE', 'true');
    expect(await handler({ kind: 'analysis:configure', apply: true })).toEqual({ maintenance: true });
    expect(cloud.database).not.toHaveBeenCalled();
    expect(cloud.repository).not.toHaveBeenCalled();
    expectNoPaidRuntime();
  });
});
