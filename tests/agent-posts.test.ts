import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentPost, AgentPostJob, Brandbook } from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
  type Repository,
  type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import {
  AgentPostEngine,
  agentGenerationRequest,
  parseAgentContent,
} from '../apps/scanner/src/agent-posts.js';
import {
  ProviderError,
  extractionBody,
  type ProviderReceipt,
} from '../apps/scanner/src/provider.js';
import { parseScanMessage } from '../apps/scanner/src/handler.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const draft = {
  title: 'Make reporting clearer',
  body: 'Start with one question. Choose metrics that help your team answer it.',
  hashtags: ['#Analytics'],
};
const receipt = (content: unknown = draft): ProviderReceipt => ({
  response: {
    id: 'test-response',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(content) }],
      },
    ],
  },
  requestId: 'test-request',
  receivedAt: '2026-10-21T09:00:00.000Z',
});
const book: Brandbook = {
  about: 'Verified account description',
  industryCategory: 'Analytics',
  subIndustryCategory: '',
  companyCountry: 'US',
  language: 'en',
  names: ['Northstar'],
  domains: ['northstar.example'],
  keyFeatures: ['Reporting'],
  toneOfVoice: ['Clear'],
  values: [],
  personality: [],
  targetAudience: ['Small teams'],
  knowledgeSources: [],
  sitemapUrl: null,
  caseStudiesSourceUrl: null,
  caseStudies: [],
  postGuidelines: { dos: ['Use verified facts'], donts: ['Invent numbers'] },
  evidence: [],
  unknowns: [],
  generatedAt: '2026-10-21T00:00:00Z',
  model: 'test-only',
  version: 1,
  generationId: 'test-book',
};
const input = {
  channel: 'facebook',
  topic: 'Reporting',
  prompt: 'How can a team choose useful reporting metrics?',
};

describe.each(['memory', 'postgres'] as const)(
  'agent post creation (%s)',
  (backend) => {
    let repository: Repository, db: SqlDatabase | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') {
        db = await localPostgres();
        repository = new PostgresRepository(db);
      } else repository = new MemoryRepository();
      for (const name of ['post-owner', 'post-viewer', 'post-outsider'])
        await repository.syncUser(testIdentity(name));
    }, 30000);
    afterAll(async () => {
      await db?.close();
    });
    async function setup(available = true) {
      const project = newProject({
        id: `agent-${randomUUID()}`,
        prompts: [input.prompt],
      });
      project.brandbook = structuredClone(book);
      await repository.saveProject(project, null);
      await repository.putMembership({
        projectId: project.id,
        userId: 'post-owner',
        role: 'owner',
      });
      await repository.putMembership({
        projectId: project.id,
        userId: 'post-viewer',
        role: 'viewer',
      });
      const queue = new MemoryQueue(),
        artifacts = new MemoryArtifacts();
      const runtime = { repository, queue, artifacts };
      let clock = new Date('2026-10-21T09:00:00Z');
      const api = createApi(runtime, {
        mode: 'live',
        providerAvailability: {
          openai: available,
          perplexity: false,
          gemini: false,
        },
        now: () => clock,
      });
      const extract = vi.fn(async () => receipt());
      const worker = new AgentPostEngine(
        runtime,
        async () => ({ extract, answer: vi.fn() }),
        () => clock,
      );
      const path = `/v1/projects/${project.id}/agents/posts`;
      const call = (
        suffix = '',
        method = 'GET',
        body?: unknown,
        key = 'request-test-001',
        user: string | null = 'post-owner',
      ) =>
        api(
          new Request(`https://citevia.test${path}${suffix}`, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': key,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          user ? testIdentity(user) : undefined,
        );
      const create = async (body = input, key?: string) => {
        const response = await call('', 'POST', body, key);
        expect(response.status).toBe(202);
        return ((await response.json()) as { post: AgentPost }).post;
      };
      return {
        project,
        runtime,
        worker,
        extract,
        call,
        create,
        path,
        advance: () => {
          clock = new Date(clock.getTime() + 5 * 60_000);
        },
      };
    }

    it('creates one durable draft and private receipt despite duplicate worker deliveries', async () => {
      const f = await setup();
      const post = await f.create();
      expect(post.status).toBe('queued');
      await Promise.all([
        f.worker.handle(f.project.id, post.id),
        f.worker.handle(f.project.id, post.id),
      ]);
      await f.worker.handle(f.project.id, post.id);
      expect(f.extract).toHaveBeenCalledTimes(1);
      const response = await f.call(`/${post.id}`);
      const saved = (await response.json()).post;
      expect(saved.status).toBe('draft');
      expect(saved.content).toEqual(draft);
      expect(saved).not.toHaveProperty('context');
      expect(saved).not.toHaveProperty('createdBy');
      expect(saved).not.toHaveProperty('fingerprint');
      expect(saved).not.toHaveProperty('paidCall');
      expect(
        await f.runtime.artifacts.get(
          `projects/${f.project.id}/agent-posts/${post.id}/generation-1.json`,
        ),
      ).toEqual(receipt());
      const history = await (
        await f.call('', 'GET', undefined, undefined, 'post-viewer')
      ).json();
      expect(history.total).toBe(1);
      expect(history.items[0].status).toBe('draft');
      expect(history.generationAvailable).toBe(true);
    });

    it('enforces owner permissions, input validation, configuration, and account isolation', async () => {
      const f = await setup(false);
      expect(
        (await f.call('', 'POST', input, undefined, 'post-viewer')).status,
      ).toBe(403);
      expect(
        (await f.call('', 'GET', undefined, undefined, 'post-outsider')).status,
      ).toBe(404);
      expect((await f.call('', 'GET', undefined, undefined, null)).status).toBe(
        401,
      );
      expect(
        (await f.call('', 'POST', { ...input, channel: 'not-a-channel' }))
          .status,
      ).toBe(400);
      expect(
        (await f.call('', 'POST', { ...input, prompt: '  ' })).status,
      ).toBe(400);
      expect((await f.call('', 'POST', input, 'bad')).status).toBe(400);
      expect((await f.call('', 'POST', input)).status).toBe(503);
      expect((await f.call('?cursor=-1')).status).toBe(400);
      const owner = await setup();
      const post = await owner.create();
      expect((await f.call(`/${post.id}`)).status).toBe(404);
    });

    it('recovers a queue-send failure with the same idempotent reservation', async () => {
      const f = await setup();
      const send = vi
        .spyOn(f.runtime.queue, 'send')
        .mockRejectedValueOnce(new Error('Test queue unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect((await f.call('', 'POST', input)).status).toBe(500);
      } finally {
        log.mockRestore();
      }
      expect((await repository.listAgentPosts(f.project.id, 0, 10)).total).toBe(
        1,
      );
      const post = await f.create();
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        (await f.call('', 'POST', { ...input, topic: 'Different' })).status,
      ).toBe(409);
      await f.worker.handle(f.project.id, post.id);
      expect((await f.call('', 'POST', input)).status).toBe(200);
      expect((await repository.listAgentPosts(f.project.id, 0, 10)).total).toBe(
        1,
      );
    });

    it('admits at most three active jobs atomically', async () => {
      const f = await setup();
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          f.call('', 'POST', input, `concurrent-request-${i}`),
        ),
      );
      expect(
        responses.filter((response) => response.status === 202),
      ).toHaveLength(3);
      expect(
        responses.filter((response) => response.status === 429),
      ).toHaveLength(3);
      const history = await (await f.call('?limit=2')).json();
      expect(history.items).toHaveLength(2);
      expect(history.total).toBe(3);
      expect(history.nextCursor).toBe('2');
      expect(
        (await (await f.call('?limit=2&cursor=2')).json()).items,
      ).toHaveLength(1);
    });

    it('uses the queued brandbook snapshot and retains the tracked prompt link', async () => {
      const f = await setup();
      const post = await f.create({
        ...input,
        promptId: f.project.prompts[0].id,
      } as typeof input);
      expect(
        (
          await f.call(
            '',
            'POST',
            { ...input, promptId: 'another-account-prompt' },
            'invalid-prompt-001',
          )
        ).status,
      ).toBe(400);
      const changed = {
        ...f.project,
        brandbook: { ...book, about: 'Changed after creation' },
        version: f.project.version + 1,
      };
      await repository.saveProject(changed, f.project.version);
      await f.worker.handle(f.project.id, post.id);
      const request = f.extract.mock.calls[0] as unknown as [
        { input: { brandbook: Brandbook } },
      ];
      expect(request[0].input.brandbook.about).toBe(book.about);
      expect(request[0].input.brandbook.postGuidelines).toEqual(
        book.postGuidelines,
      );
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.promptId,
      ).toBe(f.project.prompts[0].id);
    });

    it('saves edits with version checks and blocks viewer edits', async () => {
      const f = await setup();
      const post = await f.create();
      expect(
        (await f.call(`/${post.id}`, 'PATCH', { ...draft, version: 1 })).status,
      ).toBe(409);
      await f.worker.handle(f.project.id, post.id);
      const current = (await repository.getAgentPost(f.project.id, post.id))!;
      const edit = {
        ...draft,
        body: 'A reviewed and edited post.',
        version: current.version,
      };
      expect(
        (await f.call(`/${post.id}`, 'PATCH', edit, undefined, 'post-viewer'))
          .status,
      ).toBe(403);
      expect((await f.call(`/${post.id}`, 'PATCH', edit)).status).toBe(200);
      expect((await f.call(`/${post.id}`, 'PATCH', edit)).status).toBe(409);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.content?.body,
      ).toBe(edit.body);
    });

    it('persists provider failures and only retries on an explicit new request', async () => {
      const f = await setup();
      const post = await f.create();
      f.extract.mockRejectedValueOnce(
        new ProviderError(
          'openai_http_429',
          'OpenAI request failed (429).',
          true,
        ),
      );
      await f.worker.handle(f.project.id, post.id);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.status,
      ).toBe('failed');
      await f.worker.handle(f.project.id, post.id);
      expect(f.extract).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.call(
            `/${post.id}/retry`,
            'POST',
            undefined,
            'explicit-retry-001',
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await f.call(
            `/${post.id}/retry`,
            'POST',
            undefined,
            'explicit-retry-001',
          )
        ).status,
      ).toBe(202);
      await f.worker.handle(f.project.id, post.id);
      expect(f.extract).toHaveBeenCalledTimes(2);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.status,
      ).toBe('draft');
      expect(
        (
          await f.call(
            `/${post.id}/retry`,
            'POST',
            undefined,
            'explicit-retry-001',
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await f.call(
            `/${post.id}/retry`,
            'POST',
            undefined,
            'different-retry-001',
          )
        ).status,
      ).toBe(409);
    });

    it('recovers a saved receipt after a database interruption without another paid call', async () => {
      const f = await setup();
      const post = await f.create();
      const original = repository.saveAgentPost.bind(repository);
      const save = vi
        .spyOn(repository, 'saveAgentPost')
        .mockImplementation(async (job, version) => {
          if (job.status === 'draft') {
            save.mockImplementation(original);
            throw new Error('Test DB unavailable');
          }
          return original(job, version);
        });
      await expect(f.worker.handle(f.project.id, post.id)).rejects.toThrow(
        'Test DB unavailable',
      );
      f.advance();
      await f.worker.handle(f.project.id, post.id);
      save.mockRestore();
      expect(f.extract).toHaveBeenCalledTimes(1);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.status,
      ).toBe('draft');
    });

    it('does not repeat an uncertain paid call when the response checkpoint is missing', async () => {
      const f = await setup();
      const post = await f.create();
      vi.spyOn(f.runtime.artifacts, 'put').mockRejectedValueOnce(
        new Error('Test artifact store unavailable'),
      );
      await expect(f.worker.handle(f.project.id, post.id)).rejects.toThrow(
        'Test artifact store unavailable',
      );
      f.advance();
      await f.worker.handle(f.project.id, post.id);
      expect(f.extract).toHaveBeenCalledTimes(1);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.error?.code,
      ).toBe('agent_call_uncertain');
    });

    it('bounds infrastructure retries before a paid call can start', async () => {
      const f = await setup();
      const post = await f.create();
      const unavailable = new AgentPostEngine(f.runtime, async () => {
        throw new Error('Test credential store unavailable');
      });
      // Use the same controllable clock as the normal worker by expiring each lease.
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = (await repository.getAgentPost(f.project.id, post.id))!;
        if (current.leaseExpiresAt)
          await repository.saveAgentPost(
            {
              ...current,
              leaseExpiresAt: '2000-01-01T00:00:00Z',
              version: current.version + 1,
            },
            current.version,
          );
        await expect(unavailable.handle(f.project.id, post.id)).rejects.toThrow(
          'Test credential store unavailable',
        );
      }
      const current = (await repository.getAgentPost(f.project.id, post.id))!;
      await repository.saveAgentPost(
        {
          ...current,
          leaseExpiresAt: '2000-01-01T00:00:00Z',
          version: current.version + 1,
        },
        current.version,
      );
      await unavailable.handle(f.project.id, post.id);
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.error?.code,
      ).toBe('agent_recovery_exhausted');
      expect(f.extract).not.toHaveBeenCalled();
    });

    it('reconciles queued jobs and routes dead letters through the scanner', async () => {
      const f = await setup();
      const post = await f.create();
      f.runtime.queue.messages.length = 0;
      const scanner = new Scanner({
        ...f.runtime,
        provider: new FixtureProvider(),
        agents: f.worker,
      });
      await scanner.handle({ kind: 'reconcile' });
      expect(f.runtime.queue.messages).toContainEqual({
        kind: 'agent-post',
        projectId: f.project.id,
        postId: post.id,
      });
      await scanner.handleDeadLetter({
        kind: 'agent-post',
        projectId: f.project.id,
        postId: post.id,
      });
      expect(
        (await repository.getAgentPost(f.project.id, post.id))?.status,
      ).toBe('failed');
    });
  },
);

describe('agent generation contracts', () => {
  const job = {
    ...input,
    channel: 'x',
    model: 'existing-model',
    context: {
      brand: { name: 'Northstar' },
      brandbook: book,
      language: 'en',
      country: 'US',
    },
  } as AgentPostJob;
  it('uses structured outputs without web tools or changing the configured model', () => {
    const body = extractionBody(agentGenerationRequest(job));
    expect(body.model).toBe('existing-model');
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('tools');
    expect(body.text).toMatchObject({
      format: { type: 'json_schema', strict: true, name: 'citevia_agent_post' },
    });
    expect(agentGenerationRequest(job).schema).toMatchObject({
      properties: {
        body: { pattern: '^[\\s\\S]{1,220}$' },
        hashtags: { maxItems: 2 },
      },
    });
  });
  it('rejects refusals, incomplete output, invalid JSON, and oversized channel content', () => {
    expect(() =>
      parseAgentContent(job, {
        ...receipt(),
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal' }] }],
        },
      }),
    ).toThrow('refused');
    expect(() =>
      parseAgentContent(job, {
        ...receipt(),
        response: { status: 'incomplete' },
      }),
    ).toThrow('complete');
    expect(() =>
      parseAgentContent(
        job,
        receipt({ title: 'Title', body: 'a'.repeat(281), hashtags: [] }),
      ),
    ).toThrow('length limit');
    expect(() =>
      parseAgentContent(
        job,
        receipt({
          title: 'Title',
          body: 'Short',
          hashtags: [],
          secret: 'extra',
        }),
      ),
    ).toThrow();
    expect(parseAgentContent(job, receipt())).toEqual(draft);
  });
  it('accepts only identifier-based queue messages', () => {
    expect(
      parseScanMessage({
        kind: 'agent-post',
        projectId: 'account-a',
        postId: 'post-a',
      }),
    ).toEqual({ kind: 'agent-post', projectId: 'account-a', postId: 'post-a' });
    expect(() =>
      parseScanMessage({
        kind: 'agent-post',
        projectId: 'account-a',
        postId: 'post-a',
        context: {},
      }),
    ).toThrow();
  });
});
