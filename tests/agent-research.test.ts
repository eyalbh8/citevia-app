import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_AGENT_CONTENT_MODEL, type AgentPostJob } from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
} from '@citevia/storage';
import {
  blogResearchBrief,
  blogResearchRequest,
} from '../apps/scanner/src/agent-research.js';
import {
  finalizeSocialCopy,
  verifiedBlogLinks,
  agentGenerationRequest,
} from '../apps/scanner/src/agent-generation.js';
import { AgentPostEngine } from '../apps/scanner/src/agent-posts.js';
import {
  type ProviderReceipt,
  type AnswerRequest,
} from '../apps/scanner/src/provider.js';
import { newProject } from './fixtures/scanner.js';

const project = newProject({ id: 'link-research' });
const job = (channel: AgentPostJob['channel'] = 'blog'): AgentPostJob => ({
  id: 'post',
  projectId: project.id,
  channel,
  topic: 'Legacy topic',
  prompt: 'Where can beginners find tutorials or webinars?',
  status: 'queued',
  content: null,
  createdAt: '2026-10-22T09:00:00Z',
  updatedAt: '2026-10-22T09:00:00Z',
  version: 1,
  model: 'configured-model',
  error: null,
  createdBy: 'owner',
  fingerprint: 'test',
  generation: 1,
  attempts: 0,
  context: {
    brand: { ...project.brand, aliases: ['North Star', 'NSCloud'] },
    language: 'en',
    country: 'US',
  },
});
function searchReceipt(
  sources: { url: string; title: string }[],
  text = 'Research answering the selected question.',
): ProviderReceipt {
  return {
    receivedAt: '2026-10-22T09:00:00Z',
    requestId: 'test',
    response: {
      status: 'completed',
      output: [
        { type: 'web_search_call', action: { sources } },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text,
              annotations: sources.map((source) => ({
                type: 'url_citation',
                ...source,
                start_index: 0,
                end_index: 8,
              })),
            },
          ],
        },
      ],
    },
  };
}
const external = searchReceipt([
  {
    url: 'https://education.example.org/tutorials',
    title: 'Independent learning guide',
  },
]);
const internal = searchReceipt([
  {
    url: 'https://northstar.example/education/webinars',
    title: 'Beginner webinars',
  },
]);
const copyReceipt = (copy: unknown): ProviderReceipt => ({
  receivedAt: '2026-10-22T09:00:00Z',
  requestId: 'copy',
  response: {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(copy) }],
      },
    ],
  },
});
const image = {
  url: 'https://images.unsplash.com/photo-test',
  alt: 'Learning',
  photoId: 'test',
  photographer: 'Author',
  photographerUrl: 'https://unsplash.com/@author',
  photoUrl: 'https://unsplash.com/photos/test',
  downloadLocation: 'https://api.unsplash.com/photos/test/download',
};

describe('stronger content model request compatibility', () => {
  it('uses low reasoning for Astra in writing, social copy and both research searches', () => {
    for (const channel of ['facebook', 'instagram', 'x', 'blog'] as const) {
      const request = agentGenerationRequest({
        ...job(channel),
        model: DEFAULT_AGENT_CONTENT_MODEL,
      });
      expect(request).toMatchObject({
        model: DEFAULT_AGENT_CONTENT_MODEL,
        reasoningEffort: 'low',
        requestTimeoutMs: 180_000,
      });
    }
    for (const stage of [undefined, 'links'] as const)
      expect(
        blogResearchRequest(
          { ...job(), model: DEFAULT_AGENT_CONTENT_MODEL, stage },
          new Date(),
        ),
      ).toMatchObject({
        model: DEFAULT_AGENT_CONTENT_MODEL,
        reasoningEffort: 'low',
      });
  });
  it('keeps queued legacy GPT-4.1 requests compatible without adding unsupported reasoning parameters', () => {
    const legacy = { ...job(), model: 'gpt-4.1-2025-04-14' };
    expect(agentGenerationRequest(legacy)).not.toHaveProperty(
      'reasoningEffort',
    );
    expect(agentGenerationRequest(legacy)).not.toHaveProperty(
      'requestTimeoutMs',
    );
    expect(blogResearchRequest(legacy, new Date())).not.toHaveProperty(
      'reasoningEffort',
    );
  });
});

describe('web-searched blog links', () => {
  it('searches externally, then restricts a separate internal search to account domains', () => {
    const first = blogResearchRequest(job(), new Date('2026-10-22T09:00:00Z'));
    expect(first.allowedDomains).toBeUndefined();
    const next = blogResearchRequest(
      { ...job(), stage: 'links' },
      new Date('2026-10-22T09:00:00Z'),
    );
    expect(next.allowedDomains).toEqual(['northstar.example']);
    expect(JSON.parse(next.prompt)).toMatchObject({
      question: job().prompt,
      accountWebsite: 'https://northstar.example/',
    });
    expect(next.instructions).toContain('Do not invent URL paths');
  });
  it('passes discovered deep pages and external citations to writing without requiring brandbook evidence', () => {
    const brief = blogResearchBrief(
      { ...job(), researchVersion: 2 },
      external,
      internal,
    );
    expect(brief.internalLinks[0]).toMatchObject({
      url: 'https://northstar.example/education/webinars',
      kind: 'internal',
    });
    expect(brief.externalLinks).toEqual([
      {
        url: 'https://education.example.org/tutorials',
        title: 'Independent learning guide',
        kind: 'external',
      },
    ]);
    const body =
      'Try [beginner webinars](https://northstar.example/education/webinars) and compare the [independent learning guide](https://education.example.org/tutorials).';
    expect(verifiedBlogLinks(job(), body, brief.sources)).toBe(body);
  });
  it('keeps each category even when external sources fill their cap, rejecting forged internal domains and generated URLs', () => {
    const outside = searchReceipt(
      Array.from({ length: 6 }, (_, i) => ({
        url: 'https://sources.example.org/guide-' + i,
        title: 'Guide ' + i,
      })),
    );
    const inside = searchReceipt(
      [
        {
          url: 'https://northstar.example.attacker.org/fake',
          title: 'Forged internal link',
        },
        {
          url: 'https://northstar.example/education/webinars',
          title: 'Beginner webinars',
        },
      ],
      'Use https://northstar.example/invented-path for beginners.',
    );
    const brief = blogResearchBrief(
      { ...job(), researchVersion: 2 },
      outside,
      inside,
    );
    expect(brief.externalLinks).toHaveLength(3);
    expect(brief.internalLinks[0].url).toBe(
      'https://northstar.example/education/webinars',
    );
    expect(brief.sources.map((item) => item.url).join(' ')).not.toMatch(
      /attacker|invented-path/,
    );
  });
  it('accepts native consulted sources when the search returned no inline annotations, falling back to the known homepage if no internal pages were indexed', () => {
    const noCitations = searchReceipt([
      { url: 'https://northstar.example/education', title: 'Education' },
    ]);
    const message = noCitations.response.output![1] as {
      content: { annotations: unknown[] }[];
    };
    message.content[0].annotations = [];
    expect(
      blogResearchBrief(job(), external, noCitations).internalLinks[0].url,
    ).toBe('https://northstar.example/education');
    const empty = blogResearchBrief(
      { ...job(), researchVersion: 2 },
      external,
      searchReceipt([], 'No relevant indexed pages found.'),
    );
    expect(empty.internalLinks).toEqual([
      {
        url: 'https://northstar.example/',
        title: 'Northstar',
        kind: 'internal',
      },
    ]);
  });
  it('excludes preview and staging pages from discovered link catalogs', () => {
    const sources = searchReceipt([
      {
        url: 'https://www.preview.forex.com/academy',
        title: 'Preview academy',
      },
      {
        url: 'https://staging.northstar.example/education',
        title: 'Staging education',
      },
      {
        url: 'https://education.example.org/production',
        title: 'Public learning guide',
      },
    ]);
    const brief = blogResearchBrief(job(), sources, internal);
    expect(brief.externalLinks).toEqual([
      {
        url: 'https://education.example.org/production',
        title: 'Public learning guide',
        kind: 'external',
      },
    ]);
    expect(
      brief.sources.some((source) => /preview|staging/.test(source.url)),
    ).toBe(false);
  });
  it('requires actual search execution and refuses a lost internal checkpoint for new jobs', () => {
    const noSearch = {
      ...external,
      response: {
        ...external.response,
        output: external.response.output!.slice(1),
      },
    };
    expect(() => blogResearchBrief(job(), noSearch, internal)).toThrow(
      'did not run web search',
    );
    expect(() =>
      blogResearchBrief({ ...job(), researchVersion: 2 }, external, null),
    ).toThrow('internal-link web search');
  });
  it('recovers the internal search checkpoint without repeating either paid web search', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const post = job();
    await repository.reserveAgentPost(post, null);
    let now = new Date('2026-10-22T09:00:00Z');
    const answer = vi.fn(async (request: AnswerRequest) =>
        request.allowedDomains ? internal : external,
      ),
      extract = vi.fn();
    const engine = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ answer, extract }),
      () => now,
      async () => ({ select: vi.fn(), track: vi.fn() }),
    );
    await engine.handle(project.id, post.id);
    expect((await repository.getAgentPost(project.id, post.id))?.stage).toBe(
      'links',
    );
    const original = repository.saveAgentPost.bind(repository);
    const save = vi
      .spyOn(repository, 'saveAgentPost')
      .mockImplementation(async (next, version) => {
        if (next.stage === 'write') {
          save.mockImplementation(original);
          throw new Error('database interrupted');
        }
        return original(next, version);
      });
    await expect(engine.handle(project.id, post.id)).rejects.toThrow(
      'database interrupted',
    );
    now = new Date('2026-10-22T09:05:00Z');
    await engine.handle(project.id, post.id);
    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[1][0].allowedDomains).toEqual([
      'northstar.example',
    ]);
    expect((await repository.getAgentPost(project.id, post.id))?.stage).toBe(
      'write',
    );
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('social captions without account branding', () => {
  it.each(['facebook', 'instagram', 'x'] as const)(
    'prevents brand names, aliases and branded hashtags for %s',
    (channel) => {
      for (const body of [
        'Northstar has beginner webinars.',
        'NORTH STAR has beginner webinars.',
        'NSCloud has beginner webinars.',
        'Learn with @northstar.',
        '#NorthstarTips',
      ])
        expect(() =>
          finalizeSocialCopy(job(channel), {
            title: 'Beginner learning',
            body,
            hashtags: [],
          }),
        ).toThrow('brand name');
      expect(() =>
        finalizeSocialCopy(job(channel), {
          title: 'Learn with Northstar',
          body: 'Choose a useful tutorial.',
          hashtags: [],
        }),
      ).toThrow('brand name');
      expect(() =>
        finalizeSocialCopy(job(channel), {
          title: 'Learning resources',
          body: 'Choose a useful tutorial.',
          hashtags: ['#NSCloudLearning'],
        }),
      ).toThrow('brand name');
    },
  );
  it('keeps the Facebook website and Instagram bio CTA while accepting neutral answers to branded questions', () => {
    const post = {
      ...job('facebook'),
      prompt: 'Where can I find Northstar tutorials?',
    };
    const copy = {
      title: 'Beginner tutorials',
      body: 'Start with a beginner guide. Then try a webinar.',
      hashtags: ['#Learning'],
    };
    expect(finalizeSocialCopy(post, copy).body).toContain(
      'https://northstar.example/',
    );
    expect(
      finalizeSocialCopy({ ...post, channel: 'instagram' }, copy).body,
    ).toContain('Link in bio.');
    expect(
      (agentGenerationRequest(post).input as { prompt: string }).prompt,
    ).toBe(post.prompt);
    expect(agentGenerationRequest(post).instructions).toContain(
      'Do not mention the account brand name',
    );
    expect(() =>
      finalizeSocialCopy(job('reddit'), {
        ...copy,
        body: 'I work with Northstar. Start with a beginner guide.',
      }),
    ).not.toThrow();
  });
  it('revises a branded caption once, checkpointing the revision before recovering a database interruption', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const post = job('facebook');
    await repository.reserveAgentPost(post, null);
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        copyReceipt({
          title: 'Learn with Northstar',
          body: 'Northstar helps you learn.',
          hashtags: ['#Northstar'],
        }),
      )
      .mockResolvedValueOnce(
        copyReceipt({
          title: 'Beginner learning',
          body: 'Start with a useful tutorial. Follow up with a webinar.',
          hashtags: ['#Learning'],
        }),
      );
    const select = vi.fn(async () => image),
      track = vi.fn(async () => {});
    let now = new Date('2026-10-22T09:00:00Z');
    const engine = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ answer: vi.fn(), extract }),
      () => now,
      async () => ({ select, track }),
    );
    await engine.handle(project.id, post.id);
    expect((await repository.getAgentPost(project.id, post.id))?.stage).toBe(
      'social-repair',
    );
    expect(select).not.toHaveBeenCalled();
    const original = repository.saveAgentPost.bind(repository);
    const save = vi
      .spyOn(repository, 'saveAgentPost')
      .mockImplementation(async (next, version) => {
        if (next.status === 'draft') {
          save.mockImplementation(original);
          throw new Error('database interrupted');
        }
        return original(next, version);
      });
    await expect(engine.handle(project.id, post.id)).rejects.toThrow(
      'database interrupted',
    );
    now = new Date('2026-10-22T09:05:00Z');
    await engine.handle(project.id, post.id);
    const saved = (await repository.getAgentPost(project.id, post.id))!;
    expect(saved.status).toBe('draft');
    expect(saved.content!.body).toBe(
      'Start with a useful tutorial.\n\nFollow up with a webinar.\n\nhttps://northstar.example/',
    );
    expect(extract).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });
  it('stops after one revision if the model still includes branding', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const post = job('x');
    await repository.reserveAgentPost(post, null);
    const extract = vi.fn(async () =>
      copyReceipt({
        title: 'Northstar learning',
        body: 'Try Northstar tutorials.',
        hashtags: [],
      }),
    );
    const engine = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ answer: vi.fn(), extract }),
      () => new Date('2026-10-22T09:00:00Z'),
      async () => ({ select: vi.fn(), track: vi.fn() }),
    );
    await engine.handle(project.id, post.id);
    await engine.handle(project.id, post.id);
    await engine.handle(project.id, post.id);
    expect(await repository.getAgentPost(project.id, post.id)).toMatchObject({
      status: 'failed',
      error: { code: 'agent_brand_mention' },
    });
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
