import { describe, expect, it } from 'vitest';
import { articleEvidenceFromHtml, GeoBacklinkArticleVerifier, publicArticleUrl, publicIpv4, robotsAllows, type ArticleFetch } from '../apps/scanner/src/geo-backlink-articles.js';
import { newProject } from './fixtures/scanner.js';

const project = { ...newProject({ domain: 'northstar.com' }), competitors: [
  { id: 'clearview', name: 'Clearview', aliases: [], domains: ['clearview.com'] },
  { id: 'metriclane', name: 'Metriclane', aliases: [], domains: ['metriclane.com'] },
], prompts: [{ ...newProject().prompts[0], topic: 'Marketing analytics' }] };
const body = 'Marketing analytics products for the United States need transparent pricing, accurate measurement, and useful reporting. ' +
  'Independent evaluation should compare product capabilities, current support coverage, implementation complexity, and customer needs. ' +
  'Every product in this article must be evaluated against the same criteria using current public documentation and independent testing.';
const page = (content: string) => `<html><head><title>Analytics comparison</title></head><body><article>${body} ${content}</article></body></html>`;
const at = '2026-11-01T06:00:00.000Z';
const url = 'https://publisher.com/article';

describe('GEO article verification facts', () => {
  it('extracts verified article mentions separately from scan answers and does not invent editorial ranks', () => {
    const result = articleEvidenceFromHtml(project, url, page('Clearview, Metriclane, and Northstar each have different capabilities.'), at);
    expect(result.status).toBe('verified');
    expect(result.brandPresence).toBe('present');
    expect(result.competitors.map(item => item.name)).toEqual(['Clearview', 'Metriclane']);
    expect(result.competitors.every(item => item.position === null)).toBe(true);
    expect(result.brandPosition).toBeNull();
    expect(result.topicRelevant).toBe(true);
    expect(result.marketRelevant).toBe(true);
    expect(result.placementOpportunity).toBe('unknown');
    expect(result.outdated).toBeNull();
  });
  it('does not use navigation, script contents, or partial product names as article mentions', () => {
    const result = articleEvidenceFromHtml(project, url, page('<nav>Northstar</nav><script>Northstar</script>Northstarish and Clearviewer are invented names.'), at);
    expect(result.brandPresence).toBe('absent');
    expect(result.competitors).toEqual([]);
  });
  it('identifies owned links and supported rel attributes, preserving unknown availability', () => {
    const result = articleEvidenceFromHtml(project, url, page('Northstar <a href="https://go.northstar.com/product" rel="nofollow sponsored">Read more</a>'), at);
    expect(result.hasBrandLink).toBe(true);
    expect(result.links).toEqual([{ url: 'https://go.northstar.com/product', type: 'sponsored' }]);
    expect(result.placementOpportunity).toBe('unknown');
    const unquoted = articleEvidenceFromHtml(project, url, page('Northstar <a href=https://go.northstar.com/product rel=nofollow>Read more</a>'), at);
    expect(unquoted.hasBrandLink).toBe(true);
    expect(unquoted.links).toEqual([{ url: 'https://go.northstar.com/product', type: 'nofollow' }]);
  });
  it('treats paywalls, challenge pages, absent body and short content as unknown', () => {
    for (const html of [page('Subscribe to continue'), page('<script>{"isAccessibleForFree":false}</script>'), '<article>Short article</article>', `<body>${body}</body>`, page('captcha')]) {
      const result = articleEvidenceFromHtml(project, url, html, at);
      expect(result.status).toBe('unavailable');
      expect(result.brandPresence).toBe('unknown');
      expect(result.hasBrandLink).toBeNull();
      expect(result.competitors).toEqual([]);
    }
  });
  it('does not infer market relevance without evidence in the actual body', () => {
    const html = page('Northstar').replace('United States', 'global markets');
    expect(articleEvidenceFromHtml(project, url, html, at).marketRelevant).toBeNull();
  });
});

describe('GEO safe article retrieval', () => {
  it('rejects non-public, credential-bearing and unsupported destinations', () => {
    for (const value of ['http://localhost/a', 'http://127.0.0.1/a', 'http://[::1]/a', 'file:///etc/passwd', 'https://user:pass@publisher.com/a', 'https://publisher.com:8080/a']) expect(publicArticleUrl(value)).toBeNull();
    for (const value of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0', '256.1.1.1']) expect(publicIpv4(value)).toBe(false);
    expect(publicIpv4('8.8.8.8')).toBe(true);
  });
  it('honors longest robots rules and specific agent groups', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /', new URL(url))).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /article', new URL(url))).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nUser-agent: CiteViaGEO\nAllow: /', new URL(url))).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*?private=true$', new URL(`${url}?private=true`))).toBe(false);
  });
  it('does not fetch the article after a robots denial or unavailable robots response', async () => {
    for (const status of [200, 403, 429, 503]) {
      const requested: string[] = [];
      const fetch: ArticleFetch = async target => { requested.push(target.href); return { status, body: 'User-agent: *\nDisallow: /', contentType: 'text/plain' }; };
      const result = await new GeoBacklinkArticleVerifier(fetch).verify(project, url, new Date(at));
      expect(result.brandPresence).toBe('unknown');
      expect(requested).toEqual(['https://publisher.com/robots.txt']);
    }
  });
  it('checks robots again on redirect destination, and never follows a private redirect', async () => {
    const requested: string[] = [];
    const fetch: ArticleFetch = async target => {
      requested.push(target.href);
      if (target.pathname === '/robots.txt') return { status: 404, body: '', contentType: 'text/plain' };
      if (target.hostname === 'publisher.com') return { status: 301, body: '', contentType: 'text/html', location: 'https://editorial.com/story' };
      return { status: 200, body: page('Northstar'), contentType: 'text/html' };
    };
    const result = await new GeoBacklinkArticleVerifier(fetch).verify(project, url, new Date(at));
    expect(result.url).toBe('https://editorial.com/story');
    expect(result.brandPresence).toBe('present');
    expect(requested).toEqual(['https://publisher.com/robots.txt', url, 'https://editorial.com/robots.txt', 'https://editorial.com/story']);
    const blockedFetch: ArticleFetch = async target => target.pathname === '/robots.txt'
      ? { status: 404, body: '', contentType: '' }
      : { status: 301, body: '', contentType: '', location: 'http://169.254.169.254/latest/meta-data/' };
    expect((await new GeoBacklinkArticleVerifier(blockedFetch).verify(project, url, new Date(at))).status).toBe('unavailable');
  });
  it('returns unknown for timeouts, rate limits and non-HTML content without inventing absence', async () => {
    for (const response of [{ status: 429, body: '', contentType: 'text/html' }, { status: 200, body: 'Plain text or binary', contentType: 'application/pdf' }]) {
      const fetch: ArticleFetch = async target => target.pathname === '/robots.txt' ? { status: 404, body: '', contentType: '' } : response;
      expect((await new GeoBacklinkArticleVerifier(fetch).verify(project, url, new Date(at))).brandPresence).toBe('unknown');
    }
    expect((await new GeoBacklinkArticleVerifier(async () => { throw new Error('timeout'); }).verify(project, url, new Date(at))).brandPresence).toBe('unknown');
  });
  it('retains a known redirect destination even when the destination cannot be verified', async () => {
    const fetch: ArticleFetch = async target => {
      if (target.pathname === '/robots.txt') return { status: 404, body: '', contentType: '' };
      if (target.hostname === 'publisher.com') return { status: 301, body: '', contentType: '', location: 'https://northstar.com/private' };
      return { status: 403, body: '', contentType: '' };
    };
    const result = await new GeoBacklinkArticleVerifier(fetch).verify(project, url, new Date(at));
    expect(result.url).toBe('https://northstar.com/private');
    expect(result.brandPresence).toBe('unknown');
  });
});
