import { describe, expect, it, vi } from 'vitest';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { createApi } from '../apps/api/src/app.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { FixtureProvider } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const input = {
  name: 'Acme',
  website: 'https://acme.com',
  region: 'IT',
  language: 'it',
};
async function setup() {
  const repository = new MemoryRepository(),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  await repository.syncUser(testIdentity('owner'));
  const runtime = { repository, artifacts, queue };
  const item = (
    await createAccounts(
      runtime,
      'owner',
      'stop-test-account',
      { accounts: [input] },
      new Date(),
      100,
    )
  ).items[0];
  queue.messages.length = 0;
  const provider = new FixtureOnboardingProvider();
  const research = vi.spyOn(provider, 'research'),
    brandbook = vi.spyOn(provider, 'brandbook'),
    prompts = vi.spyOn(provider, 'prompts');
  const worker = new OnboardingEngine(runtime, provider, async () => {});
  const api = createApi(runtime, { mode: 'live' });
  const call = (tail: string, body?: unknown, identity = 'owner') =>
    api(
      new Request(`https://test/v1/projects/${item.project.id}/${tail}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'explicit-owner-retry',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      testIdentity(identity),
    );
  return {
    ...runtime,
    item,
    provider,
    research,
    brandbook,
    prompts,
    worker,
    api,
    call,
  };
}
async function drain(env: Awaited<ReturnType<typeof setup>>) {
  let count = 0;
  while (env.queue.messages.length) {
    if (++count > 20) throw Error('Unbounded onboarding delivery');
    const message = env.queue.messages.shift()!;
    if (message.kind === 'onboard')
      await env.worker.handle(message.projectId, message.jobId);
  }
}

describe('onboarding paid-call stop policy', () => {
  it('restarts research for an owner-corrected Hebrew name without reusing old identity checkpoints', async () => {
    const env = await setup();
    const { id, projectId, inputHash } = env.item.job;
    for (let step = 0; step < 3; step++) await env.worker.handle(projectId, id);
    const previous = (await env.repository.getOnboarding(projectId, id))!;
    const project = (await env.repository.getProject(projectId))!;
    const name = "משרד עורכי הדין דנה ושות'";
    await env.repository.saveProject({ ...project, name, brand: { ...project.brand, name }, language: 'he',
      version: project.version + 1 }, project.version);
    await env.worker.handle(projectId, id);
    expect((await env.repository.getOnboarding(projectId, id))?.error?.code).toBe('onboarding_account_changed');
    expect((await env.call('onboarding/retry')).status).toBe(202);
    const retried = (await env.repository.getOnboarding(projectId, id))!;
    expect(retried).toMatchObject({ status: 'queued', step: 'research', inputHash,
      input: { name, language: 'he' }, researchRevision: 1, portfolioRevision: 1 });
    for (const key of ['researchKey', 'brandbookKey', 'promptsKey', 'verifiedResearchKey',
      'verifiedBrandbookKey', 'competitorSearchTerm', 'competitorSearchDomains', 'rejectedPortfolioKey'] as const)
      expect(retried[key]).toBeUndefined();
    // Creation idempotency and the original receipts remain intact.
    expect(await env.artifacts.get(previous.researchKey!)).toBeTruthy();
    expect(await env.artifacts.get(previous.promptsKey!)).toBeTruthy();
    expect((await env.call('onboarding/retry')).status).toBe(202);
    expect((await env.repository.getOnboarding(projectId, id))?.version).toBe(retried.version);
    await Promise.all([env.worker.handle(projectId, id), env.worker.handle(projectId, id)]);
    expect(env.research).toHaveBeenCalledTimes(2);
    expect(env.research.mock.calls[1][0].input.name).toBe(name);
    expect((await env.repository.getOnboarding(projectId, id))?.researchKey).not.toBe(previous.researchKey);
    expect(env.queue.messages.some(message => message.kind === 'kickoff')).toBe(false);
  });

  it('does not overwrite already applied results after an identity edit and retry', async () => {
    const env = await setup();
    const { id, projectId } = env.item.job;
    for (let step = 0; step < 3; step++) await env.worker.handle(projectId, id);
    const project = (await env.repository.getProject(projectId))!;
    const job = (await env.repository.getOnboarding(projectId, id))!;
    await env.repository.saveProject({ ...project, brand: { ...project.brand, name: 'Different brand' },
      onboardingAppliedJobId: id, version: project.version + 1 }, project.version);
    await env.repository.saveOnboarding({ ...job, status: 'failed', version: job.version + 1 }, job.version);
    expect((await env.call('onboarding/retry')).status).toBe(409);
    expect((await env.repository.getOnboarding(projectId, id))?.status).toBe('failed');
    expect(env.research).toHaveBeenCalledTimes(1);
  });

  it('prevents a saved portfolio with duplicate prompts from activating the account or starting the first scan', async () => {
    const env = await setup();
    const { id, projectId } = env.item.job;
    for (let step = 0; step < 3; step++) await env.worker.handle(projectId, id);
    const before = (await env.repository.getOnboarding(projectId, id))!;
    expect(before.step).toBe('activate');
    const saved = (await env.artifacts.get<{ prompts: {text: string}[] }>(before.promptsKey!))!;
    saved.prompts[1].text = saved.prompts[0].text;
    await env.artifacts.put(before.promptsKey!, saved);
    await env.worker.handle(projectId, id);
    expect((await env.repository.getProject(projectId))?.enabled).toBe(false);
    expect(env.queue.messages.some(message => message.kind === 'kickoff')).toBe(false);
    expect((await env.repository.getOnboarding(projectId, id))?.step).not.toBe('completed');
  });

  it('keeps previous brand research from activating a different business after the owner edits the account', async () => {
    const env = await setup();
    const { id, projectId } = env.item.job;
    for (let step = 0; step < 3; step++) await env.worker.handle(projectId, id);
    const project = (await env.repository.getProject(projectId))!;
    await env.repository.saveProject({
      ...project, version: project.version + 1,
      brand: { ...project.brand, domains: ['different-business.com'] },
    }, project.version);
    await env.worker.handle(projectId, id);
    expect(await env.repository.getOnboarding(projectId, id)).toMatchObject({
      status: 'failed', error: { code: 'onboarding_account_changed' },
    });
    expect((await env.repository.getProject(projectId))?.prompts).toHaveLength(0);
    expect(env.queue.messages.some(message => message.kind === 'kickoff')).toBe(false);
  });

  it.each(['research', 'brandbook', 'prompts'] as const)(
    'stops %s after one failed call and ignores stale queue, DLQ and recovery deliveries',
    async (step) => {
      const env = await setup();
      env[step].mockRejectedValue(
        new ProviderError(
          'validation_failed',
          'Review the output before retrying.',
          true,
        ),
      );
      await env.worker.handle(env.item.project.id, env.item.job.id);
      await drain(env);
      const job = (await env.repository.getOnboarding(
        env.item.project.id,
        env.item.job.id,
      ))!;
      expect(job).toMatchObject({ status: 'failed', step, attempts: 1 });
      expect(job.paidCall?.step).toBe(step);
      await env.worker.reconcile();
      await env.worker.handle(job.projectId, job.id);
      await env.worker.deadLetter(job.projectId, job.id);
      expect(env[step]).toHaveBeenCalledTimes(1);
      expect(env.queue.messages).toHaveLength(0);
      expect((await env.repository.getProject(job.projectId))?.enabled).toBe(
        false,
      );
      expect(await env.repository.listRuns(job.projectId)).toHaveLength(0);
      if (step !== 'prompts') expect(env.prompts).not.toHaveBeenCalled();
    },
  );
  it('does not repurchase a response after a checkpoint write failure', async () => {
    const env = await setup();
    vi.spyOn(env.artifacts, 'put').mockRejectedValue(
      Error('Storage unavailable'),
    );
    await env.worker.handle(env.item.project.id, env.item.job.id);
    await env.worker.reconcile();
    await env.worker.handle(env.item.project.id, env.item.job.id);
    expect(env.research).toHaveBeenCalledTimes(1);
    expect(
      (await env.repository.getOnboarding(env.item.project.id, env.item.job.id))
        ?.status,
    ).toBe('failed');
    expect(env.brandbook).not.toHaveBeenCalled();
  });
  it('stops an expired, ambiguous paid-call intent and requires explicit retry before calling again', async () => {
    const env = await setup(),
      original = env.item.job;
    await env.repository.saveOnboarding(
      {
        ...original,
        status: 'running',
        version: original.version + 1,
        attempts: 1,
        leaseExpiresAt: '2020-01-01T00:00:00Z',
        paidCall: {
          id: 'prior-call',
          step: 'research',
          startedAt: original.createdAt,
        },
      },
      original.version,
    );
    await env.worker.handle(original.projectId, original.id);
    expect(env.research).not.toHaveBeenCalled();
    expect(
      await env.repository.getOnboarding(original.projectId, original.id),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'onboarding_call_uncertain' },
    });
    expect((await env.call('onboarding/retry')).status).toBe(202);
    expect(
      (await env.repository.getOnboarding(original.projectId, original.id))
        ?.paidCall,
    ).toBeUndefined();
    await drain(env);
    expect(env.research).toHaveBeenCalledTimes(1);
  });
  it('recovers a successfully saved checkpoint without repeating the model call', async () => {
    const env = await setup(),
      original = env.item.job;
    await env.artifacts.put(
      `projects/${original.projectId}/onboarding/${original.id}/research.json`,
      await env.provider.research(original),
    );
    env.research.mockClear();
    await env.repository.saveOnboarding(
      {
        ...original,
        status: 'running',
        version: original.version + 1,
        attempts: 1,
        paidCall: {
          id: 'prior-call',
          step: 'research',
          startedAt: original.createdAt,
        },
      },
      original.version,
    );
    await env.worker.handle(original.projectId, original.id);
    expect(env.research).not.toHaveBeenCalled();
    expect(
      await env.repository.getOnboarding(original.projectId, original.id),
    ).toMatchObject({ status: 'queued', step: 'brandbook', attempts: 0 });
  });
  it('fences an in-flight completion after Stop and preserves its checkpoint without advancing', async () => {
    const env = await setup(),
      original = env.item.job;
    const saved = await env.provider.research(original);
    env.research.mockClear();
    let resolve!: (value: typeof saved) => void, entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    env.research.mockImplementation(() => {
      entered();
      return new Promise((done) => {
        resolve = done;
      });
    });
    const inFlight = env.worker.handle(original.projectId, original.id);
    await started;
    expect((await env.call('onboarding/stop')).status).toBe(200);
    resolve(saved);
    await inFlight;
    expect(
      (await env.repository.getOnboarding(original.projectId, original.id))
        ?.status,
    ).toBe('stopped');
    expect(
      await env.artifacts.get(
        `projects/${original.projectId}/onboarding/${original.id}/research.json`,
      ),
    ).not.toBeNull();
    await env.worker.reconcile();
    await env.worker.handle(original.projectId, original.id);
    expect(env.research).toHaveBeenCalledTimes(1);
    expect(env.brandbook).not.toHaveBeenCalled();
    expect(env.queue.messages).toHaveLength(0);
    expect((await env.call('onboarding/retry')).status).toBe(202);
  });
  it('protects Stop with account permissions and prevents manual or scheduled scans for failed setup', async () => {
    const env = await setup();
    await env.repository.syncUser(testIdentity('viewer'));
    await env.repository.putMembership({
      projectId: env.item.project.id,
      userId: 'viewer',
      role: 'viewer',
    });
    expect(
      (await env.call('onboarding/stop', undefined, 'viewer')).status,
    ).toBe(403);
    expect(
      (await env.call('onboarding/stop', undefined, 'stranger')).status,
    ).toBe(404);
    expect((await env.call('onboarding/stop')).status).toBe(200);
    expect((await env.call('runs')).status).toBe(409);
    const project = (await env.repository.getProject(env.item.project.id))!;
    await env.repository.saveProject(
      { ...project, version: project.version + 1, enabled: true },
      project.version,
    );
    const collector = { collect: vi.fn(), extract: vi.fn() };
    const scanner = new Scanner({
      repository: env.repository,
      artifacts: env.artifacts,
      queue: env.queue,
      provider: collector,
    });
    for (const trigger of ['manual', 'scheduled'] as const)
      await scanner.handle({
        kind: 'kickoff',
        projectId: project.id,
        scheduledAt: new Date().toISOString(),
        trigger,
      });
    expect(await env.repository.listRuns(project.id)).toHaveLength(0);
    expect(collector.collect).not.toHaveBeenCalled();
  });
  it('pauses tracking on schedule failure and resumes the validated first portfolio on owner retry', async () => {
    const env = await setup();
    const worker = new OnboardingEngine(
      {
        repository: env.repository,
        artifacts: env.artifacts,
        queue: env.queue,
      },
      env.provider,
      async () => {
        throw Error('Schedule unavailable');
      },
    );
    await worker.handle(env.item.project.id, env.item.job.id);
    let deliveries = 0;
    while (env.queue.messages.length) {
      if (++deliveries > 20) throw Error('Unbounded retries');
      const job = env.queue.messages.shift()!;
      if (job.kind === 'onboard') {
        try {
          await worker.handle(job.projectId, job.jobId);
        } catch {
          env.queue.messages.push(job);
        }
      }
    }
    expect(
      (await env.repository.getOnboarding(env.item.project.id, env.item.job.id))
        ?.status,
    ).toBe('failed');
    expect(
      (await env.repository.getProject(env.item.project.id))?.enabled,
    ).toBe(false);
    const savedPrompts = (await env.repository.getProject(env.item.project.id))!.prompts;
    expect((await env.call('onboarding/retry')).status).toBe(202);
    await drain(env);
    const resumed = (await env.repository.getProject(env.item.project.id))!;
    expect(resumed.enabled).toBe(true);
    expect(resumed.prompts).toEqual(savedPrompts);
    expect((await env.repository.getOnboarding(resumed.id, env.item.job.id))?.status).toBe('completed');
    expect(env.research).toHaveBeenCalledTimes(1);
    expect(env.brandbook).toHaveBeenCalledTimes(1);
    expect(env.prompts).toHaveBeenCalledTimes(1);
  });
});
