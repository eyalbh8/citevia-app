import { reportExcerpt } from './report-excerpt';
import {
  blogBodyText,
  agentJsonLd,
  publicSourceUrl,
  publicReportMarkdown,
  agentPostText,
  type AgentChannel,
  type AgentContent,
  type AgentImage,
} from '@citevia/core';
import AnswerMarkdown from './AnswerMarkdown';

export function AgentPhoto({ image }: { image: AgentImage }) {
  const url = publicSourceUrl(image.url);
  if (!url || !publicSourceUrl(image.photographerUrl) || !publicSourceUrl(image.photoUrl)) return null;
  return (
    <figure className="agent-post-photo">
      <img src={url} alt={reportExcerpt(image.alt)} loading="lazy" />
      <figcaption>
        Photo by{' '}
        <a
          href={publicSourceUrl(image.photographerUrl) ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
        >
          {reportExcerpt(image.photographer)}
        </a>{' '}
        on{' '}
        <a href={publicSourceUrl(image.photoUrl) ?? undefined} target="_blank" rel="noreferrer noopener">
          Unsplash
        </a>
      </figcaption>
    </figure>
  );
}
export function AgentBlogBody({ content }: { content: AgentContent }) {
  const blog = content.blog;
  if (!blog) return <AnswerMarkdown text={blogBodyText(content.body)} />;
  return (
    <>
      <AnswerMarkdown text={blogBodyText(content.body)} />
      <section className="agent-blog-faqs">
        <h2>Frequently asked questions</h2>
        {blog.faqs.map((faq, index) => (
          <div key={index}>
            <h3>{reportExcerpt(faq.question)}</h3>
            <p dir="auto">{reportExcerpt(faq.answer)}</p>
          </div>
        ))}
      </section>
      {blog.sources?.length ? (
        <section className="agent-blog-sources">
          <h2>Sources</h2>
          <ul>
            {blog.sources.map((source) => (
              <li key={source.url}>
                <a href={publicSourceUrl(source.url) ?? undefined} target="_blank" rel="noreferrer noopener">
                  {reportExcerpt(source.title)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
export function AgentBlogSeo({ content }: { content: AgentContent }) {
  const blog = content.blog;
  if (!blog) return null;
  const passed = blog.checks.filter((item) => item.passed).length;
  return (
    <details className="agent-blog-seo">
      <summary>
        SEO review · {passed}/{blog.checks.length} checks passed
      </summary>
      <p>
        Checks follow Yoast editorial criteria. Confirm the final score in Yoast
        after publishing; title width, link context and language analysis can
        differ.
      </p>
      <dl>
        <dt>Focus keyphrase</dt>
        <dd>{reportExcerpt(blog.focusKeyphrase)}</dd>
        <dt>SEO title</dt>
        <dd>{reportExcerpt(blog.seoTitle)}</dd>
        <dt>Meta description</dt>
        <dd>{reportExcerpt(blog.metaDescription)}</dd>
        <dt>Suggested slug</dt>
        <dd>{reportExcerpt(blog.slug)}</dd>
      </dl>
      <ul>
        {blog.checks.map((check) => (
          <li
            key={check.id}
            className={check.passed ? 'seo-pass' : 'seo-review'}
          >
            {check.passed ? '✓' : 'Review:'} {reportExcerpt(check.label)}
          </li>
        ))}
      </ul>
      <p>
        Includes BlogPosting and FAQPage JSON-LD. The publisher must set the
        final canonical URL and publication date.
      </p>
    </details>
  );
}
// Schema.org fields can contain nested authors, images, URLs and quoted article text.
export function publishableSchema(content: AgentContent) {
  return JSON.stringify(agentJsonLd(content), (key, value: unknown) => {
    if (key && reportExcerpt(key) !== key) return undefined;
    if (typeof value !== 'string') return value;
    if (/^https?:\/\//i.test(value)) return publicSourceUrl(value) ?? undefined;
    return publicReportMarkdown(value);
  }, 2);
}
export function copyablePostText(channel: AgentChannel, content: AgentContent) {
  const clean = { ...content, title: reportExcerpt(content.title), body: publicReportMarkdown(content.body), hashtags: content.hashtags.map(reportExcerpt) };
  if (content.blog) {
    const schema = JSON.parse(publishableSchema(content))['@graph'];
    clean.blog = { ...content.blog,
      faqs: content.blog.faqs.map(faq => ({ question: publicReportMarkdown(faq.question), answer: publicReportMarkdown(faq.answer) })),
      sources: content.blog.sources?.flatMap(source => {
        const url = publicSourceUrl(source.url);
        return url ? [{ ...source, url, title: reportExcerpt(source.title) }] : [];
      }),
      articleSchema: schema[0], faqSchema: schema[1],
    };
  }
  if (content.image) {
    const url = publicSourceUrl(content.image.url);
    const photographerUrl = publicSourceUrl(content.image.photographerUrl);
    const photoUrl = publicSourceUrl(content.image.photoUrl);
    clean.image = url && photographerUrl && photoUrl
      ? { ...content.image, url, photographerUrl, photoUrl, photographer: reportExcerpt(content.image.photographer), alt: reportExcerpt(content.image.alt) }
      : undefined;
  }
  return agentPostText(channel, clean);
}
export async function blogArticleHtml(content: AgentContent) {
  if (!content.blog) return null;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const markup = renderToStaticMarkup(
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{reportExcerpt(content.blog.seoTitle)}</title>
        <meta name="description" content={reportExcerpt(content.blog.metaDescription)} />
        <meta name="keywords" content={reportExcerpt(content.blog.focusKeyphrase)} />
      </head>
      <body>
        <article>
          <h1>{reportExcerpt(content.title)}</h1>
          {content.image && <AgentPhoto image={content.image} />}
          <AgentBlogBody content={content} />
        </article>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: publishableSchema(content).replace(
              /</g,
              '\\u003c',
            ),
          }}
        />
      </body>
    </html>,
  );
  return '<!doctype html>' + markup;
}
export async function downloadBlogArticle(content: AgentContent) {
  const html = await blogArticleHtml(content);
  if (!html || !content.blog) return;
  const url = URL.createObjectURL(
    new Blob([html], { type: 'text/html;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = reportExcerpt(content.blog.slug) + '.html';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
