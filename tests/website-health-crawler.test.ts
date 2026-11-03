import { describe, expect, it, vi } from 'vitest';
import type { WebsiteHealthJob } from '@citevia/core';
import { WebsiteHealthCrawler, websiteHealthCrawlUrl } from '../apps/scanner/src/website-health-crawler.js';
import type { ArticleFetch } from '../apps/scanner/src/geo-backlink-articles.js';

const root = 'https://northstar.com/';
const response = (body: string, contentType = 'text/html', status = 200) => ({ body, contentType, status });
function job(maxPages = 10): WebsiteHealthJob {
  return {
    id: 'site-test', projectId: 'health', url: root, scope: 'site', status: 'queued', createdAt: '2026-11-03T09:00:00Z', updatedAt: '2026-11-03T09:00:00Z',
    createdBy: 'owner', fingerprint: 'test', version: 1, attempts: 0, results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } },
    site: { maxPages, discoveryStatus: 'discovering', limited: false, warnings: [], pageCount: 0, completedPages: 0, partialPages: 0, failedPages: 0, pages: [] },
  };
}
async function discover(fetch: ArticleFetch, maxPages = 10, sitemap?: string) {
  const crawler = new WebsiteHealthCrawler(fetch);
  let current = job(maxPages);
  for (let i = 0; current.site!.discoveryStatus === 'discovering'; i++) {
    if (i > 100) throw new Error('Discovery did not terminate');
    current = { ...current, ...await crawler.step(current, sitemap) };
  }
  return current;
}

describe('Website Health site discovery', () => {
  it('combines robots sitemaps, nested sitemap indexes, saved sitemaps and HTML links without duplicates', async () => {
    const pages: Record<string, ReturnType<typeof response>> = {
      '/robots.txt': response('User-agent: *\nDisallow: /private\nSitemap: https://northstar.com/maps/index.xml', 'text/plain'),
      '/': response('<a href="/about#team">About</a><a href="/about?utm_source=mail">Duplicate</a><a href="/private">Private</a><a href="/logo.png">Image</a><a href="https://other.com/">Outside</a><script>const x = `<a href="/fake">Fake</a>`</script>'),
      '/sitemap.xml': response('', 'application/xml', 404),
      '/maps/index.xml': response('<sitemapindex><sitemap><loc>https://northstar.com/maps/pages.xml</loc></sitemap></sitemapindex>', 'application/xml'),
      '/maps/pages.xml': response('<urlset><url><loc>https://northstar.com/about</loc></url><url><loc>https://northstar.com/pricing?a=1&amp;b=2</loc></url><url><loc>https://evil.com/</loc></url></urlset>', 'application/xml'),
      '/saved.xml': response('<urlset><url><loc>https://northstar.com/contact</loc></url></urlset>', 'application/xml'),
      '/about': response('<a href="/">Home</a><a href="/nofollow" rel="nofollow">No</a>'),
      '/pricing?a=1&b=2': response('Pricing'), '/contact': response('Contact'),
    };
    const fetch = vi.fn<ArticleFetch>(async url => pages[url.pathname + url.search] || response('', '', 404));
    const result = await discover(fetch, 10, root + 'saved.xml');
    expect(result.site).toMatchObject({ discoveryStatus: 'completed', limited: false, pageCount: 4 });
    expect(result.site!.warnings.join(' ')).toContain('robots policy');
    expect(result.site!.pages.map(page => page.url)).toEqual(expect.arrayContaining([root, root + 'about', root + 'contact', root + 'pricing?a=1&b=2']));
    expect(fetch.mock.calls.filter(([url]) => url.pathname === '/robots.txt')).toHaveLength(1);
    expect(fetch.mock.calls.every(([url]) => url.hostname === 'northstar.com')).toBe(true);
    expect(fetch.mock.calls.some(([url]) => ['/private', '/logo.png', '/fake', '/nofollow'].includes(url.pathname))).toBe(false);
    // Saved frontier state resumes in a new crawler instance rather than starting over.
    expect(result.crawl!.queue).toEqual([]);
  });

  it('stops crawling at the page limit and marks incomplete coverage', async () => {
    const fetch = vi.fn<ArticleFetch>(async url => url.pathname === '/robots.txt' ? response('', 'text/plain', 404)
      : response('<a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a>'));
    const result = await discover(fetch, 1);
    expect(result.site).toMatchObject({ discoveryStatus: 'completed', pageCount: 1, limited: true });
    expect(result.site!.warnings.join(' ')).toContain('Additional pages may exist');
    expect(fetch.mock.calls.filter(([url]) => url.pathname !== '/robots.txt')).toHaveLength(1);
  });

  it('bounds cyclic sitemap indexes and query-driven crawl traps', async () => {
    let index = 0;
    const fetch = vi.fn<ArticleFetch>(async url => {
      if (url.pathname === '/robots.txt') return response('', 'text/plain', 404);
      if (url.pathname.endsWith('.xml')) return response('<sitemapindex><sitemap><loc>/sitemap.xml</loc></sitemap></sitemapindex>', 'application/xml');
      return response(Array.from({ length: 1000 }, () => `<a href="/loop?page=${index++}">Page</a>`).join(''));
    });
    const result = await discover(fetch, 3);
    expect(result.site).toMatchObject({ pageCount: 3, limited: true });
    expect(result.crawl!.seen.length).toBeLessThanOrEqual(49);
    expect(fetch.mock.calls.length).toBeLessThan(12);
  });

  it('refuses cross-domain and private redirects before fetching their destination', async () => {
    for (const location of ['https://other.com/page', 'http://169.254.169.254/latest/meta-data', 'https://internal.northstar.com/']) {
      const fetch = vi.fn<ArticleFetch>(async url => url.pathname === '/robots.txt' ? response('', 'text/plain', 404)
        : url.pathname === '/' ? { ...response('', '', 302), location } : response('', '', 404));
      const result = await discover(fetch);
      expect(result.site).toMatchObject({ discoveryStatus: 'failed', pageCount: 0 });
      expect(fetch.mock.calls.every(([url]) => url.hostname === 'northstar.com')).toBe(true);
    }
  });

  it('honors robots for a www redirect and fails closed when robots cannot be retrieved', async () => {
    const fetch = vi.fn<ArticleFetch>(async url => {
      if (url.hostname === 'www.northstar.com') return response('User-agent: *\nDisallow: /', 'text/plain');
      if (url.pathname === '/robots.txt') return response('', 'text/plain', 404);
      if (url.pathname === '/') return { ...response('', '', 301), location: 'https://www.northstar.com/' };
      return response('', '', 404);
    });
    expect((await discover(fetch)).site!.pageCount).toBe(0);
    expect(fetch.mock.calls.filter(([url]) => url.hostname.startsWith('www.')).map(([url]) => url.pathname)).toEqual(['/robots.txt']);
    const unavailable = vi.fn<ArticleFetch>(async () => { throw new Error('Network error containing private diagnostics'); });
    const result = await discover(unavailable);
    expect(result.site).toMatchObject({ discoveryStatus: 'failed', pageCount: 0 });
    expect(result.site!.warnings.join(' ')).not.toContain('private diagnostics');
    expect(unavailable.mock.calls).toHaveLength(1);
  });

  it('normalizes tracking and fragments but keeps distinct query pages and rejects unsupported URLs', () => {
    expect(websiteHealthCrawlUrl('/page?b=2&utm_source=mail&a=1#intro', root)).toBe(root + 'page?a=1&b=2');
    for (const raw of ['https://evilnorthstar.com/', 'https://northstar.com.evil.com/', 'https://docs.northstar.com/', 'https://user:pass@northstar.com/', 'https://northstar.com:8443/', 'http://127.0.0.1/', '/file.pdf', '/checkout', 'javascript:alert(1)'])
      expect(websiteHealthCrawlUrl(raw, root), raw).toBeNull();
    expect(websiteHealthCrawlUrl('https://www.northstar.com/about', root)).toBe('https://www.northstar.com/about');
  });
});
