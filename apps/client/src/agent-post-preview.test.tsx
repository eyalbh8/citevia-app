// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  refreshAgentBlog,
  type AgentContent,
  type AgentPostJob,
} from '@citevia/core';
import {
  AgentBlogBody,
  AgentBlogSeo,
  AgentPhoto,
  blogArticleHtml,
  copyablePostText,
  publishableSchema,
} from './AgentPostPreview';

const seed: AgentContent = {
  title: 'A useful article',
  body: 'An introduction.\n\n[[example-1]]\n\n## Practical advice\n\n<script>alert("bad")</script>\n\n[[example-2]]',
  hashtags: [],
  image: {
    url: 'https://images.unsplash.com/photo-test',
    alt: 'Useful photo',
    photoId: 'test',
    photographer: 'Photographer',
    photographerUrl: 'https://unsplash.com/@photographer',
    photoUrl: 'https://unsplash.com/photos/test',
    downloadLocation: 'https://api.unsplash.com/photos/test/download',
  },
  blog: {
    seoTitle: 'A useful article about reporting metrics',
    metaDescription: 'A helpful description.',
    slug: 'reporting-metrics',
    focusKeyphrase: 'reporting metrics',
    imageSearchQuery: 'analytics dashboard',
    imageAlt: 'Reporting metrics',
    faqs: [1, 2, 3].map((number) => ({
      question: 'Question ' + number + '?',
      answer: 'Visible answer ' + number + '.',
    })),
    examples: [1, 2].map((number) => ({
      id: 'example-' + number,
      title: 'Example ' + number,
      caption: 'A small illustrative table.',
      columns: ['A', 'B'],
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    })),
    screenshots: [1, 2].map((number) => ({
      id: 'example-' + number,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })),
    articleSchema: {},
    faqSchema: {},
    checks: [],
  },
};
const job = {
  context: {
    brand: { name: 'Brand', domains: ['brand.example'] },
    language: 'en',
  },
  updatedAt: '2026-10-22T00:00:00Z',
} as AgentPostJob;
const content = refreshAgentBlog(job, seed);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('blog post preview and export', () => {
  it('omits restricted words from previews and exported articles, copied content and their destinations', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const url = 'https://publisher.example/demo/start';
    const draft: AgentContent = {
      ...content,
      body: `[Try the demo](${url})`,
      image: { ...content.image!, alt: 'Demo photo' },
      blog: { ...content.blog!, seoTitle: 'Try the demo', faqs: [{ question: 'Demo?', answer: 'The demo.' }],
        sources: [{ url, title: 'Demo guide' }],
        articleSchema: { headline: 'Try a demo', citation: url, author: { name: 'Demo author' } } },
    };
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root!.render(<><AgentPhoto image={draft.image!} /><AgentBlogBody content={draft} /><AgentBlogSeo content={draft} /></>));
    expect(container.textContent).not.toMatch(/\bdemo\b/i);
    expect(container.querySelector('img')?.alt).not.toMatch(/\bdemo\b/i);
    expect(container.querySelector('.agent-blog-sources [href]')).toBeNull();
    const exported = (await blogArticleHtml(draft))!;
    expect(exported).not.toMatch(/\bdemos?\b/i);
    const html = new DOMParser().parseFromString(exported, 'text/html');
    expect(html.title).toBe('Try the […]');
    expect(html.querySelector('article p a[href]')).toBeNull();
    expect(html.querySelector('.agent-blog-faqs p')?.textContent).toBe('The […].');
    expect(copyablePostText('blog', draft)).not.toMatch(/\bdemos?\b/i);
    expect(publishableSchema(draft)).not.toMatch(/\bdemos?\b/i);
    expect(draft.blog!.sources![0].url).toBe(url);
  });

  it('renders the attributed photo, no legacy screenshots, FAQs and honest SEO feedback', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <>
          <AgentPhoto image={content.image!} />
          <AgentBlogBody content={content} />
          <AgentBlogSeo content={content} />
        </>,
      ),
    );
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.textContent).toContain(
      'Photo by Photographer on Unsplash',
    );
    expect(
      container.querySelectorAll('.agent-example-screenshot'),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain('Illustrative example data.');
    expect(container.textContent).toContain('Visible answer 3.');
    expect(container.textContent).toContain('Confirm the final score in Yoast');
    expect(container.textContent).not.toContain('[[example-');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')?.href).toBe(
      content.image!.photographerUrl,
    );
  });
  it('exports HTML with only the Unsplash hero, SEO metadata and JSON-LD matching visible FAQs', async () => {
    const html = (await blogArticleHtml(content))!;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.title).toBe(content.blog!.seoTitle);
    expect(
      doc.querySelector('meta[name=description]')?.getAttribute('content'),
    ).toBe(content.blog!.metaDescription);
    expect(doc.querySelectorAll('article img')).toHaveLength(1);
    const schema = JSON.parse(
      doc.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    expect(schema['@graph'][0].headline).toBe(content.title);
    expect(
      schema['@graph'][1].mainEntity.map(
        (item: { acceptedAnswer: { text: string } }) =>
          item.acceptedAnswer.text,
      ),
    ).toEqual(content.blog!.faqs.map((item) => item.answer));
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('[[example-');
  });
  it('escapes closing script tags in structured data', async () => {
    const evil = refreshAgentBlog(job, {
      ...seed,
      title: 'A title </script><script>alert("bad")</script>',
    });
    const html = (await blogArticleHtml(evil))!;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    const schema = JSON.parse(doc.querySelector('script')!.textContent!);
    expect(schema['@graph'][0].headline).toBe(evil.title);
  });
});
