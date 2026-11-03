import { createHash } from 'node:crypto';
import type { WebsiteHealthCrawlState, WebsiteHealthJob, WebsiteHealthSitePage } from '@citevia/core';
import { fetchPublicArticle, publicArticleUrl, robotsAllows, type ArticleFetch } from './geo-backlink-articles.js';

const MAX_SITEMAPS = 40;
const nonPage = /\.(?:avif|bmp|css|csv|docx?|eot|gif|gz|ico|jpe?g|js|json|map|mp[34]|pdf|png|pptx?|rar|rss|svg|tar|tiff?|ttf|txt|wav|web[mp]|woff2?|xlsx?|xml|zip)$/i;
function decode(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:amp|quot|apos|lt|gt);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[entity]!))
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, value: string) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}
function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match ? decode(match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Limit discovery to the selected host (including its www alias), never arbitrary subdomains. */
export function websiteHealthCrawlUrl(raw: string, base: string, page = true): string | null {
  try {
    const candidate = new URL(decode(raw), base), root = new URL(base);
    if (candidate.href.length > 2048 || !publicArticleUrl(candidate.href) || candidate.hostname.replace(/^www\./, '') !== root.hostname.replace(/^www\./, '')) return null;
    candidate.hash = '';
    if (page && (nonPage.test(candidate.pathname) || /\/(?:logout|signout|sign-out|checkout|cart)(?:\/|$)/i.test(candidate.pathname))) return null;
    for (const key of [...candidate.searchParams.keys()]) if (/^(?:utm_.+|gclid|fbclid|msclkid)$/i.test(key)) candidate.searchParams.delete(key);
    candidate.searchParams.sort();
    return candidate.href;
  } catch { return null; }
}

/** One bounded discovery task per delivery. The frontier is persisted with the audit lease. */
export class WebsiteHealthCrawler {
  constructor(private fetch: ArticleFetch = fetchPublicArticle) {}

  async step(job: WebsiteHealthJob, sitemapUrl?: string | null) {
    const site = structuredClone(job.site!);
    const root = new URL(job.url).origin + '/';
    const crawl: WebsiteHealthCrawlState = structuredClone(job.crawl || {
      queue: [{ url: root, kind: 'page' }, { url: new URL('/sitemap.xml', root).href, kind: 'sitemap' }],
      seen: [`page:${root}`, `sitemap:${new URL('/sitemap.xml', root).href}`], robots: {}, requests: 0, sitemaps: 0,
    });
    const warn = (message: string) => { if (!site.warnings.includes(message) && site.warnings.length < 10) site.warnings.push(message); };
    const maxCandidates = site.maxPages * 3 + MAX_SITEMAPS;
    const maxRequests = site.maxPages * 8 + MAX_SITEMAPS * 4;
    const add = (raw: string, base: string, kind: 'page' | 'sitemap') => {
      const url = websiteHealthCrawlUrl(raw, base, kind === 'page');
      if (!url || !websiteHealthCrawlUrl(url, root, kind === 'page')) return;
      const key = `${kind}:${url}`;
      if (crawl.seen.includes(key)) return;
      if (crawl.seen.length >= maxCandidates || (kind === 'sitemap' && crawl.seen.filter(item => item.startsWith('sitemap:')).length >= MAX_SITEMAPS)) {
        site.limited = true;
        return;
      }
      crawl.seen.push(key);
      crawl.queue.push({ url, kind });
    };
    if (!job.crawl && sitemapUrl) add(sitemapUrl, root, 'sitemap');
    const retrieve = async (raw: string, checkRobots: boolean): Promise<{ url: string; page: Awaited<ReturnType<ArticleFetch>> }> => {
      let url = raw;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const allowed = websiteHealthCrawlUrl(url, root, false);
        if (!allowed || crawl.requests >= maxRequests) throw new Error('Discovery boundary');
        const parsed = new URL(allowed);
        if (checkRobots) {
          if (crawl.robots[parsed.origin] === undefined) {
            try {
              const robots = await retrieve(new URL('/robots.txt', parsed).href, false);
              crawl.robots[parsed.origin] = robots.page.status === 404 ? '' : robots.page.status === 200 ? robots.page.body : 'User-agent: *\nDisallow: /';
              if (![200, 404].includes(robots.page.status)) warn('Some pages could not be discovered because their robots policy was unavailable.');
              if (robots.page.status === 200) for (const match of robots.page.body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) add(match[1], robots.url, 'sitemap');
            } catch {
              crawl.robots[parsed.origin] = 'User-agent: *\nDisallow: /';
              warn('Some pages could not be discovered because their robots policy was unavailable.');
            }
          }
          if (!robotsAllows(crawl.robots[parsed.origin], parsed)) throw new Error('Robots policy');
        }
        crawl.requests++;
        // This transport pins public DNS addresses, limits bytes/time, and never follows redirects itself.
        const page = await this.fetch(parsed);
        if (page.status >= 300 && page.status < 400 && page.location) {
          url = new URL(page.location, parsed).href;
          continue;
        }
        return { url: allowed, page };
      }
      throw new Error('Too many redirects');
    };
    const task = crawl.queue.shift();
    if (task) {
      try {
        const { url, page } = await retrieve(task.url, true);
        if (task.kind === 'sitemap') {
          crawl.sitemaps++;
          if (page.status === 200) {
            const index = /<(?:[\w-]+:)?sitemapindex\b/i.test(page.body);
            if (!index && !/<(?:[\w-]+:)?urlset\b/i.test(page.body)) warn('A sitemap could not be read. Discovery continued through internal links.');
            else for (const match of page.body.matchAll(/<(?:[\w-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?loc\s*>/gi)) add(match[1].trim(), url, index ? 'sitemap' : 'page');
          } else if (page.status !== 404) warn('A sitemap was unavailable. Discovery continued through internal links.');
        } else if (page.status === 200 && /text\/html|application\/xhtml\+xml/i.test(page.contentType)) {
          if (!site.pages.some(item => item.url === url)) {
            const result: WebsiteHealthSitePage = {
              id: `page_${createHash('sha256').update(url).digest('hex').slice(0, 24)}`, url, status: 'queued',
              results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } },
            };
            site.pages.push(result);
          }
          const html = page.body.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
          const baseTag = html.match(/<base\b([^>]+)>/i)?.[1];
          const base = baseTag ? websiteHealthCrawlUrl(attribute(baseTag, 'href') || '', url, false) || url : url;
          for (const match of html.matchAll(/<a\b([^>]+)>/gi)) {
            const href = attribute(match[1], 'href');
            if (href && !/(?:^|\s)nofollow(?:\s|$)/i.test(attribute(match[1], 'rel') || '')) add(href, base, 'page');
          }
        } else warn('Some linked pages were unavailable or were not HTML pages and were skipped.');
      } catch {
        warn('Some URLs could not be discovered because of access restrictions, robots policy, redirects, or retrieval limits.');
      }
    }
    site.pageCount = site.pages.length;
    if (site.pages.length >= site.maxPages || crawl.requests >= maxRequests) {
      if (crawl.queue.length) site.limited = true;
      crawl.queue = [];
    }
    if (!crawl.queue.length) {
      site.discoveryStatus = site.pages.length ? 'completed' : 'failed';
      if (!site.pages.length) warn('No accessible public HTML pages were found for this website.');
    }
    if (site.limited) warn('Discovery reached the page or crawl safety limit. Additional pages may exist.');
    return { site, crawl };
  }
}
