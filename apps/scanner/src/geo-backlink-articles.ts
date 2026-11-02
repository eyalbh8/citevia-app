import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { geoBacklinkDomain, type Brand, type GeoBacklinkArticleEvidence, type Project } from '@citevia/core';

const USER_AGENT = 'CiteViaGEO/1.0';
export function unknownArticle(url: string, reason: string): GeoBacklinkArticleEvidence {
  return { status: 'unavailable', url, verifiedAt: null, title: null, publisher: null, brandPresence: 'unknown',
    competitors: [], brandPosition: null, hasBrandLink: null, links: [], topicRelevant: null, marketRelevant: null,
    outdated: null, placementOpportunity: 'unknown', excerpts: [], reason };
}
export function publicArticleUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !geoBacklinkDomain(raw)) return null;
    return url;
  } catch { return null; }
}
export function publicIpv4(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [a,b,c,d] = ip.split('.').map(Number);
  return [a,b,c,d].every(n => n >= 0 && n <= 255) && a > 0 && a < 224 &&
    ![10,127].includes(a) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || (b === 2))) && !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && [18,19,51].includes(b)) && !(a === 203 && b === 0 && c === 113);
}
interface RetrievedPage { status: number; body: string; contentType: string; location?: string }
export type ArticleFetch = (url: URL) => Promise<RetrievedPage>;
/** Pin a validated DNS address to the actual socket; validate every redirect separately. No cookies or credentials. */
export const fetchPublicArticle: ArticleFetch = async url => {
  if (!publicArticleUrl(url.href)) throw new Error('Non-public URL');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), 3000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(item => !publicIpv4(item.address))) throw new Error('Non-public DNS address');
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      family: 4,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, _options, cb) => cb(null, addresses[0].address, 4),
    }, response => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) req.destroy(new Error('Article exceeds retrieval limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'),
        contentType: response.headers['content-type'] || '', location: response.headers.location }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Article retrieval timeout')), 6000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
};
/** Conservative robots policy: specific agent groups override wildcard; longest rule wins. */
export function robotsAllows(text: string, url: URL): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[]; delayed: boolean }[] = [];
  let group = { agents: [] as string[], rules: [] as {allow:boolean;path:string}[], delayed: false }, hasRules = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.replace(/#.*/, '').trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const name = match[1].trim().toLowerCase(), value = match[2].trim();
    if (name === 'user-agent') {
      if (hasRules) { groups.push(group); group = { agents: [], rules: [], delayed: false }; hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (['allow','disallow','crawl-delay'].includes(name) && group.agents.length) {
      hasRules = true;
      if (name === 'crawl-delay' && Number(value) > 0) group.delayed = true;
      else if (value && name !== 'crawl-delay') group.rules.push({ allow: name === 'allow', path: value });
    }
  }
  groups.push(group);
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && USER_AGENT.toLowerCase().startsWith(a)));
  const applicable = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  if (applicable.some(group=>group.delayed)) return false;
  const path = url.pathname + url.search;
  const matches = applicable.flatMap(g => g.rules).filter(rule => {
    const anchored = rule.path.endsWith('$');
    const value = anchored ? rule.path.slice(0,-1) : rule.path;
    return new RegExp('^' + value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '')).test(path);
  }).sort((a,b) => b.path.length-a.path.length || Number(b.allow)-Number(a.allow));
  return !matches.length || matches[0].allow;
}
function decode(text: string) { return text.replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g, x => ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '}[x]!)).replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }); }
function plain(html: string) { return decode(html.replace(/<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g,' ').trim(); }
function attribute(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match ? decode(match[1] ?? match[2] ?? match[3]) : undefined;
}
function occurrences(text: string, brand: Brand) {
  const aliases = [...new Set([brand.name,...brand.aliases].map(n => n.trim()).filter(Boolean))].sort((a,b) => b.length-a.length);
  const pattern = aliases.map(n => n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  return pattern ? [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu'))].map(m => m.index!) : [];
}
export function articleEvidenceFromHtml(project: Project, url: string, html: string, at: string): GeoBacklinkArticleEvidence {
  if (/isAccessibleForFree["']?\s*:\s*(?:false|["']false["'])|subscribe to (?:continue|read)|sign in to (?:continue|read)|captcha|cf-chl-/i.test(html)) return unknownArticle(url,'Paywall or access challenge; article not verified.');
  const article = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2];
  if (!article) return unknownArticle(url,'A complete article body could not be identified.');
  const text = plain(article);
  if (text.length < 300) return unknownArticle(url,'Article body is too short to verify coverage.');
  const own = occurrences(text, project.brand);
  const competitorOffsets: number[] = [];
  const competitors = project.competitors.flatMap(brand => { const matches = occurrences(text,brand); if (matches.length) competitorOffsets.push(matches[0]); return matches.length ? [{id:brand.id,name:brand.name,position:null,mentions:matches.length}] : []; });
  const links: GeoBacklinkArticleEvidence['links'] = [];
  let malformedLinks = false;
  for (const match of article.matchAll(/<a\b([^>]+)>/gi)) {
    const href = attribute(match[1], 'href');
    if (!href) { if (/\bhref\s*=/i.test(match[1])) malformedLinks = true; continue; }
    try {
      const target = new URL(decode(href),url);
      if (!publicArticleUrl(target.href) || ![...project.brand.domains,...(project.brandbook?.domains || [])].some(domain => geoBacklinkDomain(domain) === geoBacklinkDomain(target.href))) continue;
      const rel = (attribute(match[1], 'rel') || '').toLowerCase().split(/\s+/);
      const type = rel.includes('sponsored') ? 'sponsored' : rel.includes('ugc') ? 'ugc' : rel.includes('nofollow') ? 'nofollow' : 'follow';
      links.push({url:target.href,type});
    } catch { /* Malformed link cannot be evidence. */ }
  }
  const normalized = text.toLocaleLowerCase();
  const topics = [project.brandbook?.industryCategory, project.brandbook?.subIndustryCategory,...project.prompts.filter(p=>p.active).map(p=>p.topic)].filter((v):v is string=>Boolean(v && v.length >= 4));
  const countryName = new Intl.DisplayNames(['en'],{type:'region'}).of(project.country) || project.country;
  return {status:'verified',url,verifiedAt:at,title:plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || null,
    publisher:new URL(url).hostname,brandPresence:own.length?'present':'absent',competitors,
    // Text offsets are not editorial rankings. Prominence uses mention counts only.
    brandPosition:null,brandMentions:own.length,hasBrandLink:links.length>0 ? true : malformedLinks ? null : false,links,
    topicRelevant:topics.some(topic=>normalized.includes(topic.toLocaleLowerCase())) ? true : null,
    marketRelevant:normalized.includes(countryName.toLocaleLowerCase()) ? true : null,
    outdated:null,placementOpportunity:'unknown',
    excerpts:[...own.slice(0,1),...competitorOffsets].slice(0,4).map(index=>text.slice(Math.max(0,index-90),index+180)),
    reason:'Verified from the publicly retrievable article body; text order is not a publisher rating.'};
}
export class GeoBacklinkArticleVerifier {
  constructor(private fetch: ArticleFetch = fetchPublicArticle) {}
  async verify(project: Project, raw: string, now: Date): Promise<GeoBacklinkArticleEvidence> {
    let url = publicArticleUrl(raw);
    if (!url) return unknownArticle(raw,'Not a public article URL.');
    const deadline = Date.now() + 15000;
    try {
      for (let redirects=0; redirects<=3; redirects++) {
        if (Date.now() >= deadline) return unknownArticle(url.href, 'Article verification time limit reached.');
        const robots = await this.fetch(new URL('/robots.txt',url.origin));
        if (robots.status !== 404 && (robots.status !== 200 || !robotsAllows(robots.body,url))) return unknownArticle(url.href,'Robots policy prevents verification.');
        const page = await this.fetch(url);
        if (page.status >= 300 && page.status < 400 && page.location) {
          url = publicArticleUrl(new URL(page.location,url).href);
          if (!url) return unknownArticle(raw,'Redirect destination is not public.');
          continue;
        }
        if (page.status !== 200 || !/text\/html|application\/xhtml\+xml/i.test(page.contentType)) return unknownArticle(url.href,`Article unavailable (HTTP ${page.status}).`);
        return articleEvidenceFromHtml(project,url.href,page.body,now.toISOString());
      }
      return unknownArticle(url.href,'Too many redirects.');
    } catch { return unknownArticle(url?.href || raw,'Retrieval failed or timed out; article presence remains unknown.'); }
  }
}
