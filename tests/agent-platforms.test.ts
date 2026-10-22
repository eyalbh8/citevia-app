import { describe, it, expect, vi } from 'vitest';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
} from '@citevia/storage';
import {
  AGENT_CHANNELS,
  agentPostText,
  agentCopyValid,
  refreshAgentBlog,
  blogSeoChecks,
  type Brandbook,
  type AgentPostJob,
  type AgentImage,
  type BlogDraft,
} from '@citevia/core';
import { AgentPostEngine } from '../apps/scanner/src/agent-posts.js';
import {
  agentGenerationRequest,
  parseAgentContent,
  parseBlogDraft,
  finalizeSocialCopy,
  verifiedBlogLinks,
} from '../apps/scanner/src/agent-generation.js';
import { AGENT_PROMPTS } from '../apps/scanner/src/agent-prompts.js';
import { UnsplashImages } from '../apps/scanner/src/agent-images.js';
import type { ProviderReceipt } from '../apps/scanner/src/provider.js';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { readFile } from 'node:fs/promises';
import { newProject } from './fixtures/scanner.js';

const project = newProject({ id: 'platform-account' });
const post = (channel: AgentPostJob['channel'] = 'blog'): AgentPostJob => ({
  id: 'platform-post',
  projectId: project.id,
  channel,
  topic: 'Reporting',
  prompt: 'How do I choose reporting metrics?',
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
  context: { brand: project.brand, language: 'en', country: 'US' },
});
const image: AgentImage = {
  url: 'https://images.unsplash.com/photo-test',
  alt: 'Reporting',
  photoId: 'photo-test',
  photographer: 'Photo Author',
  photographerUrl:
    'https://unsplash.com/@author?utm_source=citevia&utm_medium=referral',
  photoUrl:
    'https://unsplash.com/photos/photo-test?utm_source=citevia&utm_medium=referral',
  downloadLocation:
    'https://api.unsplash.com/photos/photo-test/download?ixid=retain-me',
};
const example = (id: string): NonNullable<BlogDraft['examples']>[number] => ({
  id,
  title: 'Example reporting decisions',
  caption: 'Choose a metric that answers the decision.',
  columns: ['Question', 'Useful metric'],
  rows: [
    ['Retention', 'Returning customers'],
    ['Acquisition', 'Qualified leads'],
  ],
});
const blog: BlogDraft = {
  seoTitle: 'Reporting metrics: a practical guide for your team',
  metaDescription:
    'Choose reporting metrics that answer real business questions. Learn a simple process for selecting useful measures and reviewing them with your team.',
  slug: 'reporting-metrics-guide',
  focusKeyphrase: 'reporting metrics',
  imageSearchQuery: 'business analytics dashboard',
  imageAlt: 'Reporting metrics planning on a desk',
  faqs: [1, 2, 3].map((number) => ({
    question: 'Question ' + number + '?',
    answer: 'A useful answer with enough context.',
  })),
  examples: [example('example-1'), example('example-2')],
};
const copy = {
  title: 'Choosing useful reporting metrics',
  body: 'Reporting metrics answer a clear question.\n\n## Reporting metrics in practice\n\n[[example-1]]\n\nUse a measure you can act on.\n\n[[example-2]]\n\n[Northstar reporting tools](https://northstar.example/)\n\nUse the [primary reporting guidance](https://example.org/primary) to evaluate each metric.',
  hashtags: [] as string[],
  blog,
};
const receipt = (value: unknown): ProviderReceipt => ({
  response: {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(value) }],
      },
    ],
  },
  requestId: 'test',
  receivedAt: '2026-10-22T09:00:00Z',
});
const researchReceipt: ProviderReceipt = {
  response: {
    status: 'completed',
    output: [
      {
        type: 'web_search_call',
        action: {
          sources: [
            { url: 'https://example.org/primary', title: 'Primary source' },
          ],
        },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Primary source research for reporting metrics.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.org/primary',
                title: 'Primary source',
                start_index: 0,
                end_index: 14,
              },
            ],
          },
        ],
      },
    ],
  },
  requestId: 'research-test',
  receivedAt: '2026-10-22T09:00:00Z',
};

describe('platform-specific generation', () => {
  it('sends only the selected platform brief and the saved account context', () => {
    expect(new Set(Object.values(AGENT_PROMPTS)).size).toBe(6);
    for (const channel of AGENT_CHANNELS) {
      const request = agentGenerationRequest(post(channel));
      expect(request.instructions).toBe(AGENT_PROMPTS[channel]);
      expect(request.input).toMatchObject({
        prompt: post().prompt,
        website: 'https://northstar.example/',
      });
    }
    expect(agentGenerationRequest(post()).input).toMatchObject({
      requiredAccountLink: {
        url: 'https://northstar.example/',
        markdown: '[Northstar](https://northstar.example/)',
      },
    });
    expect(agentGenerationRequest(post()).input).not.toHaveProperty('topic');
    expect(agentGenerationRequest(post('x')).instructions).not.toContain(
      'Facebook',
    );
    expect(agentGenerationRequest(post('facebook')).instructions).toContain(
      'creative manager',
    );
    expect(agentGenerationRequest(post('instagram')).instructions).toContain(
      'Link in bio',
    );
  });
  it('enforces the complete X character budget, including CJK and hashtags', () => {
    const content = { title: 'Metadata', body: 'a'.repeat(280), hashtags: [] };
    expect(parseAgentContent(post('x'), receipt(content))).toEqual(content);
    expect(() =>
      parseAgentContent(
        post('x'),
        receipt({ ...content, hashtags: ['#Extra'] }),
      ),
    ).toThrow('length limit');
    expect(agentCopyValid('x', { ...content, body: '界'.repeat(141) })).toBe(
      false,
    );
    expect(agentCopyValid('x', { ...content, body: '界'.repeat(140) })).toBe(
      true,
    );
  });
  it('adds the verified account website to Facebook and the bio CTA to Instagram', () => {
    const content = {
      title: 'Title',
      body: 'Choose one useful measure. https://invented.example/',
      hashtags: [],
    };
    expect(finalizeSocialCopy(post('facebook'), content).body).toBe(
      'Choose one useful measure.\n\nhttps://northstar.example/',
    );
    expect(finalizeSocialCopy(post('instagram'), content).body).toBe(
      'Choose one useful measure.\n\nLink in bio.',
    );
    expect(
      finalizeSocialCopy(post('instagram'), {
        ...content,
        body: 'Read more. Link in bio.',
      }).body,
    ).toBe('Read more.\n\nLink in bio.');
    const missing = post('facebook');
    missing.context.brand = { ...missing.context.brand, domains: [] };
    expect(() => finalizeSocialCopy(missing, content)).toThrow(
      'account website',
    );
  });
});

describe('Unsplash API selection', () => {
  const photo = {
    id: image.photoId,
    urls: { regular: image.url },
    links: {
      html: 'https://unsplash.com/photos/photo-test',
      download_location: image.downloadLocation,
    },
    user: { name: image.photographer, username: 'author' },
  };
  it.each(AGENT_CHANNELS)(
    'hotlinks and credits a real API result for %s, then tracks the selected download',
    async (channel) => {
      const request = vi.fn(async () => Response.json({ results: [photo] }));
      const api = new UnsplashImages('secret-test', request as typeof fetch);
      const result = await api.select(
        post(channel),
        'analytics dashboard',
        'Reporting',
      );
      expect(result).toEqual(image);
      const [url, options] = request.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).not.toContain('secret-test');
      expect(options.headers).toMatchObject({
        Authorization: 'Client-ID secret-test',
      });
      expect(new URL(url).searchParams.get('orientation')).toBe(
        channel === 'instagram'
          ? 'squarish'
          : channel === 'pinterest'
            ? 'portrait'
            : 'landscape',
      );
      await api.track(result);
      expect((request.mock.calls[1] as unknown as [string])[0]).toBe(
        image.downloadLocation,
      );
    },
  );
  it('skips reserved candidates and searches the next page rather than reusing a photo', async () => {
    const request = vi.fn(async (url: string) =>
      Response.json({
        total_pages: 2,
        results:
          new URL(url).searchParams.get('page') === '1'
            ? Array.from({ length: 30 }, (_, id) => ({
                ...photo,
                id: 'used-' + id,
              }))
            : [{ ...photo, id: 'fresh' }],
      }),
    );
    const claim = vi.fn(
      async (candidate: AgentImage) => candidate.photoId === 'fresh',
    );
    const api = new UnsplashImages('test', request as typeof fetch);
    const selected = await api.select(
      post('facebook'),
      'analytics',
      'Alt',
      claim,
    );
    expect(selected.photoId).toBe('fresh');
    expect(request).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(31);
  });
  it('never substitutes a fabricated image when the API fails or has no results', async () => {
    const empty = new UnsplashImages(
      'test',
      vi.fn(async () => Response.json({ results: [] })) as typeof fetch,
    );
    await expect(empty.select(post(), 'missing', 'Alt')).rejects.toThrow(
      'No matching',
    );
    const failed = new UnsplashImages(
      'test',
      vi.fn(async () => new Response('', { status: 429 })) as typeof fetch,
    );
    await expect(failed.select(post(), 'query', 'Alt')).rejects.toThrow('429');
    const api = new UnsplashImages('test', vi.fn() as unknown as typeof fetch);
    await expect(
      api.track({
        ...image,
        downloadLocation: 'https://attacker.example/photos/photo-test/download',
      }),
    ).rejects.toThrow('invalid download');
  });
});

describe('blog recovery', () => {
  it('recovers a failed stage enqueue without repeating paid research', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const job = post();
    await repository.reserveAgentPost(job, null);
    const answer = vi.fn(async () => researchReceipt),
      extract = vi.fn(async () => receipt(copy));
    const worker = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ answer, extract }),
      () => new Date('2026-10-22T09:00:00Z'),
      async () => ({ select: async () => image, track: async () => {} }),
    );
    vi.spyOn(queue, 'send').mockRejectedValueOnce(
      new Error('Queue temporarily unavailable'),
    );
    await expect(worker.handle(project.id, job.id)).rejects.toThrow(
      'Queue temporarily unavailable',
    );
    expect((await repository.getAgentPost(project.id, job.id))?.stage).toBe(
      'links',
    );
    await worker.reconcile();
    expect(queue.messages).toContainEqual({
      kind: 'agent-post',
      projectId: project.id,
      postId: job.id,
    });
    await worker.handle(project.id, job.id);
    expect(answer).toHaveBeenCalledTimes(2);
    expect(extract).not.toHaveBeenCalled();
    await worker.handle(project.id, job.id);
    expect(answer).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);
  });
  it('recovers a reserved photo even if saving the image checkpoint was interrupted', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const job = post('facebook');
    await repository.reserveAgentPost(job, null);
    await repository.reserveAgentImage(job, image);
    await artifacts.put(
      'projects/' +
        project.id +
        '/agent-posts/' +
        job.id +
        '/generation-1.json',
      receipt({
        title: 'A clear answer',
        body: 'Choose one useful metric. Review it weekly.',
        hashtags: [],
      }),
    );
    const select = vi.fn(),
      track = vi.fn(async () => {}),
      provider = vi.fn();
    const engine = new AgentPostEngine(
      { repository, artifacts, queue },
      provider,
      () => new Date('2026-10-22T09:00:00Z'),
      async () => ({ select, track }),
    );
    await engine.handle(project.id, job.id);
    const saved = (await repository.getAgentPost(project.id, job.id))!;
    expect(saved.status).toBe('draft');
    expect(saved.content?.image).toEqual(image);
    expect(select).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(1);
  });
  it.each(['internal', 'external'] as const)(
    'does not finish a blog missing its %s link after editorial repair',
    async (kind) => {
      const repository = new MemoryRepository(),
        artifacts = new MemoryArtifacts(),
        queue = new MemoryQueue();
      await repository.saveProject(project, null);
      const job = { ...post(), stage: 'repair' as const };
      await repository.reserveAgentPost(job, null);
      const prefix =
        'projects/' + project.id + '/agent-posts/' + job.id + '/generation-1';
      await artifacts.put(prefix + '.json', researchReceipt);
      await artifacts.put(prefix + '-format.json', receipt(copy));
      const broken = {
        ...copy,
        body:
          kind === 'internal'
            ? '[Primary reporting guidance](https://example.org/primary)'
            : '[Northstar reporting tools](https://northstar.example/)',
      };
      const select = vi.fn(),
        track = vi.fn(),
        extract = vi.fn(async () => receipt(broken));
      const engine = new AgentPostEngine(
        { repository, artifacts, queue },
        async () => ({ answer: vi.fn(), extract }),
        () => new Date('2026-10-22T09:00:00Z'),
        async () => ({ select, track }),
      );
      await engine.handle(project.id, job.id);
      expect(await repository.getAgentPost(project.id, job.id)).toMatchObject({
        status: 'failed',
        error: { code: 'agent_blog_links_missing' },
      });
      expect(select).not.toHaveBeenCalled();
    },
  );
  it('reuses final editorial and photo checkpoints after a database interruption', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const job = { ...post(), stage: 'repair' as const };
    await repository.reserveAgentPost(job, null);
    const prefix =
      'projects/' + project.id + '/agent-posts/' + job.id + '/generation-1';
    await artifacts.put(prefix + '.json', researchReceipt);
    await artifacts.put(prefix + '-format.json', receipt(copy));
    const answer = vi.fn(),
      extract = vi.fn(async () => receipt(copy));
    const select = vi.fn(async () => image),
      track = vi.fn(async () => {});
    let now = new Date('2026-10-22T09:00:00Z');
    const worker = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ answer, extract }),
      () => now,
      async () => ({ select, track }),
    );
    const original = repository.saveAgentPost.bind(repository);
    const save = vi
      .spyOn(repository, 'saveAgentPost')
      .mockImplementation(async (post, version) => {
        if (post.status === 'draft') {
          save.mockImplementation(original);
          throw new Error('Database temporarily unavailable');
        }
        return original(post, version);
      });
    await expect(worker.handle(project.id, job.id)).rejects.toThrow(
      'Database temporarily unavailable',
    );
    now = new Date('2026-10-22T09:05:00Z');
    await worker.handle(project.id, job.id);
    expect((await repository.getAgentPost(project.id, job.id))?.status).toBe(
      'draft',
    );
    expect(answer).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });
});

describe('blog article pipeline', () => {
  it('recovers legacy receipts without generating or retaining screenshots', () => {
    const parsed = parseBlogDraft(receipt(copy));
    expect(parsed.blog).not.toHaveProperty('examples');
    expect(parsed.body).not.toContain('[[example-');
    expect(parsed.body).toContain('Use a measure you can act on.');
    const schema = agentGenerationRequest(post()).schema as {
      properties: { blog: { properties: object } };
    };
    expect(schema.properties.blog.properties).not.toHaveProperty('examples');
    expect(() =>
      parseBlogDraft(receipt({ ...copy, hashtags: ['#Wrong'] })),
    ).toThrow('separate FAQs');
  });
  it('writes, formats, repairs SEO once, then saves one hero image, attribution and matching schema', async () => {
    const repository = new MemoryRepository();
    await repository.saveProject(project, null);
    const job = post();
    await repository.reserveAgentPost(job, null);
    const artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    const extract = vi.fn(async () => receipt(copy));
    const select = vi.fn(async () => image),
      track = vi.fn(async () => {});
    const answer = vi.fn(async () => researchReceipt);
    const worker = new AgentPostEngine(
      { repository, artifacts, queue },
      async () => ({ extract, answer }),
      () => new Date('2026-10-22T09:00:00Z'),
      async () => ({ select, track }),
    );
    await worker.handle(project.id, job.id);
    expect((await repository.getAgentPost(project.id, job.id))?.stage).toBe(
      'links',
    );
    expect(answer).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    await worker.handle(project.id, job.id);
    expect((await repository.getAgentPost(project.id, job.id))?.stage).toBe(
      'write',
    );
    expect(answer).toHaveBeenCalledTimes(2);
    expect(extract).not.toHaveBeenCalled();
    await worker.handle(project.id, job.id);
    expect((await repository.getAgentPost(project.id, job.id))?.stage).toBe(
      'format',
    );
    expect(select).not.toHaveBeenCalled();
    await worker.handle(project.id, job.id);
    expect((await repository.getAgentPost(project.id, job.id))?.stage).toBe(
      'repair',
    );
    await worker.handle(project.id, job.id);
    const saved = (await repository.getAgentPost(project.id, job.id))!;
    expect(saved.status).toBe('draft');
    expect(extract).toHaveBeenCalledTimes(3);
    expect(extract.mock.calls[1]).toBeDefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(saved.content?.image).toEqual(image);
    expect(saved.content?.blog?.sources).toEqual([
      {
        url: 'https://example.org/primary',
        title: 'Primary source',
        kind: 'external',
      },
      {
        url: 'https://northstar.example/',
        title: 'Northstar',
        kind: 'internal',
      },
    ]);
    const result = saved.content!.blog!;
    expect(result).not.toHaveProperty('screenshots');
    expect(result).not.toHaveProperty('examples');
    expect(result.articleSchema).toMatchObject({
      '@type': 'BlogPosting',
      headline: copy.title,
    });
    expect(result.articleSchema).not.toHaveProperty('datePublished');
    expect(result.articleSchema).not.toHaveProperty('url');
    expect(result.faqSchema.mainEntity).toEqual(
      blog.faqs.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer },
      })),
    );
    const text = agentPostText('blog', saved.content!);
    expect(text).not.toContain('data:image/png;base64,');
    expect(text.match(/!\[/g)).toHaveLength(1);
    expect(text).toContain('application/ld+json');
    expect(text).not.toContain('[[example-');
    const edited = refreshAgentBlog(saved, {
      ...saved.content!,
      title: 'An updated title',
      body: 'A new introduction.\n\n' + saved.content!.body,
    });
    expect(edited.image).toEqual(image);
    expect(edited.blog?.screenshots).toEqual(result.screenshots);
    expect(edited.blog?.articleSchema.headline).toBe('An updated title');
    expect(edited.blog?.articleSchema.articleBody).toContain(
      'A new introduction',
    );
    expect(
      edited.blog?.checks.find((check) => check.id === 'intro')?.passed,
    ).toBe(false);
  });
});

describe('human editorial copy and supplied links', () => {
  it.each(['facebook', 'instagram', 'pinterest', 'reddit'] as const)(
    'formats %s into readable paragraphs without long dashes',
    (channel) => {
      const result = finalizeSocialCopy(post(channel), {
        title: 'A useful — answer',
        body: 'Choose a useful measure — start with the decision. Review it weekly. Keep the process simple.',
        hashtags: [],
      });
      expect(result.body).toContain(
        'Choose a useful measure, start with the decision.',
      );
      expect(result.body).toContain('\n\n');
      expect(result.body + result.title).not.toMatch(/[\u2012-\u2015]/);
      expect(agentCopyValid(channel, result)).toBe(true);
    },
  );
  it('keeps hashtags in one separate block without duplicating them in the caption', () => {
    const content = finalizeSocialCopy(post('facebook'), {
      title: 'A caption',
      body: 'Choose useful metrics.\n\n#AIsearch #Analytics',
      hashtags: ['#AIsearch', '#Analytics', '#analytics'],
    });
    expect(content.body).toBe(
      'Choose useful metrics.\n\nhttps://northstar.example/',
    );
    expect(content.hashtags).toEqual(['#AIsearch', '#analytics']);
    expect(agentPostText('facebook', content).match(/#AIsearch/g)).toHaveLength(
      1,
    );
  });
  it('rejects a run-on caption rather than presenting it as finished copy', () => {
    expect(() =>
      finalizeSocialCopy(post('facebook'), {
        title: 'A title',
        body: 'word '.repeat(45) + '.',
        hashtags: [],
      }),
    ).toThrow('run-on sentence');
  });
  it('keeps X within 280 characters after punctuation cleanup', () => {
    const result = finalizeSocialCopy(post('x'), {
      title: 'Metadata',
      body: 'Choose useful metrics — then review them.',
      hashtags: ['#Metrics'],
    });
    expect(result.body).toBe('Choose useful metrics, then review them.');
    expect(agentCopyValid('x', result)).toBe(true);
  });
  it('preserves exact account hosts, allows supplied deep links and removes invented or repeated destinations', () => {
    const job = post();
    job.context.brand = {
      ...job.context.brand,
      domains: ['https://app.northstar.example/'],
    };
    job.context.brandbook = {
      evidence: [{ url: 'https://app.northstar.example/guides/metrics' }],
      caseStudies: [],
    } as unknown as Brandbook;
    const body =
      '[Reporting guide](https://app.northstar.example/guides/metrics) and [Primary research](https://example.org/primary). [Duplicate](https://example.org/primary) [Invented](https://example.org/fake) [Click here](https://app.northstar.example/) [https://app.northstar.example/](https://app.northstar.example/) https://invented.example/ <https://example.org/evil>\n\n[ref]: https://bad.example/';
    const clean = verifiedBlogLinks(job, body, [
      { url: 'https://example.org/primary' },
    ]);
    expect(clean).toContain(
      '[Reporting guide](https://app.northstar.example/guides/metrics)',
    );
    expect(clean).toContain('[Primary research](https://example.org/primary)');
    expect(clean.match(/\]\(https:/g)).toHaveLength(2);
    expect(clean).not.toContain('https://invented');
    expect(clean).not.toContain('/fake');
    expect(clean).not.toContain('/evil');
    expect(clean).not.toContain('bad.example');
    const checks = blogSeoChecks(
      copy.title,
      clean,
      blog,
      'en',
      'https://app.northstar.example/',
    );
    expect(
      checks
        .filter((check) =>
          ['internal-link', 'external-link'].includes(check.id),
        )
        .every((check) => check.passed),
    ).toBe(true);
  });
});

describe.each(['memory', 'postgres'] as const)(
  '%s account/channel photo reservations',
  (mode) => {
    it('serializes competing selections, isolates accounts/channels, and recovers the reserved photo', async () => {
      const db = mode === 'postgres' ? await localPostgres() : null;
      const repository = db
        ? new PostgresRepository(db)
        : new MemoryRepository();
      try {
        await repository.saveProject(project, null);
        const first = post('facebook'),
          second = { ...post('facebook'), id: 'second' };
        await repository.reserveAgentPost(first, null);
        await repository.reserveAgentPost(second, null);
        const claims = await Promise.all([
          repository.reserveAgentImage(first, image),
          repository.reserveAgentImage(second, image),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims[0] ? first : second,
          loser = claims[0] ? second : first;
        expect(await repository.reserveAgentImage(winner)).toEqual(image);
        expect(
          await repository.reserveAgentImage(winner, {
            ...image,
            photoId: 'alternative',
          }),
        ).toEqual(image);
        expect(await repository.reserveAgentImage(loser, image)).toBeNull();
        const next = { ...image, photoId: 'unused' };
        expect(await repository.reserveAgentImage(loser, next)).toEqual(next);
        const otherChannel = { ...post('instagram'), id: 'instagram' };
        await repository.reserveAgentPost(otherChannel, null);
        expect(await repository.reserveAgentImage(otherChannel, image)).toEqual(
          image,
        );
        const otherProject = { ...project, id: 'other-account' };
        await repository.saveProject(otherProject, null);
        const otherAccount = {
          ...post('facebook'),
          projectId: otherProject.id,
        };
        await repository.reserveAgentPost(otherAccount, null);
        expect(await repository.reserveAgentImage(otherAccount, image)).toEqual(
          image,
        );
        const retry = { ...winner, generation: 2, version: 2 };
        await repository.saveAgentPost(retry, 1);
        expect(await repository.reserveAgentImage(retry, image)).toBeNull();
        expect(
          await repository.reserveAgentImage(retry, {
            ...image,
            photoId: 'retry-unused',
          }),
        ).toMatchObject({ photoId: 'retry-unused' });
      } finally {
        await db?.close();
      }
    }, 30000);
    it('excludes photos already present in legacy saved drafts', async () => {
      const db = mode === 'postgres' ? await localPostgres() : null;
      const repository = db
        ? new PostgresRepository(db)
        : new MemoryRepository();
      try {
        await repository.saveProject(project, null);
        const legacy = {
          ...post('facebook'),
          status: 'draft' as const,
          content: {
            title: 'Legacy',
            body: 'Legacy body.',
            hashtags: [],
            image,
          },
        };
        await repository.reserveAgentPost(legacy, null);
        if (db) {
          const migration = await readFile(
            'database/migrations/010_agent_images.sql',
            'utf8',
          );
          await db.exec(migration.slice(migration.indexOf('INSERT INTO')));
        }
        const fresh = { ...post('facebook'), id: 'fresh' };
        await repository.reserveAgentPost(fresh, null);
        expect(await repository.reserveAgentImage(fresh, image)).toBeNull();
      } finally {
        await db?.close();
      }
    }, 30000);
  },
);
