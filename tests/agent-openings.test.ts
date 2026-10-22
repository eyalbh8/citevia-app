import { describe, it, expect, vi } from 'vitest';
import {
  hasConversationalOpening,
  blogSeoChecks,
  type AgentPostJob,
  type BlogDraft,
} from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
} from '@citevia/storage';
import { AgentPostEngine } from '../apps/scanner/src/agent-posts.js';
import {
  AGENT_PROMPTS,
  BLOG_FORMAT_PROMPT,
} from '../apps/scanner/src/agent-prompts.js';
import { assertStandalonePost } from '../apps/scanner/src/agent-generation.js';
import type {
  ProviderReceipt,
  ResponseProvider,
} from '../apps/scanner/src/provider.js';
import { newProject } from './fixtures/scanner.js';

const project = newProject({ id: 'standalone-posts' });
const post = (channel: AgentPostJob['channel']): AgentPostJob => ({
  id: 'post-' + channel,
  projectId: project.id,
  channel,
  topic: 'Legacy metadata',
  prompt: 'Can beginners learn through tutorials and webinars?',
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
const image = {
  url: 'https://images.unsplash.com/photo-test',
  alt: 'Learning',
  photoId: 'test',
  photographer: 'Author',
  photographerUrl: 'https://unsplash.com/@author',
  photoUrl: 'https://unsplash.com/photos/test',
  downloadLocation: 'https://api.unsplash.com/photos/test/download',
};
const copy = (body: string) => ({
  title: 'Build a useful learning plan',
  body,
  hashtags: [],
});
const metadata: BlogDraft = {
  seoTitle: 'Learning resources: a practical guide for beginners',
  metaDescription:
    'Choose learning resources that help you practice one useful skill. Start with beginner tutorials, use webinars for context, and review what you learn.',
  slug: 'learning-resources-guide',
  focusKeyphrase: 'learning resources',
  imageSearchQuery: 'learning study notebook',
  imageAlt: 'Learning resources on a desk',
  faqs: [1, 2, 3].map((n) => ({
    question: 'Question ' + n + '?',
    answer: 'Yes, when the material supports your learning goals.',
  })),
};
const blogCopy = (opening: string) => ({
  ...copy(
    opening +
      '\n\n## Learning resources in practice\n\nUse the [beginner resource library](https://northstar.example/) and the [independent education guide](https://education.example.org/guidance).',
  ),
  blog: metadata,
});
const research: ProviderReceipt = {
  response: {
    status: 'completed',
    output: [
      {
        type: 'web_search_call',
        action: {
          sources: [
            {
              url: 'https://education.example.org/guidance',
              title: 'Independent education guide',
            },
          ],
        },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Use public beginner learning resources.',
            annotations: [],
          },
        ],
      },
    ],
  },
  requestId: 'research',
  receivedAt: '2026-10-22T09:00:00Z',
};

async function setup(job: AgentPostJob, extract: ResponseProvider['extract']) {
  const repository = new MemoryRepository(),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  await repository.saveProject(project, null);
  await repository.reserveAgentPost(job, null);
  const select = vi.fn(async () => image),
    track = vi.fn(async () => {});
  const engine = new AgentPostEngine(
    { repository, artifacts, queue },
    async () => ({ answer: vi.fn(), extract }),
    () => new Date('2026-10-22T09:00:00Z'),
    async () => ({ select, track }),
  );
  return { repository, artifacts, queue, select, track, engine };
}

describe('standalone creative post openings', () => {
  it.each([
    'Yes, tutorials can help beginners.',
    'No, you do not need to start with advanced lessons.',
    'Sure! Start with a beginner tutorial.',
    'Absolutely. A webinar can help.',
    'Of course, beginners can learn.',
    'Great question! Start with tutorials.',
    'Thanks for asking. Start small.',
    'Let me explain how this works.',
    'To answer your question, start small.',
    'It depends on your goals.',
    'Here is the answer: choose a tutorial.',
    "Here's a creative post about learning.",
    'The short answer is yes.',
    '**Yes**, tutorials can help.',
    '✅ **Absolutely!** Build a learning plan.',
    '> **Sure**, start small.',
    '1. Yes, start small.',
    '[Yes](https://example.org/), begin here.',
    '## A better learning plan\n\nYes, tutorials can help.',
    '**TL;DR:** Yes, start with tutorials.',
    'כן, כדאי להתחיל במדריך.',
    'Sí, empieza con un tutorial.',
  ])('rejects reply-style opener: %s', (body) => {
    expect(hasConversationalOpening(body, true)).toBe(true);
    expect(() => assertStandalonePost(copy(body))).toThrow('chat reply');
  });
  it.each([
    'A useful lesson turns one unfamiliar term into a skill you can explain.',
    'No shortcuts to better reporting: start with one clear question.',
    'No-nonsense learning starts with a practical example.',
    'Yesterday’s notes become more useful when you put them into practice.',
    'Surely the strongest lesson is one you can apply.',
    'Good news: a simple practice plan can make learning easier.',
    'Build a learning plan.\n\nYes, a webinar can be part of it.',
    '## Start with a practical skill\n\nOne useful tutorial beats a folder full of unread notes.',
    '**TL;DR:** Start with a practical skill, then review it.',
  ])('accepts substantive editorial opener: %s', (body) => {
    expect(hasConversationalOpening(body, true)).toBe(false);
    expect(() => assertStandalonePost(copy(body))).not.toThrow();
  });
  it('checks titles and includes the standalone rule in every channel and blog revision brief', () => {
    expect(() =>
      assertStandalonePost({
        title: 'Yes, beginners can learn',
        body: 'A clear practice plan builds useful skills.',
      }),
    ).toThrow('chat reply');
    for (const prompt of [
      ...Object.values(AGENT_PROMPTS),
      BLOG_FORMAT_PROMPT,
    ]) {
      expect(prompt).toContain('standalone published post');
      expect(prompt).toContain('first one or two sentences');
      expect(prompt).toContain('For yes/no questions');
    }
  });
  it('adds editorial feedback for blog chat openings without banning natural FAQ answers', () => {
    const bad = blogCopy('Yes, learning resources can help beginners.');
    expect(
      blogSeoChecks(
        bad.title,
        bad.body,
        bad.blog,
        'en',
        'https://northstar.example/',
      ).find((check) => check.id === 'standalone-opening')?.passed,
    ).toBe(false);
    const good = blogCopy(
      'Useful learning resources turn an unfamiliar idea into a skill you can practice.',
    );
    expect(
      blogSeoChecks(
        good.title,
        good.body,
        good.blog,
        'en',
        'https://northstar.example/',
      ).find((check) => check.id === 'standalone-opening')?.passed,
    ).toBe(true);
  });
});

describe('bounded editorial correction', () => {
  it.each(['facebook', 'instagram', 'x', 'pinterest', 'reddit'] as const)(
    'rewrites a chat-style %s caption before choosing its image',
    async (channel) => {
      const initial = copy('Yes, tutorials can help you learn.');
      const corrected = copy(
        (channel === 'reddit' ? 'I work with Northstar. ' : '') +
          'A useful tutorial gives you one skill to practice. Build from there.',
      );
      const extract = vi
        .fn()
        .mockResolvedValueOnce(receipt(initial))
        .mockResolvedValueOnce(receipt(corrected));
      const job = post(channel),
        runtime = await setup(job, extract);
      await runtime.engine.handle(project.id, job.id);
      expect(
        (await runtime.repository.getAgentPost(project.id, job.id))?.stage,
      ).toBe('social-repair');
      expect(runtime.select).not.toHaveBeenCalled();
      await runtime.engine.handle(project.id, job.id);
      const saved = (await runtime.repository.getAgentPost(
        project.id,
        job.id,
      ))!;
      expect(saved.status).toBe('draft');
      expect(saved.content!.body).toContain(
        'A useful tutorial gives you one skill to practice.',
      );
      expect(hasConversationalOpening(saved.content!.body, true)).toBe(false);
      expect(extract).toHaveBeenCalledTimes(2);
      expect(runtime.select).toHaveBeenCalledTimes(1);
      const revision = extract.mock.calls[1][0].input.draft.revision as string;
      expect(revision).toContain('creative standalone post');
      if (channel === 'reddit')
        expect(revision).toContain(
          'Preserve any required affiliation disclosure',
        );
    },
  );
  it('stops after one social revision if the model still writes a chat response', async () => {
    const extract = vi.fn(async () =>
      receipt(copy('Absolutely, a tutorial can help.')),
    );
    const job = post('instagram'),
      runtime = await setup(job, extract);
    await runtime.engine.handle(project.id, job.id);
    await runtime.engine.handle(project.id, job.id);
    await runtime.engine.handle(project.id, job.id);
    expect(
      await runtime.repository.getAgentPost(project.id, job.id),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'agent_conversational_opening' },
    });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(runtime.select).not.toHaveBeenCalled();
  });
  it('feeds the bad blog opening into formatting and repair, preserving links, FAQs and schema in the corrected draft', async () => {
    const bad = blogCopy('Yes, learning resources can help beginners.'),
      good = blogCopy(
        'Useful learning resources turn an unfamiliar idea into a skill you can practice.',
      );
    const extract = vi
      .fn()
      .mockResolvedValueOnce(receipt(bad))
      .mockResolvedValueOnce(receipt(good));
    const job = { ...post('blog'), stage: 'format' as const },
      runtime = await setup(job, extract);
    const prefix = `projects/${project.id}/agent-posts/${job.id}/generation-1`;
    await runtime.artifacts.put(prefix + '.json', research);
    await runtime.artifacts.put(prefix + '-write.json', receipt(bad));
    await runtime.engine.handle(project.id, job.id);
    expect(
      (await runtime.repository.getAgentPost(project.id, job.id))?.stage,
    ).toBe('repair');
    expect(extract.mock.calls[0][0].input.draft.failedChecks).toContainEqual(
      expect.objectContaining({ id: 'standalone-opening', passed: false }),
    );
    await runtime.engine.handle(project.id, job.id);
    const saved = (await runtime.repository.getAgentPost(project.id, job.id))!;
    expect(saved.status).toBe('draft');
    expect(saved.content!.body).toBe(good.body);
    expect(saved.content!.blog!.faqs).toEqual(metadata.faqs);
    expect(saved.content!.blog!.articleSchema.articleBody).toContain(
      'Useful learning resources',
    );
    expect(
      saved.content!.blog!.checks.find(
        (check) => check.id === 'standalone-opening',
      )?.passed,
    ).toBe(true);
    expect(extract).toHaveBeenCalledTimes(2);
  });
  it('does not complete a blog that still has a conversational opening after repair', async () => {
    const bad = blogCopy('Yes, learning resources can help beginners.');
    const extract = vi.fn(async () => receipt(bad));
    const job = { ...post('blog'), stage: 'repair' as const },
      runtime = await setup(job, extract);
    const prefix = `projects/${project.id}/agent-posts/${job.id}/generation-1`;
    await runtime.artifacts.put(prefix + '.json', research);
    await runtime.artifacts.put(prefix + '-format.json', receipt(bad));
    await runtime.engine.handle(project.id, job.id);
    expect(
      await runtime.repository.getAgentPost(project.id, job.id),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'agent_conversational_opening' },
    });
    expect(runtime.select).not.toHaveBeenCalled();
  });
});
