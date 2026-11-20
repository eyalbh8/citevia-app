import { describe, expect, it, vi } from 'vitest';
import type { AccountOnboardingInput } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi, type ApiOptions } from '../apps/api/src/app.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { FixtureProvider } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const prospect: AccountOnboardingInput = {
  name: 'Acme', website: 'https://acme.com', region: 'US', language: 'en', accountType: 'prospect',
};

async function setup(options: Partial<ApiOptions> = {}) {
  const runtime = { repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
  const admin = await runtime.repository.syncUser(testIdentity('admin'));
  await runtime.repository.bootstrapAdmin(admin.id);
  const schedule = vi.fn(async () => {});
  const generation = new FixtureOnboardingProvider();
  const answers = new FixtureProvider();
  const scanner = new Scanner({
    ...runtime, provider: answers, onboarding: new OnboardingEngine(runtime, generation, schedule),
  });
  const api = createApi(runtime, { mode: 'live', syncSchedule: schedule, ...options });
  const call = (path: string, method = 'GET', body?: unknown, key = 'preview-request', user = 'admin') =>
    api(new Request(`https://test/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), testIdentity(user));
  const create = (accounts = [prospect]) => call('/onboarding/accounts', 'POST', { accounts });
  async function createPreview() {
    const accepted = await create();
    expect(accepted.status).toBe(202);
    const { items: [item] } = await accepted.json();
    return { projectId: item.project.id as string, jobId: item.job.id as string };
  }
  async function drain() {
    let deliveries = 0;
    while (runtime.queue.messages.length) {
      if (++deliveries > 100) throw new Error('Unexpected recurring work in prospect preview');
      await scanner.handle(runtime.queue.messages.shift()!);
    }
  }
  return { ...runtime, schedule, generation, answers, call, create, createPreview, drain, scanner };
}

describe('prospect account preview', () => {
  it('preflights the entire bulk submission before persisting any account', async () => {
    const f = await setup({ providerAvailability: { openai: true, gemini: true, perplexity: false } });
    expect(await (await f.call('/runtime')).json()).toMatchObject({ onboardingReady: { prospect: true, standard: false } });
    const mixed = await f.create([prospect, { ...prospect, name: 'Second brand', accountType: 'standard' }]);
    expect(mixed.status).toBe(503);
    expect(await mixed.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_CONFIGURED' } });
    expect(await f.repository.listProjects('admin')).toHaveLength(0);
    expect(f.queue.messages).toHaveLength(0);
    await f.createPreview();
  });

  it('runs ten ChatGPT searches once and exposes the completed preview to account members', async () => {
    const f = await setup();
    const generate = vi.spyOn(f.generation, 'prompts');
    const collect = vi.spyOn(f.answers, 'collect');
    const { projectId, jobId } = await f.createPreview();
    const base = `/projects/${projectId}`;
    expect(await f.createPreview()).toEqual({ projectId, jobId });
    const differentType = await f.create([{ ...prospect, accountType: 'standard' }]);
    expect(differentType.status).toBe(409);
    expect(await differentType.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    await f.drain();
    expect(generate).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledTimes(10);
    const job = await f.repository.getOnboarding(projectId, jobId);
    expect(job).toMatchObject({ status: 'completed', input: { accountType: 'prospect' } });
    const runs = await f.repository.listRuns(projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: job!.firstRunId, status: 'completed', totalCount: 10, succeededCount: 10,
      snapshot: { provider: 'openai', scanProviders: [{ provider: 'openai' }] },
    });
    const results = await f.repository.listResults(projectId, runs[0].id);
    expect(new Set(results.map(row => row.promptId)).size).toBe(10);
    expect(results.every(row => row.status === 'succeeded')).toBe(true);
    const previewScan = { id: runs[0].id, status: 'completed', totalCount: 10, terminalCount: 10, succeededCount: 10 };
    expect(await (await f.call('/projects')).json()).toMatchObject({ items: [{
      id: projectId, accountType: 'prospect', activePromptCount: 10, previewScan,
    }] });
    const settings = await (await f.call(`${base}/settings`)).json();
    expect(settings).toMatchObject({ accountType: 'prospect', nextScanAt: null, previewScan });
    expect(settings.scanSchedule).toBeUndefined();
    expect((await f.call(`${base}/settings`, 'GET', undefined, undefined, 'outsider')).status).toBe(404);
    for (const patch of [{ scanRunsPerWeek: 2 }, { enabled: false }, { scanProviders: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] }]) {
      const invalid = await f.call(`${base}/settings`, 'PATCH', { version: settings.version, ...patch });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'PREVIEW_SETTINGS' } });
    }
    const extra = await f.call(`${base}/runs`, 'POST');
    expect(extra.status).toBe(409);
    expect(await extra.json()).toMatchObject({ error: { code: 'PREVIEW_SCAN_LIMIT' } });
    await f.scanner.handle({ kind: 'kickoff', trigger: 'manual', projectId, scheduledAt: job!.createdAt, requestId: 'another-scan' });
    await f.scanner.handle({ kind: 'kickoff', trigger: 'scheduled', projectId, scheduledAt: job!.createdAt });
    await f.createPreview();
    await f.drain();
    expect(f.schedule).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledTimes(10);
    expect(await f.repository.listRuns(projectId)).toHaveLength(1);
  });

  it('enforces ten active prompts when creating or restoring and retains the original scan snapshot', async () => {
    const f = await setup();
    const { projectId } = await f.createPreview();
    while (f.queue.messages[0]?.kind === 'onboard') await f.scanner.handle(f.queue.messages.shift()!);
    expect(f.queue.messages[0]?.kind).toBe('kickoff');
    const path = `/projects/${projectId}/prompts`;
    const { items } = await (await f.call(path)).json();
    const original = items[0];
    const prematureArchive = await f.call(`${path}/${original.id}`, 'DELETE');
    expect(prematureArchive.status).toBe(409);
    expect(await prematureArchive.json()).toMatchObject({ error: { code: 'ONBOARDING_PENDING' } });
    await f.drain();
    const replacement = { text: 'Which suppliers provide same-day repair services?' };
    const extra = await f.call(path, 'POST', replacement);
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ error: { code: 'PROMPT_LIMIT' } });
    expect((await f.call(`${path}/${original.id}`, 'DELETE')).status).toBe(200);
    expect((await f.call(path, 'POST', replacement)).status).toBe(201);
    const restore = await f.call(`${path}/${original.id}`, 'PATCH', { active: true });
    expect(restore.status).toBe(400);
    expect(await restore.json()).toMatchObject({ error: { code: 'PROMPT_LIMIT' } });
    const [run] = await f.repository.listRuns(projectId);
    expect(run.snapshot.prompts).toHaveLength(10);
    expect(run.snapshot.prompts[0]).toMatchObject({ id: original.id, text: original.text });
  });

  it('resumes failed setup with the prospect policy and reuses completed research', async () => {
    const f = await setup();
    const research = vi.spyOn(f.generation, 'research');
    const generate = vi.spyOn(f.generation, 'prompts')
      .mockRejectedValueOnce(new ProviderError('fixture_unavailable', 'Temporarily unavailable', true));
    const { projectId, jobId } = await f.createPreview();
    await f.drain();
    expect(await f.repository.getOnboarding(projectId, jobId)).toMatchObject({ status: 'failed', step: 'prompts' });
    const retry = `/projects/${projectId}/onboarding/retry`;
    expect((await f.call(retry, 'POST')).status).toBe(202);
    expect((await f.call(retry, 'POST')).status).toBe(202);
    await f.drain();
    expect(research).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await f.repository.listRuns(projectId)).toMatchObject([{ status: 'completed', totalCount: 10,
      snapshot: { provider: 'openai' } }]);
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it('retries only the failed search on the original partial scan', async () => {
    const f = await setup();
    const collect = vi.spyOn(f.answers, 'collect').mockRejectedValueOnce(new ProviderError('fixture_failure', 'Search failed', false));
    const { projectId } = await f.createPreview();
    await f.drain();
    const [partial] = await f.repository.listRuns(projectId);
    const expected = { id: partial.id, status: 'partial', totalCount: 10, succeededCount: 9, terminalCount: 10 };
    expect(partial).toMatchObject(expected);
    expect(await (await f.call('/projects')).json()).toMatchObject({ items: [{ previewScan: expected }] });
    expect(await (await f.call(`/projects/${projectId}/settings`)).json()).toMatchObject({ previewScan: expected });
    const before = await f.repository.listResults(projectId, partial.id);
    const failed = before.find(row => row.status === 'failed_collection')!;
    const retry = `/projects/${projectId}/runs/${partial.id}/retry-failed`;
    expect((await f.call(retry, 'POST')).status).toBe(202);
    expect((await f.call(retry, 'POST')).status).toBe(202);
    await f.drain();
    const runs = await f.repository.listRuns(projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: partial.id, status: 'completed', terminalCount: 10, succeededCount: 10 });
    expect(collect).toHaveBeenCalledTimes(11);
    const after = await f.repository.listResults(projectId, partial.id);
    expect(after.filter(row => row.promptId !== failed.promptId)).toEqual(before.filter(row => row.promptId !== failed.promptId));
    expect(f.schedule).not.toHaveBeenCalled();
  });
});
