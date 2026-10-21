import { testIdentity } from './fixtures/users.js';
import { describe, expect, it, vi } from 'vitest';
import {
  onboardingInputSchema,
  journeyAllocation,
  JOURNEY_STAGES,
  JOURNEY_PROMPT_COUNTS,
  type AccountOnboardingInput,
  type OnboardingJob,
  type CapturedAnswer,
} from '@citevia/core';
import { portfolioGenerationSchema } from '../apps/scanner/src/onboarding-prompts.js';
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
const input: AccountOnboardingInput = {
  name: 'Acme',
  website: 'https://acme.com',
  region: 'US',
  language: 'en',
};
async function environment() {
  const repository = new MemoryRepository(),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  const user = await repository.syncUser(testIdentity('owner'));
  await repository.bootstrapAdmin(user.id);
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
  it('accepts only four fields, generates all fifty prompts and starts one first scan per provider', async () => {
    const runtime = await environment(),
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
      api = createApi(runtime, { mode: 'live' });
    const first = await api(
      req('/onboarding/accounts', 'POST', { accounts: [input] }),
      testIdentity('owner'),
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
    expect(project.country).toBe(input.region);
    expect(project.timezone).toBe('UTC');
    expect(job.input.manualPrompts).toEqual([]);
    expect(job.input.description).toBe('');
    for (const stage of JOURNEY_STAGES)
      expect(
        project.prompts.filter((prompt) => prompt.stage === stage),
      ).toHaveLength(journeyAllocation([])[stage]);
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
        await api(
          req('/onboarding/accounts', 'POST', { accounts: [input] }),
          testIdentity('owner'),
        )
      ).status,
    ).toBe(202);
    await drain(scanner, runtime.queue);
    expect(await runtime.repository.listRuns(projectId)).toHaveLength(3);
    expect(research).toHaveBeenCalledTimes(1);
    expect(
      (
        await api(
          req(`/projects/${projectId}/brandbook`),
          testIdentity('another-owner'),
        )
      ).status,
    ).toBe(404);
    const conflict = await api(
      req('/onboarding/accounts', 'POST', {
        accounts: [{ ...input, name: 'Different' }],
      }),
      testIdentity('owner'),
    );
    expect(conflict.status).toBe(409);
  });
  it('stops a failed generation and resumes from saved research only after explicit retry', async () => {
    const runtime = await environment(),
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
    expect(calls).toBe(1);
    const item = created.items[0];
    expect(
      (await runtime.repository.getOnboarding(item.project.id, item.job.id))
        ?.status,
    ).toBe('failed');
    const api = createApi(runtime, { mode: 'live' });
    expect(
      (
        await api(
          req(`/projects/${item.project.id}/onboarding/retry`, 'POST'),
          testIdentity('owner'),
        )
      ).status,
    ).toBe(202);
    await drain(scanner, runtime.queue);
    expect(calls).toBe(2);
    expect(research).toHaveBeenCalledTimes(1);
    expect(book).toHaveBeenCalledTimes(1);
    expect(
      (
        await runtime.repository.getOnboarding(
          created.items[0].project.id,
          created.items[0].job.id,
        )
      )?.status,
    ).toBe('completed');
  });
  it('stops after one failed API call, exposes the failure, and lets the owner retry', async () => {
    const runtime = await environment(),
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
    ).toMatchObject({ status: 'failed', attempts: 1, step: 'research' });
    vi.mocked(provider.research).mockImplementation(original);
    const api = createApi(runtime, { mode: 'live' });
    expect(
      (
        await api(
          req(`/projects/${item.project.id}/onboarding/retry`, 'POST'),
          testIdentity('stranger'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          req(`/projects/${item.project.id}/onboarding/retry`, 'POST'),
          testIdentity('owner'),
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
    const runtime = await environment();
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
    const next = await environment(),
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
    const runtime = await environment(),
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
  it('requires exactly the four onboarding fields and rejects unsafe websites or obsolete extra inputs', () => {
    expect(onboardingInputSchema.parse(input)).toEqual(input);
    expect(
      onboardingInputSchema.parse({ ...input, region: ' gb ' }).region,
    ).toBe('GB');
    for (const website of [
      'http://127.0.0.1',
      'http://localhost',
      'https://user:secret@acme.com',
      'https://acme.com:8000',
    ])
      expect(
        onboardingInputSchema.safeParse({ ...input, website }).success,
      ).toBe(false);
    for (const field of ['name', 'region', 'language', 'website']) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(onboardingInputSchema.safeParse(missing).success).toBe(false);
    }
    for (const extra of [
      { description: 'Notes' },
      { timezone: 'UTC' },
      { manualPrompts: [] },
      { country: 'US' },
    ])
      expect(
        onboardingInputSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
    expect(journeyAllocation([])).toEqual({
      understand: 13,
      prefer: 13,
      trust: 12,
      convert: 12,
    });
  });
  it('rejects duplicate generated prompts and wrong section allocation', async () => {
    const runtime = await environment(),
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
  it('sends the four brand-specific tactics and exact allocation to OpenAI without requiring company notes', async () => {
    const runtime = await environment();
    const { items } = await createAccounts(
      runtime,
      'owner',
      'tactics-test',
      {
        accounts: [
          {
            ...input,
            name: 'A different brand',
            region: 'GB',
            language: 'en-GB',
          },
        ],
      },
      new Date(),
      100,
    );
    const job = items[0].job,
      fixture = new FixtureOnboardingProvider();
    const book = (await fixture.brandbook(job)).brandbook;
    const prompts = (await fixture.prompts(job, book)).prompts.map(
      ({ text, stage, topic, branded, intent }) => ({
        text,
        stage,
        topic,
        branded,
        intent,
      }),
    );
    const sections = Object.fromEntries(
      JOURNEY_STAGES.map((stage) => [
        stage,
        Object.fromEntries(
          ['branded', 'unbranded'].map((group) => [
            group,
            prompts
              .filter((prompt) => prompt.stage === stage)
              .filter((_, i) =>
                group === 'branded'
                  ? i < (stage === 'convert' ? 3 : 4)
                  : i >= (stage === 'convert' ? 3 : 4),
              )
              .map(({ text, topic, intent }) => ({ text, topic, intent })),
          ]),
        ),
      ]),
    );
    const extract = vi.fn(async (_request: unknown) => ({
      response: {
        id: 'native',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(sections) }],
          },
        ],
      },
      requestId: 'native-request',
      receivedAt: new Date().toISOString(),
    }));
    const generated = await new OpenAIOnboardingProvider({
      answer: vi.fn(),
      extract,
    }).prompts(job, book);
    const request = extract.mock.calls[0][0] as {
      input: Record<string, unknown>;
      instructions: string;
      schema: {
        properties: Record<string, any>;
        required: string[];
        additionalProperties: boolean;
      };
    };
    expect(request.input).toMatchObject({
      market: 'GB',
      language: 'en-GB',
      brand_name: 'A different brand',
      remaining_count: 50,
      manual_prompts: [],
      section_allocation: JOURNEY_PROMPT_COUNTS,
      section_goals: {
        understand: 'Does AI understand what A different brand does?',
        prefer: 'Does AI prefer A different brand over rivals?',
        trust: 'Does AI trust A different brand as a source?',
        convert: 'Does AI help buyers take the next step?',
      },
    });
    expect(generated.prompts).toHaveLength(50);
    for (const stage of JOURNEY_STAGES) {
      expect(
        request.schema.properties[stage].properties.unbranded,
      ).toMatchObject({
        type: 'array',
        minItems: JOURNEY_PROMPT_COUNTS[stage] - (stage === 'convert' ? 3 : 4),
        maxItems: JOURNEY_PROMPT_COUNTS[stage] - (stage === 'convert' ? 3 : 4),
      });
      expect(
        request.schema.properties[stage].properties.unbranded.items.properties,
      ).not.toHaveProperty('stage');
      expect(
        generated.prompts.filter((prompt) => prompt.stage === stage),
      ).toHaveLength(JOURNEY_PROMPT_COUNTS[stage]);
    }
    expect(request.schema.required).toEqual([...JOURNEY_STAGES]);
    expect(request.schema.additionalProperties).toBe(false);
    expect(request.instructions).toContain(
      'source authority as its central purpose',
    );
    expect(request.input.maximum_branded_count).toBe(15);
    expect(generated.receipt).toMatchObject({
      instructionsVersion: 'citevia-onboarding-v6',
    });
    // Regression: the real failure had 13/12/12/13, even though the total was 50.
    // A provider returning that split must still stop after one paid attempt.
    sections.convert.unbranded.push(sections.prefer.unbranded.pop()!);
    await expect(
      new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).prompts(
        job,
        book,
      ),
    ).rejects.toMatchObject({
      code: 'onboarding_coverage_invalid',
      retryable: false,
    });
    expect(extract).toHaveBeenCalledTimes(2); // One success above and one rejected attempt; no internal retry.
    const duplicate = structuredClone(prompts);
    duplicate[1].text = duplicate[0].text;
    expect(() =>
      validatePortfolio(job, book, { prompts: duplicate }),
    ).toThrowError(
      expect.objectContaining({ code: 'onboarding_duplicate_prompts' }),
    );
    const meta = structuredClone(prompts);
    meta[0].text = 'Does AI understand what A different brand does?';
    expect(() => validatePortfolio(job, book, { prompts: meta })).toThrowError(
      expect.objectContaining({
        code: 'onboarding_measurement_goal_as_prompt',
      }),
    );
  });
  it('rejects removed onboarding inputs before creating any account', async () => {
    const runtime = await environment(),
      api = createApi(runtime, { mode: 'live' });
    const response = await api(
      req('/onboarding/accounts', 'POST', {
        accounts: [
          {
            ...input,
            manualPrompts: [
              { text: 'An injected prompt?', stage: 'understand' },
            ],
          },
        ],
      }),
      testIdentity('owner'),
    );
    expect(response.status).toBe(400);
    expect(await runtime.repository.listProjects('owner')).toHaveLength(0);
    expect(runtime.queue.messages).toHaveLength(0);
  });
  it('rejects fabricated research URLs or quotations in generated brandbooks', async () => {
    const runtime = await environment();
    const { items } = await createAccounts(
      runtime,
      'owner',
      'evidence-test',
      { accounts: [input] },
      new Date(),
      100,
    );
    const job = items[0].job;
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
    research.citations = [
      {
        id: 'native',
        blockId: research.blocks[0].id,
        url: 'https://acme.com',
        title: 'Official',
        start: 0,
        end: research.text.length,
      },
    ];
    await expect(provider.brandbook(job, research)).rejects.toMatchObject({
      code: 'brandbook_evidence_invalid',
    });
  });
});

describe('portfolio response schema allocation', () => {
  it('reserves zero generated Understand slots when a legacy account already supplied all thirteen', () => {
    const manual = Array.from({ length: 13 }, (_, index) => ({
      text: `Existing question ${index}`,
      stage: 'understand' as const,
    }));
    const allocation = journeyAllocation(manual);
    expect(allocation).toEqual({
      understand: 0,
      prefer: 13,
      trust: 12,
      convert: 12,
    });
    const schema = portfolioGenerationSchema(allocation);
    expect(schema.properties.understand.properties.unbranded).toMatchObject({
      minItems: 0,
      maxItems: 0,
    });
    expect(schema.properties.prefer.properties.unbranded).toMatchObject({
      minItems: 8,
      maxItems: 8,
    });
  });
});
