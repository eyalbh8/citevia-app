import { describe, expect, it, vi } from 'vitest';
import {
  onboardingInputSchema,
  journeyAllocation,
  JOURNEY_STAGES,
  type OnboardingInput,
  type OnboardingJob,
  type CapturedAnswer,
} from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
} from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import {
  OpenAIOnboardingProvider,
  validatePortfolio,
} from '../apps/scanner/src/onboarding-provider.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { FixtureProvider } from './fixtures/scanner.js';
const input: OnboardingInput = {
  name: 'Acme',
  website: 'https://acme.com',
  country: 'US',
  language: 'en',
  timezone: 'Asia/Nicosia',
  description: 'A company supplying analytics software to marketing teams.',
  manualPrompts: [
    { text: 'What evidence supports Acme reliability?', stage: 'trust' },
  ],
};
function environment() {
  const repository = new MemoryRepository(),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  return { repository, artifacts, queue };
}
const req = (
  path: string,
  method = 'GET',
  body?: unknown,
  key = 'test-request-123',
) =>
  new Request(`https://test/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function drain(scanner: Scanner, queue: MemoryQueue) {
  let processed = 0;
  while (queue.messages.length) {
    if (++processed > 1000) throw new Error('Unbounded workflow');
    const message = queue.messages.shift()!;
    try {
      await scanner.handle(message);
    } catch {
      queue.messages.push(message);
    }
  }
}
describe('automated account onboarding', () => {
  it('preserves manual prompts, generates all four sections and starts exactly one first scan', async () => {
    const runtime = environment(),
      provider = new FixtureOnboardingProvider(),
      research = vi.spyOn(provider, 'research'),
      brandbook = vi.spyOn(provider, 'brandbook'),
      prompts = vi.spyOn(provider, 'prompts'),
      schedule = vi.fn(async () => {});
    const engine = new OnboardingEngine(runtime, provider, schedule),
      scanner = new Scanner({
        ...runtime,
        provider: new FixtureProvider(),
        onboarding: engine,
      }),
      api = createApi(runtime, { auth: 'aws', mode: 'live' });
    const first = await api(
      req('/onboarding/accounts', 'POST', { accounts: [input] }),
      { userId: 'owner' },
    );
    expect(first.status).toBe(202);
    const { items } = await first.json(),
      projectId = items[0].project.id;
    expect(
      await runtime.repository.getMembership(projectId, 'owner'),
    ).toMatchObject({ role: 'owner' });
    expect((await runtime.repository.getProject(projectId))?.enabled).toBe(
      false,
    );
    await drain(scanner, runtime.queue);
    const project = (await runtime.repository.getProject(projectId))!,
      job = (await runtime.repository.getOnboarding(
        projectId,
        project.onboardingJobId!,
      ))!;
    expect(job.status).toBe('completed');
    expect(project.enabled).toBe(true);
    expect(project.prompts).toHaveLength(50);
    expect(project.brandbook?.generationId).toBe(job.id);
    expect(project.prompts[0]).toMatchObject({
      ...input.manualPrompts[0],
      active: true,
    });
    for (const stage of JOURNEY_STAGES)
      expect(project.prompts.some((p) => p.stage === stage)).toBe(true);
    expect(
      await runtime.repository.getRun(projectId, job.firstRunId!),
    ).toMatchObject({
      status: 'completed',
      succeededCount: 50,
      totalCount: 50,
    });
    expect(research).toHaveBeenCalledTimes(1);
    expect(brandbook).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(
      (
        await api(req('/onboarding/accounts', 'POST', { accounts: [input] }), {
          userId: 'owner',
        })
      ).status,
    ).toBe(202);
    await drain(scanner, runtime.queue);
    expect(await runtime.repository.listRuns(projectId)).toHaveLength(1);
    expect(research).toHaveBeenCalledTimes(1);
    expect(
      (
        await api(req(`/projects/${projectId}/brandbook`), {
          userId: 'another-owner',
        })
      ).status,
    ).toBe(404);
    const conflict = await api(
      req('/onboarding/accounts', 'POST', {
        accounts: [{ ...input, name: 'Different' }],
      }),
      { userId: 'owner' },
    );
    expect(conflict.status).toBe(409);
  });
  it('resumes a failed prompt generation from its saved research and brandbook', async () => {
    const runtime = environment(),
      provider = new FixtureOnboardingProvider(),
      research = vi.spyOn(provider, 'research'),
      book = vi.spyOn(provider, 'brandbook');
    const generate = provider.prompts.bind(provider);
    let calls = 0;
    vi.spyOn(provider, 'prompts').mockImplementation(async (...args) => {
      if (++calls === 1)
        throw new ProviderError('temporarily_unavailable', 'Retry later', true);
      return generate(...args);
    });
    const created = await createAccounts(
      runtime,
      'owner',
      'checkpoint-key',
      { accounts: [input] },
      new Date(),
      100,
    );
    const scanner = new Scanner({
      ...runtime,
      provider: new FixtureProvider(),
      onboarding: new OnboardingEngine(runtime, provider, async () => {}),
    });
    await drain(scanner, runtime.queue);
    expect(research).toHaveBeenCalledTimes(1);
    expect(book).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(
      (
        await runtime.repository.getOnboarding(
          created.items[0].project.id,
          created.items[0].job.id,
        )
      )?.status,
    ).toBe('completed');
  });
  it('bounds retries, exposes the failure, and lets the owner repair the same job', async () => {
    const runtime = environment(),
      provider = new FixtureOnboardingProvider(),
      original = provider.research.bind(provider);
    vi.spyOn(provider, 'research').mockRejectedValue(
      new ProviderError('unavailable', 'Research unavailable', true),
    );
    const created = await createAccounts(
        runtime,
        'owner',
        'bounded-key',
        { accounts: [input] },
        new Date(),
        100,
      ),
      item = created.items[0];
    const scanner = new Scanner({
      ...runtime,
      provider: new FixtureProvider(),
      onboarding: new OnboardingEngine(runtime, provider, async () => {}),
    });
    await drain(scanner, runtime.queue);
    expect(
      await runtime.repository.getOnboarding(item.project.id, item.job.id),
    ).toMatchObject({ status: 'failed', attempts: 4, step: 'research' });
    vi.mocked(provider.research).mockImplementation(original);
    const api = createApi(runtime, { auth: 'aws', mode: 'live' });
    expect(
      (
        await api(
          req(`/projects/${item.project.id}/onboarding/retry`, 'POST'),
          { userId: 'stranger' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          req(`/projects/${item.project.id}/onboarding/retry`, 'POST'),
          { userId: 'owner' },
        )
      ).status,
    ).toBe(202);
    await drain(scanner, runtime.queue);
    expect(
      (await runtime.repository.getOnboarding(item.project.id, item.job.id))
        ?.status,
    ).toBe('completed');
  });
  it('enforces account limits atomically and can repair queue failure with the same request key', async () => {
    const runtime = environment();
    const outcomes = await Promise.all(
      ['owner-limit-1', 'owner-limit-2'].map((key) =>
        createAccounts(
          runtime,
          'owner',
          key,
          { accounts: [input] },
          new Date(),
          1,
        ),
      ),
    );
    expect(await runtime.repository.listProjects('owner')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.limitReached)).toHaveLength(1);
    const next = environment(),
      send = vi
        .spyOn(next.queue, 'send')
        .mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(
      createAccounts(
        next,
        'owner',
        'repair-key',
        { accounts: [input] },
        new Date(),
        100,
      ),
    ).rejects.toThrow();
    expect(await next.repository.listProjects('owner')).toHaveLength(1);
    const retried = await createAccounts(
      next,
      'owner',
      'repair-key',
      { accounts: [input] },
      new Date(),
      100,
    );
    expect(retried.items).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('deduplicates parallel worker deliveries with a conditional lease', async () => {
    const runtime = environment(),
      provider = new FixtureOnboardingProvider(),
      research = vi.spyOn(provider, 'research');
    const { items } = await createAccounts(
      runtime,
      'owner',
      'lease-key',
      { accounts: [input] },
      new Date(),
      100,
    );
    const worker = new OnboardingEngine(runtime, provider, async () => {});
    await Promise.all([
      worker.handle(items[0].project.id, items[0].job.id),
      worker.handle(items[0].project.id, items[0].job.id),
    ]);
    expect(research).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid public URLs, duplicate manual prompts and more than fifty prompts', () => {
    for (const website of [
      'http://127.0.0.1',
      'http://localhost',
      'https://user:secret@acme.com',
      'https://acme.com:8000',
    ])
      expect(
        onboardingInputSchema.safeParse({ ...input, website }).success,
      ).toBe(false);
    expect(
      onboardingInputSchema.safeParse({
        ...input,
        manualPrompts: [input.manualPrompts[0], input.manualPrompts[0]],
      }).success,
    ).toBe(false);
    expect(
      onboardingInputSchema.safeParse({
        ...input,
        manualPrompts: Array.from({ length: 51 }, (_, i) => ({
          text: `Question number ${i}?`,
          stage: 'understand',
        })),
      }).success,
    ).toBe(false);
    expect(journeyAllocation([])).toEqual({
      understand: 13,
      prefer: 13,
      trust: 12,
      convert: 12,
    });
  });
  it('rejects duplicate generated prompts and wrong section allocation', async () => {
    const runtime = environment(),
      { items } = await createAccounts(
        runtime,
        'owner',
        'quality-key',
        { accounts: [input] },
        new Date(),
        100,
      ),
      job = items[0].job,
      book = (await new FixtureOnboardingProvider().brandbook(job)).brandbook;
    expect(() =>
      validatePortfolio(job, book, {
        prompts: Array.from({ length: 49 }, () => ({
          text: 'The same question?',
          stage: 'understand',
          topic: 'Same',
          branded: false,
        })),
      }),
    ).toThrow();
  });
  it('rejects fabricated research URLs or quotations in generated brandbooks', async () => {
    const job = { id: 'job', input } as OnboardingJob;
    const payload = {
      about: 'Acme provides analytics software for business teams.',
      industryCategory: 'Analytics',
      subIndustryCategory: '',
      names: ['Acme'],
      keyFeatures: [],
      toneOfVoice: [],
      values: [],
      personality: [],
      targetAudience: [],
      knowledgeSources: ['https://acme.com'],
      sitemapUrl: null,
      caseStudiesSourceUrl: null,
      postGuidelines: { dos: [], donts: [] },
      evidence: [
        { field: 'about', quote: 'An invented quote', url: 'https://acme.com' },
      ],
      unknowns: [],
    };
    const provider = new OpenAIOnboardingProvider({
      answer: vi.fn(),
      extract: async () => ({
        response: {
          id: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify(payload) }],
            },
          ],
        },
        requestId: 'request',
        receivedAt: new Date().toISOString(),
      }),
    });
    const research: CapturedAnswer =
      await new FixtureOnboardingProvider().research(job);
    research.sources = [{ url: 'https://acme.com' }];
    await expect(provider.brandbook(job, research)).rejects.toMatchObject({
      code: 'brandbook_evidence_invalid',
    });
  });
});
