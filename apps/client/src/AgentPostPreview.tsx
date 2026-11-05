import { reportExcerpt } from './report-excerpt';
import {
  blogBodyText,
  agentJsonLd,
  type AgentContent,
  type AgentImage,
} from '@citevia/core';
import AnswerMarkdown from './AnswerMarkdown';

export function AgentPhoto({ image, preserveOriginal = false }: { image: AgentImage; preserveOriginal?: boolean }) {
  return (
    <figure className="agent-post-photo">
      <img src={image.url} alt={preserveOriginal ? image.alt : reportExcerpt(image.alt)} loading="lazy" />
      <figcaption>
        Photo by{' '}
        <a
          href={image.photographerUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {preserveOriginal ? image.photographer : reportExcerpt(image.photographer)}
        </a>{' '}
        on{' '}
        <a href={image.photoUrl} target="_blank" rel="noreferrer noopener">
          Unsplash
        </a>
      </figcaption>
    </figure>
  );
}
export function AgentBlogBody({ content, preserveOriginal = false }: { content: AgentContent; preserveOriginal?: boolean }) {
  const blog = content.blog;
  if (!blog) return <AnswerMarkdown text={blogBodyText(content.body)} preserveOriginal={preserveOriginal} />;
  return (
    <>
      <AnswerMarkdown text={blogBodyText(content.body)} preserveOriginal={preserveOriginal} />
      <section className="agent-blog-faqs">
        <h2>Frequently asked questions</h2>
        {blog.faqs.map((faq, index) => (
          <div key={index}>
            <h3>{preserveOriginal ? faq.question : reportExcerpt(faq.question)}</h3>
            <p dir="auto">{preserveOriginal ? faq.answer : reportExcerpt(faq.answer)}</p>
          </div>
        ))}
      </section>
      {blog.sources?.length ? (
        <section className="agent-blog-sources">
          <h2>Sources</h2>
          <ul>
            {blog.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer noopener">
                  {preserveOriginal ? source.title : reportExcerpt(source.title)}
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
export async function blogArticleHtml(content: AgentContent) {
  if (!content.blog) return null;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const markup = renderToStaticMarkup(
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{content.blog.seoTitle}</title>
        <meta name="description" content={content.blog.metaDescription} />
        <meta name="keywords" content={content.blog.focusKeyphrase} />
      </head>
      <body>
        <article>
          <h1>{content.title}</h1>
          {content.image && <AgentPhoto image={content.image} preserveOriginal />}
          <AgentBlogBody content={content} preserveOriginal />
        </article>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(agentJsonLd(content)).replace(
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
  link.download = content.blog.slug + '.html';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
