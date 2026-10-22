import {
  agentContentSchema,
  agentCopyValid,
  blogDraftSchema,
  normalizeUrl,
  type AgentPostJob,
  type AgentContent,
} from '@citevia/core';
import {
  AGENT_PROMPTS,
  BLOG_FORMAT_PROMPT,
  agentContext,
  accountWebsite,
} from './agent-prompts.js';
import {
  ProviderError,
  responseFailure,
  responseText,
  type ProviderReceipt,
  type ExtractionRequest,
} from './provider.js';

const string = (max: number) => ({
  type: 'string',
  pattern: '^[\\s\\S]{1,' + max + '}$',
});
const array = (items: unknown, minItems: number, maxItems: number) => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const blogOutputSchema = object({
  seoTitle: string(100),
  metaDescription: string(200),
  slug: string(150),
  focusKeyphrase: string(100),
  imageSearchQuery: string(100),
  imageAlt: string(300),
  faqs: array(object({ question: string(250), answer: string(1500) }), 3, 5),
  examples: array(
    object({
      id: { type: 'string', enum: ['example-1', 'example-2'] },
      title: string(90),
      caption: string(300),
      columns: array(string(30), 2, 4),
      rows: array(array(string(55), 2, 4), 2, 5),
    }),
    2,
    2,
  ),
});

export function agentGenerationRequest(
  post: AgentPostJob,
  draft?: unknown,
): ExtractionRequest {
  const blog = post.channel === 'blog';
  return {
    model: post.model,
    schemaName: 'citevia_agent_post',
    maxOutputTokens: blog ? 9000 : 2500,
    instructions:
      blog && (post.stage === 'format' || post.stage === 'repair')
        ? BLOG_FORMAT_PROMPT
        : AGENT_PROMPTS[post.channel],
    input: { ...agentContext(post), ...(draft ? { draft } : {}) },
    schema: object({
      title: string(post.channel === 'pinterest' ? 100 : 300),
      body: string(
        {
          facebook: 500,
          instagram: 500,
          x: 220,
          pinterest: 420,
          reddit: 10000,
          blog: 24000,
        }[post.channel],
      ),
      hashtags: array(
        { type: 'string', pattern: '^#[^\\s#]{1,23}$' },
        0,
        blog || post.channel === 'reddit'
          ? 0
          : post.channel === 'x' || post.channel === 'pinterest'
            ? 2
            : post.channel === 'facebook'
              ? 3
              : 5,
      ),
      ...(blog
        ? { blog: blogOutputSchema }
        : { imageSearchQuery: string(100) }),
    }),
  };
}

export function agentOutput(receipt: ProviderReceipt) {
  const failure = responseFailure(receipt.response);
  if (failure) throw failure;
  return JSON.parse(responseText(receipt.response));
}
export function parseAgentContent(
  post: AgentPostJob,
  receipt: ProviderReceipt,
): AgentContent {
  const { imageSearchQuery, ...copy } = agentOutput(receipt);
  if (
    imageSearchQuery !== undefined &&
    (typeof imageSearchQuery !== 'string' ||
      !imageSearchQuery.trim() ||
      imageSearchQuery.length > 100)
  )
    throw new ProviderError(
      'agent_invalid_output',
      'Invalid photo search query. Retry generation.',
      false,
    );
  const content = agentContentSchema
    .pick({ title: true, body: true, hashtags: true })
    .parse(copy);
  if (!agentCopyValid(post.channel, content))
    throw new ProviderError(
      'agent_content_too_long',
      'Generated content exceeded this channel’s length limit. Retry generation.',
      false,
    );
  return content;
}
export function parseBlogDraft(receipt: ProviderReceipt) {
  const parsed = agentContentSchema
    .pick({ title: true, body: true, hashtags: true })
    .extend({ blog: blogDraftSchema })
    .parse(agentOutput(receipt));
  // LLMs sometimes repeat a placement marker in an appendix. Keep its first
  // placement so editorial formatting can proceed without duplicating an image.
  for (const id of ['example-1', 'example-2']) {
    let seen = false;
    parsed.body = parsed.body.replaceAll('[[' + id + ']]', (match) => {
      if (seen) return '';
      seen = true;
      return match;
    });
  }
  if (
    parsed.hashtags.length ||
    new Set(parsed.blog.examples.map((item) => item.id)).size !== 2 ||
    parsed.blog.examples.some((item) =>
      item.rows.some((row) => row.length !== item.columns.length),
    ) ||
    ['example-1', 'example-2'].some(
      (id) => parsed.body.split('[[' + id + ']]').length !== 2,
    ) ||
    /^#{1,3}\s+(?:frequently asked questions|faqs?)\s*$/im.test(parsed.body)
  )
    throw new ProviderError(
      'agent_invalid_blog',
      'The blog must have two inline example screenshots and separate FAQs. Retry generation.',
      false,
    );
  return parsed;
}
export function verifiedBlogLinks(
  post: AgentPostJob,
  body: string,
  sources: { url: string }[] = [],
) {
  const book = post.context.brandbook;
  const allowed = new Set(
    [
      accountWebsite(post),
      ...sources.map((item) => item.url),
      ...(book?.evidence.map((item) => item.url) || []),
      ...(book?.caseStudies
        .filter((item) => item.enabled)
        .map((item) => item.sourceUrl) || []),
    ]
      .filter((item): item is string => Boolean(item))
      .map((item) => normalizeUrl(item)),
  );
  return body.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (match, label, url) => (allowed.has(normalizeUrl(url)) ? match : label),
  );
}
export function finalizeSocialCopy(
  post: AgentPostJob,
  content: AgentContent,
): AgentContent {
  let body = content.body;
  if (post.channel === 'facebook') {
    const website = accountWebsite(post);
    if (!website)
      throw new ProviderError(
        'agent_website_missing',
        'Add the account website before creating a Facebook post.',
        false,
      );
    body = body.replace(/https?:\/\/[^\s]+/g, '').trim() + '\n\n' + website;
  }
  if (post.channel === 'instagram') {
    body = body.replace(/https?:\/\/[^\s]+/g, '').trim();
    if (!/link in bio/i.test(body)) body += '\n\nLink in bio.';
  }
  const result = { ...content, body };
  if (!agentCopyValid(post.channel, result))
    throw new ProviderError(
      'agent_content_too_long',
      'Generated content exceeded this channel’s length limit. Retry generation.',
      false,
    );
  return result;
}
