import {
  DEFAULT_AGENT_CONTENT_MODEL,
  agentContentSchema,
  agentCopyValid,
  blogDraftSchema,
  normalizeUrl,
  normalizeDomain,
  blogBodyText,
  naturalPunctuation,
  descriptiveLinkLabel,
  hasConversationalOpening,
  type AgentPostJob,
  type AgentContent,
} from '@citevia/core';
import {
  AGENT_PROMPTS,
  BLOG_FORMAT_PROMPT,
  agentContext,
  accountWebsite,
} from './agent-prompts.js';
import { agentReasoning } from './agent-model.js';
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
});

export function agentGenerationRequest(
  post: AgentPostJob,
  draft?: unknown,
): ExtractionRequest {
  const blog = post.channel === 'blog';
  return {
    model: post.model,
    ...agentReasoning(post.model),
    ...(post.model === DEFAULT_AGENT_CONTENT_MODEL
      ? { requestTimeoutMs: 180_000 }
      : {}),
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
  content.title = naturalPunctuation(content.title);
  content.body = naturalPunctuation(content.body);
  if (!agentCopyValid(post.channel, content))
    throw new ProviderError(
      'agent_content_too_long',
      'Generated content exceeded this channel’s length limit. Retry generation.',
      false,
    );
  return content;
}
export function parseBlogDraft(receipt: ProviderReceipt) {
  const output = agentOutput(receipt);
  // Receipts from jobs started before the editorial change remain recoverable.
  if (output.blog) {
    delete output.blog.examples;
    delete output.blog.screenshots;
  }
  const parsed = agentContentSchema
    .pick({ title: true, body: true, hashtags: true })
    .extend({ blog: blogDraftSchema })
    .parse(output);
  parsed.body = naturalPunctuation(blogBodyText(parsed.body));
  parsed.title = naturalPunctuation(parsed.title);
  parsed.blog.seoTitle = naturalPunctuation(parsed.blog.seoTitle);
  parsed.blog.metaDescription = naturalPunctuation(parsed.blog.metaDescription);
  parsed.blog.imageAlt = naturalPunctuation(parsed.blog.imageAlt);
  parsed.blog.faqs = parsed.blog.faqs.map((item) => ({
    question: naturalPunctuation(item.question),
    answer: naturalPunctuation(item.answer),
  }));
  if (
    parsed.hashtags.length ||
    /^#{1,3}\s+(?:frequently asked questions|faqs?)\s*$/im.test(parsed.body)
  )
    throw new ProviderError(
      'agent_invalid_blog',
      'The blog must contain separate FAQs and no hashtags. Retry generation.',
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
  const allowed = new Map(
    [
      accountWebsite(post),
      ...sources.map((item) => item.url),
      ...(book?.evidence.map((item) => item.url) || []),
      ...(book?.caseStudies
        .filter((item) => item.enabled)
        .map((item) => item.sourceUrl) || []),
    ]
      .filter((item): item is string => Boolean(item))
      .map((item) => [normalizeUrl(item), item]),
  );
  const seen = new Set<string>();
  const counts = { internal: 0, external: 0 };
  const website = accountWebsite(post);
  const kept: string[] = [];
  // Only supplied inline destinations survive. Strip reference definitions,
  // autolinks and bare model-invented URLs as well as ordinary Markdown links.
  const cleaned = blogBodyText(body)
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, '')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_match, label: string, url: string) => {
        const normalized = normalizeUrl(url);
        const kind =
          website && normalizeDomain(url) === normalizeDomain(website)
            ? 'internal'
            : 'external';
        if (
          !normalized ||
          !allowed.has(normalized) ||
          seen.has(normalized) ||
          counts[kind] >= 3 ||
          !descriptiveLinkLabel(label)
        )
          return label;
        seen.add(normalized);
        counts[kind]++;
        const index =
          kept.push('[' + label + '](' + allowed.get(normalized) + ')') - 1;
        return '\u0000LINK' + index + '\u0000';
      },
    )
    .replace(/<?https?:\/\/[^\s<>]+>?/g, '');
  return cleaned.replace(
    /\u0000LINK(\d+)\u0000/g,
    (_match, index) => kept[Number(index)],
  );
}
export function assertStandalonePost(
  content: Pick<AgentContent, 'title' | 'body'>,
) {
  if (
    hasConversationalOpening(content.title) ||
    hasConversationalOpening(content.body, true)
  )
    throw new ProviderError(
      'agent_conversational_opening',
      'The post starts like a chat reply. Retry generation for a creative standalone opening that answers the question.',
      false,
    );
}

export function assertUnbrandedSocial(
  post: AgentPostJob,
  content: AgentContent,
) {
  if (!['facebook', 'instagram', 'x'].includes(post.channel)) return;
  const website = post.channel === 'facebook' ? accountWebsite(post) : null;
  const body = website ? content.body.replaceAll(website, '') : content.body;
  const text = (content.title + '\n' + body).normalize('NFKC');
  const tags = [
    ...content.hashtags,
    ...(text.match(/#[\p{L}\p{N}_]+/gu) || []),
  ];
  for (const name of [
    post.context.brand.name,
    ...(post.context.brand.aliases || []),
  ]) {
    const tokens = name.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
    if (!tokens.length) continue;
    const escaped = tokens
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^\\p{L}\\p{N}]*');
    const pattern = new RegExp(
      '(^|[^\\p{L}\\p{N}])' + escaped + '(?=$|[^\\p{L}\\p{N}])',
      'iu',
    );
    const compact = tokens.join('').toLocaleLowerCase();
    const brandedTag = tags.some((tag) => {
      const value = tag
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLocaleLowerCase();
      return compact.length < 3 ? value === compact : value.includes(compact);
    });
    if (pattern.test(text) || brandedTag)
      throw new ProviderError(
        'agent_brand_mention',
        'The caption included the account brand name. Retry generation for an answer without brand mentions.',
        false,
      );
  }
}

export function finalizeSocialCopy(
  post: AgentPostJob,
  content: AgentContent,
): AgentContent {
  const hashtags = [
    ...new Map(
      content.hashtags.map((tag) => [tag.toLocaleLowerCase(), tag]),
    ).values(),
  ];
  let body = naturalPunctuation(content.body).trim();
  // Some responses repeat the structured hashtag array inside their caption.
  for (const tag of hashtags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(
      new RegExp('(^|\\s)' + escaped + '(?![\\p{L}\\p{N}_])', 'giu'),
      '$1',
    );
  }
  body = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const segmenter = new Intl.Segmenter(post.context.language, {
    granularity: 'sentence',
  });
  if (
    [...segmenter.segment(body)].some(
      (item) =>
        (
          item.segment
            .replace(/https?:\/\/[^\s]+/g, '')
            .match(/[\p{L}\p{N}]+/gu) || []
        ).length > 40,
    )
  )
    throw new ProviderError(
      'agent_sentence_too_long',
      'The generated caption contains a run-on sentence. Retry generation for shorter, more readable copy.',
      false,
    );
  if (post.channel !== 'x') {
    body = body
      .split(/\n\s*\n/)
      .map((paragraph) => {
        if (/^\s*(?:[-*]|\d+\.)\s/m.test(paragraph)) return paragraph;
        const sentences = [...segmenter.segment(paragraph)]
          .map((item) => item.segment.trim())
          .filter(Boolean);
        const group = post.channel === 'reddit' ? 2 : 1;
        return sentences
          .reduce<string[]>((parts, sentence, index) => {
            if (index % group === 0) parts.push(sentence);
            else parts[parts.length - 1] += ' ' + sentence;
            return parts;
          }, [])
          .join('\n\n');
      })
      .join('\n\n');
  }

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
  if (post.channel === 'x')
    body = body.replace(/https?:\/\/[^\s]+/g, '').trim();
  if (post.channel === 'instagram') {
    body = body.replace(/https?:\/\/[^\s]+/g, '').trim();
    if (!/link in bio/i.test(body)) body += '\n\nLink in bio.';
  }
  const result = {
    ...content,
    title: naturalPunctuation(content.title),
    body,
    hashtags,
  };
  assertStandalonePost(result);
  assertUnbrandedSocial(post, result);
  if (!agentCopyValid(post.channel, result))
    throw new ProviderError(
      'agent_content_too_long',
      'Generated content exceeded this channel’s length limit. Retry generation.',
      false,
    );
  return result;
}
