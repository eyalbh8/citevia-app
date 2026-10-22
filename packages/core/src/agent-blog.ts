import type { AgentContent, AgentPostJob, BlogDraft } from './agents.js';
import {
  blogBodyText,
  descriptiveLinkLabel,
  hasConversationalOpening,
} from './agent-editorial.js';
import { normalizeDomain } from './urls.js';

const plain = (value: string) =>
  value
    .replace(/\[\[example-[12]\]\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~]/g, '');
export function blogWordCount(body: string) {
  return (plain(body).match(/[\p{L}\p{N}]+/gu) || []).length;
}
export function blogSeoChecks(
  title: string,
  body: string,
  blog: BlogDraft,
  language = 'en',
  website?: string,
) {
  const key = blog.focusKeyphrase.toLocaleLowerCase();
  const has = (value: string) => value.toLocaleLowerCase().includes(key);
  const text = plain(body);
  // FAQs are visible article content in the preview and HTML export.
  // Include them in the word count just as the published post's content editor does.
  const visibleText =
    text +
    '\n' +
    blog.faqs.map((item) => item.question + ' ' + item.answer).join('\n');
  const words = visibleText.match(/[\p{L}\p{N}]+/gu) || [];
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const sentences = plain(
    body
      .split('\n')
      .filter((line) => !/^#{1,6}\s/.test(line))
      .join('\n'),
  )
    .split(/[.!?]+(?:\s|$)|\n+/)
    .filter((item) => item.trim());
  const count = (value: string) =>
    (value.match(/[\p{L}\p{N}]+/gu) || []).length;
  const checks = [
    {
      id: 'length',
      label: 'Article has 800–1200 words (' + words.length + ' currently)',
      passed: words.length >= 800 && words.length <= 1200,
    },
    {
      id: 'title',
      label: 'SEO title is 45–60 characters and starts with the keyphrase',
      passed:
        [...blog.seoTitle].length >= 45 &&
        [...blog.seoTitle].length <= 60 &&
        blog.seoTitle.toLocaleLowerCase().startsWith(key),
    },
    {
      id: 'description',
      label:
        'Meta description is 135–155 characters and contains the keyphrase',
      passed:
        [...blog.metaDescription].length >= 135 &&
        [...blog.metaDescription].length <= 155 &&
        has(blog.metaDescription),
    },
    {
      id: 'intro',
      label: 'Opening paragraph contains the focus keyphrase',
      passed: has(paragraphs[0] || ''),
    },
    {
      id: 'slug',
      label: 'Slug contains the focus keyphrase',
      passed: has(blog.slug.replace(/-/g, ' ')),
    },
    {
      id: 'heading',
      label: 'Focus keyphrase appears in an H2 or H3',
      passed: body
        .split('\n')
        .some((line) => /^#{2,3}\s/.test(line) && has(line)),
    },
    {
      id: 'alt',
      label: 'Hero image has descriptive keyphrase alt text',
      passed: has(blog.imageAlt),
    },
    {
      id: 'paragraphs',
      label: 'Paragraphs stay below 150 words',
      passed: paragraphs.every((item) => count(item) <= 150),
    },
    {
      id: 'sentences',
      label: 'At most 25% of sentences exceed 20 words',
      passed:
        sentences.length > 0 &&
        sentences.filter((item) => count(item) > 20).length /
          sentences.length <=
          0.25,
    },
    {
      id: 'standalone-opening',
      label:
        'Title and opening read as a standalone post, without chat-reply prefaces',
      passed:
        !hasConversationalOpening(title) &&
        !hasConversationalOpening(body, true),
    },
    {
      id: 'faqs',
      label: 'Three to five visible FAQs with matching schema',
      passed: blog.faqs.length >= 3 && blog.faqs.length <= 5,
    },
    {
      id: 'internal-link',
      label: 'Article includes a supplied account website link',
      passed: [...body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)].some(
        (match) =>
          Boolean(website) &&
          normalizeDomain(match[2]) === normalizeDomain(website!) &&
          descriptiveLinkLabel(match[1]),
      ),
    },
    {
      id: 'external-link',
      label:
        'Article cites a supplied external source with descriptive anchor text',
      passed:
        Boolean(website) &&
        [...body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)].some(
          (match) =>
            normalizeDomain(match[2]) !== normalizeDomain(website!) &&
            descriptiveLinkLabel(match[1]),
        ),
    },
    {
      id: 'article-title',
      label: 'Article title is descriptive',
      passed: title.trim().length >= 10,
    },
  ];
  // Linguistic readability assessments vary by language and require the installed Yoast analyzer.
  // These deterministic editorial checks do not claim an official Yoast score.
  void language;
  return checks;
}

export function refreshAgentBlog(
  post: AgentPostJob,
  content: AgentContent,
): AgentContent {
  if (!content.blog) return content;
  const {
    examples: _examples,
    screenshots: _screenshots,
    ...blog
  } = content.blog;
  content = { ...content, body: blogBodyText(content.body) };
  const visibleBody = content.body;
  const articleBody =
    plain(visibleBody) +
    '\n\n' +
    blog.faqs.map((item) => item.question + '\n' + item.answer).join('\n\n');
  const author = { '@type': 'Organization', name: post.context.brand.name };
  const website = post.context.brand.domains?.[0];
  const url = website
    ? 'https://' +
      website.replace(/^https?:\/\//, '').replace(/\/.*$/, '') +
      '/'
    : undefined;
  const articleSchema = {
    '@type': 'BlogPosting',
    headline: content.title,
    description: blog.metaDescription,
    articleBody,
    inLanguage: post.context.language,
    keywords: blog.focusKeyphrase,
    author: { ...author, ...(url ? { url } : {}) },
    publisher: { ...author, ...(url ? { url } : {}) },
    ...(blog.sources?.length
      ? {
          citation: blog.sources.map((source) => ({
            '@type': 'WebPage',
            url: source.url,
            name: source.title,
          })),
        }
      : {}),
    ...(content.image
      ? {
          image: {
            '@type': 'ImageObject',
            url: content.image.url,
            caption: content.image.alt,
            creditText: content.image.photographer,
            license: 'https://unsplash.com/license',
            acquireLicensePage: content.image.photoUrl,
          },
        }
      : {}),
    // Drafts have no public URL or publication date. The publisher supplies these on publication.
    dateModified: post.updatedAt,
  };
  const faqSchema = {
    '@type': 'FAQPage',
    mainEntity: blog.faqs.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
  return {
    ...content,
    blog: {
      ...blog,
      articleSchema,
      faqSchema,
      checks: blogSeoChecks(
        content.title,
        content.body,
        blog,
        post.context.language,
        url,
      ),
    },
  };
}

export function agentJsonLd(content: AgentContent) {
  return content.blog
    ? {
        '@context': 'https://schema.org',
        '@graph': [content.blog.articleSchema, content.blog.faqSchema],
      }
    : null;
}
