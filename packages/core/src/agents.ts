import { refreshAgentBlog } from './agent-blog.js';
import { blogBodyText } from './agent-editorial.js';
import { z } from 'zod';
import type { Brand, Brandbook } from './types.js';

/** Content creation is independent of each account's visibility-scan model. */
export const DEFAULT_AGENT_CONTENT_MODEL = 'gpt-6-astra';

export const AGENT_CHANNELS = [
  'facebook',
  'instagram',
  'x',
  'pinterest',
  'reddit',
  'blog',
] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];
export const agentInputSchema = z
  .object({
    channel: z.enum(AGENT_CHANNELS),
    promptId: z.string().trim().min(1).max(200),
  })
  .strict();
export type AgentInput = z.infer<typeof agentInputSchema>;
export const agentImageSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (value) =>
          new URL(value).protocol === 'https:' &&
          new URL(value).hostname === 'images.unsplash.com',
      ),
    alt: z.string().min(1).max(300),
    photoId: z.string().min(1).max(100),
    photographer: z.string().min(1).max(200),
    photographerUrl: z
      .string()
      .url()
      .refine(
        (value) =>
          new URL(value).protocol === 'https:' &&
          new URL(value).hostname === 'unsplash.com',
      ),
    photoUrl: z
      .string()
      .url()
      .refine(
        (value) =>
          new URL(value).protocol === 'https:' &&
          new URL(value).hostname === 'unsplash.com',
      ),
    downloadLocation: z
      .string()
      .url()
      .refine(
        (value) =>
          new URL(value).protocol === 'https:' &&
          new URL(value).hostname === 'api.unsplash.com',
      ),
  })
  .strict();
export const blogExampleSchema = z
  .object({
    id: z.string().regex(/^example-[12]$/),
    title: z.string().min(1).max(90),
    caption: z.string().min(1).max(300),
    columns: z.array(z.string().min(1).max(30)).min(2).max(4),
    rows: z
      .array(z.array(z.string().max(55)).min(2).max(4))
      .min(2)
      .max(5),
  })
  .strict();
export const blogDraftSchema = z
  .object({
    seoTitle: z.string().min(1).max(100),
    metaDescription: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(150)
      .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u),
    focusKeyphrase: z.string().min(1).max(100),
    imageSearchQuery: z.string().min(1).max(100),
    imageAlt: z.string().min(1).max(300),
    faqs: z
      .array(
        z
          .object({
            question: z.string().min(1).max(250),
            answer: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .min(3)
      .max(5),
    /** Legacy drafts only; new generation does not request example images. */
    examples: z.array(blogExampleSchema).length(2).optional(),
  })
  .strict();
export const agentBlogSchema = blogDraftSchema
  .extend({
    screenshots: z
      .array(
        z
          .object({
            id: z.string(),
            dataUrl: z
              .string()
              .startsWith('data:image/png;base64,')
              .max(400000),
          })
          .strict(),
      )
      .length(2)
      .optional(),
    articleSchema: z.record(z.unknown()),
    faqSchema: z.record(z.unknown()),
    checks: z.array(
      z.object({ id: z.string(), label: z.string(), passed: z.boolean() }),
    ),
    sources: z
      .array(z.object({ url: z.string().url(), title: z.string() }))
      .optional(),
    researchedAt: z.string().optional(),
  })
  .strict();
export type AgentImage = z.infer<typeof agentImageSchema>;
export type BlogDraft = z.infer<typeof blogDraftSchema>;
export const agentContentSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(30000),
    hashtags: z.array(z.string().trim().min(1).max(100)).max(15),
    image: agentImageSchema.optional(),
    blog: agentBlogSchema.optional(),
  })
  .strict();
export type AgentContent = z.infer<typeof agentContentSchema>;
export function agentCopyLength(channel: AgentChannel, text: string) {
  if (channel !== 'x') return [...text].length;
  // Conservative X weighting: CJK and emoji consume two units; count joined emoji
  // separately rather than accidentally accepting a post the platform rejects.
  return [...text].reduce((length, char) => {
    const cp = char.codePointAt(0)!;
    return (
      length +
      (cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037)
        ? 1
        : 2)
    );
  }, 0);
}
export function agentCopyValid(channel: AgentChannel, content: AgentContent) {
  const max = {
    x: 280,
    instagram: 2200,
    pinterest: 500,
    facebook: 800,
    reddit: 30000,
    blog: 40000,
  }[channel];
  return (
    agentCopyLength(
      channel,
      content.body +
        (content.hashtags.length ? '\n\n' + content.hashtags.join(' ') : ''),
    ) <= max &&
    (channel !== 'pinterest' || [...content.title].length <= 100)
  );
}
export function agentPostText(channel: AgentChannel, content: AgentContent) {
  let body = channel === 'blog' ? blogBodyText(content.body) : content.body;
  if (channel === 'blog' && content.blog) {
    body = blogBodyText(body);
    body += `\n\n## Frequently asked questions\n\n${content.blog.faqs.map((item) => `### ${item.question}\n\n${item.answer}`).join('\n\n')}`;
    if (content.blog.sources?.length)
      body +=
        '\n\n## Sources\n\n' +
        content.blog.sources
          .map(
            (item) =>
              '- [' + item.title.replace(/[\[\]]/g, '') + '](' + item.url + ')',
          )
          .join('\n');
    if (content.image)
      body = `![${content.image.alt}](${content.image.url})\n\nPhoto by [${content.image.photographer}](${content.image.photographerUrl}) on [Unsplash](${content.image.photoUrl})\n\n${body}`;
    body += `\n\n<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [content.blog.articleSchema, content.blog.faqSchema] }).replace(/</g, '\\u003c')}</script>`;
  }
  return `${channel === 'blog' ? `# ${content.title}\n\n` : ''}${body}${content.hashtags.length ? `\n\n${content.hashtags.join(' ')}` : ''}`;
}
export const agentEditSchema = agentContentSchema
  .pick({ title: true, body: true, hashtags: true })
  .extend({ version: z.number().int().positive() })
  .strict();
export const MAX_ACTIVE_AGENT_POSTS = 3;
export type AgentPost = {
  channel: AgentChannel;
  /** Older drafts may predate required tracked-prompt selection. */
  promptId?: string;
  prompt: string;
  topic: string;
  id: string;
  projectId: string;
  status: 'queued' | 'generating' | 'draft' | 'failed';
  content: AgentContent | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  model: string;
  error: { code: string; message: string } | null;
};
/** Private worker state, omitted from every API response. */
export type AgentPostJob = AgentPost & {
  createdBy: string;
  fingerprint: string;
  generation: number;
  attempts: number;
  retryRequestId?: string;
  context: {
    brand: Brand;
    brandbook?: Brandbook;
    language: string;
    country: string;
  };
  leaseOwner?: string;
  leaseExpiresAt?: string;
  paidCall?: { startedAt: string };
  stage?: 'links' | 'write' | 'format' | 'repair' | 'social-repair';
  /** Version 2 requires a checkpointed domain-restricted internal-link search. */
  researchVersion?: 2;
};
export type AgentPostPage = {
  items: AgentPost[];
  total: number;
  nextCursor: string | null;
  generationAvailable: boolean;
};
export function publicAgentPost(job: AgentPostJob): AgentPost {
  const {
    id,
    projectId,
    channel,
    topic,
    prompt,
    promptId,
    status,
    content,
    createdAt,
    updatedAt,
    version,
    model,
    error,
  } = job;
  return {
    id,
    projectId,
    channel,
    topic,
    prompt,
    ...(promptId ? { promptId } : {}),
    status,
    content: content?.blog ? refreshAgentBlog(job, content) : content,
    createdAt,
    updatedAt,
    version,
    model,
    error,
  };
}
