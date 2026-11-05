import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { z } from 'zod';
import {
  DEFAULT_GEMINI_MODEL, DEFAULT_PERPLEXITY_PRESET, isBrandedPrompt, PARSER_VERSION, STAGE_INTENTS, trackedUrlKey,
  type Brandbook, type DemoConfig, type JourneyStage, type Project,
} from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';

export const SERVICE_DEMO_DATES = { anchorDate: '2026-10-25', startDate: '2026-04-25', endDate: '2027-04-25' } as const;
export function serviceDemoDates(anchorDate = SERVICE_DEMO_DATES.anchorDate as string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !Number.isFinite(Date.parse(`${anchorDate}T00:00:00Z`)) ||
    new Date(`${anchorDate}T00:00:00Z`).toISOString().slice(0, 10) !== anchorDate)
    throw new Error('Supply a valid scenario anchor date in YYYY-MM-DD format.');
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  const shift = (months: number) => {
    const date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    return date.toISOString().slice(0, 10);
  };
  return { anchorDate, startDate: shift(-6), endDate: shift(6) };
}
export const SERVICE_DEMO_CONTENT_ORIGIN = 'https://app.citevia.io';
const publicUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
    url.hostname.includes('.') && !/\.(example|invalid|test|local)$/i.test(url.hostname) && !/^\d+(\.\d+){3}$/.test(url.hostname);
}, 'Use a public website URL without credentials or a custom port.');
const textList = z.array(z.string().trim().min(1).max(300)).max(30);
const sourceDate = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use a valid source date.');
function supportedSocialUrl(value: string) {
  const url = new URL(value), host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.protocol !== 'https:') return false;
  if (host === 'youtube.com') return url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '');
  if (host === 'youtu.be') return /^\/[\w-]{11}\/?$/.test(url.pathname);
  return host === 'reddit.com' && /^\/r\/[\w]+\/comments\/[a-z0-9]+(?:\/|$)/i.test(url.pathname);
}
const sourceReference = z.union([publicUrl, z.object({
  url: publicUrl, title: z.string().max(300).optional(), kind: z.enum(['official', 'independent']).optional(),
  claims: textList.optional(), field: z.string().max(100).optional(), quote: z.string().min(1).max(2000).optional(),
})]).transform(value => typeof value === 'string' ? { url: value } : value);
const profileSchema = z.object({
  visibilityAdjustment: z.number().min(-.2).max(.2).optional(), growthCurve: z.number().min(.5).max(2).optional(),
  trafficScale: z.number().min(.01).max(10).optional(), monthlyGrowth: z.number().min(0).max(.25).optional(),
}).strict();
const copySchema = z.object({
  introduction: z.string().trim().min(10).max(1000), positiveCompany: z.string().min(5).max(600),
  neutralCompany: z.string().min(5).max(600).optional(), fallback: z.string().trim().min(10).max(1000),
});
export const serviceDemoSourceSchema = z.object({
  id: z.string().regex(/^account_[a-z0-9][a-z0-9_-]{0,80}_demo_v1$/), name: z.string().trim().min(1).max(120),
  website: publicUrl, aliases: textList.default([]), country: z.string().regex(/^[A-Za-z]{2}$/),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).default('en'), timezone: z.string().default('UTC'),
  anchorDate: z.string().optional(),
  companyDiscovery: z.literal(true).optional(),
  dashboardComparison: z.literal('scenario_start').optional(),
  publicationAlignment: z.literal('scans').optional(),
  reportingProfile: z.enum(['uk_investing', 'merchant_payments']).optional(),
  industry: z.string().trim().min(2).max(150), serviceArea: z.string().trim().min(2).max(150),
  services: z.array(z.string().trim().min(2).max(100)).min(5).max(30), audience: textList.min(1),
  description: z.string().trim().min(20).max(4000), criteria: textList.optional(),
  competitors: z.array(z.object({ name: z.string().trim().min(1).max(120), website: publicUrl,
    aliases: textList.default([]), sourceUrls: z.array(publicUrl).max(10).default([]) })).length(5),
  sources: z.array(sourceReference).min(1).max(30),
  blogs: z.array(z.object({ url: publicUrl, title: z.string().trim().min(1).max(200),
    contentType: z.enum(['BLOG', 'WEBSITE']).default('BLOG'), imageUrl: publicUrl.optional(),
    sourcePublishedAt: sourceDate.optional(), sourceTrackedAt: sourceDate.optional() })).min(1).max(1000),
  socialLinks: z.array(z.object({
    url: publicUrl.refine(supportedSocialUrl, 'Use a public YouTube video or Reddit discussion URL.'),
    title: z.string().trim().min(1).max(200), imageUrl: publicUrl.optional(),
    sourcePublishedAt: sourceDate.optional(), sourceTrackedAt: sourceDate.optional(),
  })).max(1000).default([]),
  prompts: z.array(z.object({ text: z.string().trim().min(5).max(2000),
    stage: z.enum(['understand', 'prefer', 'trust', 'convert']).optional(), topic: z.string().max(200).optional(),
    seoKeyword: z.string().nullable().optional(), tags: textList.optional() })).length(50).optional(),
  brandbook: z.object({
    keyFeatures: textList.optional(), toneOfVoice: textList.optional(), values: textList.optional(), personality: textList.optional(),
    targetAudience: textList.optional(), industryCategory: z.string().max(300).optional(), subIndustryCategory: z.string().max(300).optional(),
    sitemapUrl: publicUrl.nullable().optional(), caseStudiesSourceUrl: publicUrl.nullable().optional(),
    postGuidelines: z.object({ dos: textList, donts: textList }).optional(), unknowns: textList.optional(),
  }).default({}), copy: copySchema.optional(), profile: profileSchema.optional(),
  traffic: z.object({ pages: textList.optional(), countries: textList.optional(), browsers: textList.optional(), devices: textList.optional() }).optional(),
});
export type ServiceDemoSource = z.input<typeof serviceDemoSourceSchema>;
type ParsedSource = z.output<typeof serviceDemoSourceSchema>;
const domain = (value: string) => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
const owns = (value: string, official: string) => domain(value) === official || domain(value).endsWith(`.${official}`);
const unique = (values: string[]) => [...new Set(values)];
const isoDate = (value?: string) => value ? new Date(value).toISOString() : undefined;
const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

function audienceFor(source: ParsedSource, service: string) {
  const preferred = /commercial|business|access control/i.test(service) ? /business|commercial|property manager/i
    : /\bcar\b|vehicle|automotive|\bfob\b/i.test(service) ? /vehicle|driver|motorist/i
      : /home|residential/i.test(service) ? /homeowner|residential/i : undefined;
  return (preferred && source.audience.find(audience => preferred.test(audience))) || source.audience[0];
}

function generatedPrompts(source: ParsedSource) {
  const area = source.serviceArea, brand = source.name;
  const stages: JourneyStage[] = ['understand', 'understand', 'understand', 'prefer', 'prefer', 'prefer', 'trust', 'trust', 'convert', 'convert'];
  return source.services.slice(0, 5).flatMap(service => {
    const offering = service.toLowerCase(), audience = audienceFor(source, service).toLowerCase();
    return [
      `What should ${audience} know about ${offering} in ${area}?`,
      `When is ${offering} worth considering in ${area}?`,
      `What is usually included in ${offering} in ${area}?`,
      `Which providers offer ${offering} in ${area}?`,
      `How should I compare ${offering} providers in ${area}?`,
      `What are the alternatives to ${brand} for ${offering} in ${area}?`,
      `What should I verify before choosing ${offering} in ${area}?`,
      `How can I assess ${brand}'s experience with ${offering}?`,
      `What affects the cost of ${offering} in ${area}?`,
      `How can I request ${offering} in ${area}?`,
    ].map((text, index) => ({ text, stage: stages[index], topic: service, seoKeyword: `${offering} ${area}` }));
  });
}

function stageFor(text: string): JourneyStage {
  if (/trust|safe|licen[cs]|certif|warrant|review|insur|reliab|experience|verify/i.test(text)) return 'trust';
  if (/cost|price|quote|book|request|contact|purchase/i.test(text)) return 'convert';
  return /best|compar|alternativ|provider|recommend/i.test(text) ? 'prefer' : 'understand';
}

export function serviceDemoProfile(id: string): NonNullable<DemoConfig['profile']> {
  const seed = createHash('sha256').update(id).digest().readUInt32BE(0);
  return { visibilityAdjustment: ((seed % 11) - 5) / 100, growthCurve: (96 + seed % 13) / 100,
    trafficScale: (85 + seed % 31) / 100, monthlyGrowth: (9 + seed % 3) / 100 };
}

function weeklyPublicationDates(window = serviceDemoDates()) {
  const dates: string[] = [];
  for (let day = Date.parse(`${window.startDate}T00:00:00Z`); day <= Date.parse(`${window.endDate}T23:59:59Z`); day += 86400000)
    if ([1, 3, 5].includes(new Date(day).getUTCDay())) dates.push(`${new Date(day).toISOString().slice(0, 10)}T08:00:00.000Z`);
  return dates;
}

export function alignDemoTrackingToScans(items: NonNullable<DemoConfig['trackedUrls']>,
  window: Pick<DemoConfig, 'startDate' | 'endDate'>, slots = [600, 5640], includeOpeningScan = false): NonNullable<DemoConfig['trackedUrls']> {
  const start = Date.parse(`${window.startDate}T00:00:00Z`), end = Date.parse(`${window.endDate}T23:59:59Z`);
  const monday = start - ((new Date(start).getUTCDay() + 6) % 7) * 86400000;
  const scans: number[] = includeOpeningScan ? [start] : [];
  for (let week = monday; week <= end; week += 7 * 86400000)
    for (const slot of slots) { const at = week + slot * 60000; if (at >= start && at <= end) scans.push(at); }
  scans.sort((a, b) => a - b);
  if (!scans.length) throw new Error('Publication alignment requires a scan in the scenario window.');
  return items.map(item => {
    // Publication and enrollment precede a capture on the same scenario day.
    const dayEnd = Date.parse(`${item.publishedAt.slice(0, 10)}T23:59:59Z`);
    const at = [...scans].reverse().find(at => at <= dayEnd) ?? scans[0];
    const publishedAt = new Date(Math.max(start, at - 2 * 3600000)).toISOString();
    return { ...item, publishedAt, createdAt: publishedAt };
  });
}

/** Stagger scenario publication before the enrolled scan where the URL is first cited. */
export function withDemoPublicationLeadTimes(items: NonNullable<DemoConfig['trackedUrls']>,
  window: Pick<DemoConfig, 'startDate' | 'anchorDate'>, finalWeekEnd?: string): NonNullable<DemoConfig['trackedUrls']> {
  const day = 86_400_000;
  const start = Date.parse(window.startDate), anchor = Date.parse(window.anchorDate);
  const finalWeekStart = finalWeekEnd ? Date.parse(finalWeekEnd) - 6 * day : Infinity;
  return items.map(item => {
    const createdAt = item.createdAt || item.publishedAt;
    const enrolledDay = Date.parse(createdAt.slice(0, 10));
    // Keep the anchor week's publications visible and future releases in the future.
    const earliest = enrolledDay >= finalWeekStart ? finalWeekStart : enrolledDay > anchor ? anchor + day
      : enrolledDay >= anchor - 6 * day ? Math.max(start, anchor - 6 * day) : start;
    const maxLead = Math.max(0, Math.min(14, (enrolledDay - earliest) / day));
    const seed = createHash('sha256').update(trackedUrlKey(item.url) || item.url).digest().readUInt32BE(0);
    const lead = seed % (maxLead + 1);
    const publishedAt = new Date(Date.parse(createdAt) - lead * day).toISOString();
    return { ...item, createdAt, publishedAt };
  });
}

type TrackingCatalog = Pick<ParsedSource, 'blogs' | 'socialLinks' | 'website' | 'anchorDate' | 'publicationAlignment'>
  & Pick<DemoConfig, 'reportingProfile'>;

export function trackedContent(source: TrackingCatalog, existing: NonNullable<DemoConfig['trackedUrls']> = []): NonNullable<DemoConfig['trackedUrls']> {
  const window = serviceDemoDates(source.anchorDate), dates = weeklyPublicationDates(window), official = domain(source.website);
  const imported = source.reportingProfile === 'residential_roofing' || source.reportingProfile === 'unattended_payments';
  const anchorSlot = dates.filter(date => date.slice(0, 10) <= window.anchorDate).length - 1;
  const dateFor = (index: number, count: number) => {
    if (!imported) return dates[Math.floor(index * dates.length / count)];
    // Each new channel has a publication in the anchor week and spans both halves of the reporting year.
    const middle = Math.floor(count / 2);
    if (index === middle) return dates[anchorSlot];
    const position = index < middle ? index * anchorSlot / middle
      : anchorSlot + (index - middle) * (dates.length - 1 - anchorSlot) / (count - 1 - middle);
    return dates[Math.round(position)];
  };
  const enrolled = new Set(existing.map(item => trackedUrlKey(item.url)));
  for (const blog of source.blogs) if (!owns(blog.url, official) || !trackedUrlKey(blog.url))
    throw new Error('Verified public articles must use the official company website.');
  const articles = [...new Map(source.blogs.map(blog => [trackedUrlKey(blog.url), blog])).values()]
    .filter(blog => !enrolled.has(trackedUrlKey(blog.url))).slice(0, dates.length);
  // Enrollment dates belong to the scenario; source publication dates remain separate.
  // Reuse only researched pages, never invent URLs or manufacture unique query strings.
  const blogs = articles.map((blog, index) => {
    const publishedAt = dateFor(index, articles.length);
    return { ...blog, sourcePublishedAt: isoDate(blog.sourcePublishedAt), sourceTrackedAt: isoDate(blog.sourceTrackedAt),
      publishedAt, createdAt: publishedAt };
  });
  const social = [...new Map(source.socialLinks.map(link => [trackedUrlKey(link.url), link])).values()]
    .filter(link => !enrolled.has(trackedUrlKey(link.url)));
  // Each platform spans the scenario independently, keeping both visible in retrospective ranges.
  const groups = [social.filter(link => domain(link.url) !== 'reddit.com'), social.filter(link => domain(link.url) === 'reddit.com')];
  const additions = [...blogs, ...groups.flatMap(links => links.slice(0, dates.length).map((link, index) => {
    const publishedAt = dateFor(index, Math.min(links.length, dates.length));
    return { ...link, contentType: 'SOCIAL' as const,
      sourcePublishedAt: isoDate(link.sourcePublishedAt), sourceTrackedAt: isoDate(link.sourceTrackedAt),
      publishedAt, createdAt: publishedAt };
  }))];
  const aligned = source.publicationAlignment === 'scans' ? alignDemoTrackingToScans(additions, window, undefined, imported || source.reportingProfile === 'merchant_payments') : additions;
  const scheduled = source.reportingProfile ? withDemoPublicationLeadTimes(aligned, window, imported ? window.endDate : undefined) : aligned;
  return [...existing, ...scheduled.map(item => {
    if (!imported || !item.sourcePublishedAt || item.sourcePublishedAt <= item.publishedAt) return item;
    if (item.sourcePublishedAt.slice(0, 10) > window.endDate) throw new Error('A source was published after the reporting year.');
    const createdAt = item.createdAt && item.createdAt >= item.sourcePublishedAt ? item.createdAt : item.sourcePublishedAt;
    return { ...item, publishedAt: item.sourcePublishedAt, createdAt };
  })];
}

const catalogSchema = serviceDemoSourceSchema.pick({ blogs: true, socialLinks: true, sources: true });

type ImportedReportIdentity = {
  id: string; name: string; domain: string; sourceAccountId: string;
  source: 'igeo-dr-roof' | 'igeo-nayax';
  reportingProfile: 'residential_roofing' | 'unattended_payments';
};

/** Upgrade an explicitly identified import, keeping its original measurements, settings and enrollments. */
export async function syncImportedReporting(repository: Pick<Repository, 'getProject' | 'saveProject'>,
  identity: ImportedReportIdentity, value: unknown, apply: boolean, now: Date, requestedAnchor?: string) {
  const catalog = catalogSchema.parse(value);
  const project = await repository.getProject(identity.id), config = project?.demo;
  const brandMatches = project?.brand.domains.some(value => {
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      return !url.username && !url.password && url.hostname.toLowerCase().replace(/^www\./, '') === identity.domain;
    } catch { return false; }
  });
  if (!project || project.id !== identity.id || project.enabled || !config || config.source !== identity.source ||
    config.version !== 1 || config.sourceAccountId !== identity.sourceAccountId || config.presentation ||
    (config.reportingProfile && config.reportingProfile !== identity.reportingProfile) || !brandMatches ||
    (identity.source === 'igeo-nayax' && normalized(project.brand.name) !== 'nayax'))
    throw new Error(`Reporting updates require the matching disabled ${identity.name} account.`);
  const dates = serviceDemoDates(requestedAnchor ?? (config.reportingProfile ? config.anchorDate : now.toISOString().slice(0, 10)));
  if (config.reportingProfile && (config.anchorDate !== dates.anchorDate || config.startDate !== dates.startDate ||
    config.endDate !== dates.endDate || config.publicationAlignment !== 'scans'))
    throw new Error('Reporting updates must preserve the saved reporting year.');
  const enrolled = config.trackedUrls ?? [];
  const trackedUrls = trackedContent({ ...catalog, website: `https://${identity.domain}`, anchorDate: dates.anchorDate,
    publicationAlignment: 'scans', reportingProfile: identity.reportingProfile }, enrolled);
  const keys = new Set(trackedUrls.map(item => trackedUrlKey(item.url)));
  if ([...catalog.blogs, ...catalog.socialLinks].some(item => !keys.has(trackedUrlKey(item.url))))
    throw new Error('The reporting year has too few publication slots for this catalog.');
  const references = new Map(config.referenceSources?.map(row => [trackedUrlKey(row.url), row]));
  for (const { url, title } of catalog.sources) references.set(trackedUrlKey(url), { url, title });
  // Compare JSON as stored. Absent optional properties must not cause a write on retries.
  const desiredConfig: DemoConfig = { ...config, ...dates, reportingProfile: identity.reportingProfile,
    publicationAlignment: 'scans', referenceSources: [...references.values()], trackedUrls };
  const unchanged = isDeepStrictEqual(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(desiredConfig)));
  const desired: Project = unchanged ? project : { ...project, demo: desiredConfig, version: project.version + 1, updatedAt: now.toISOString() };
  const configurationBytes = Buffer.byteLength(JSON.stringify(desired));
  if (configurationBytes > 250000) throw new Error('Compact reporting configuration exceeds 250 KB.');
  if (apply && !unchanged && !await repository.saveProject(desired, project.version))
    throw new Error('Account changed concurrently; retry to inspect it.');
  return { status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview', projectId: project.id, version: desired.version,
    ...dates, trackedUrls: trackedUrls.length, added: trackedUrls.length - enrolled.length,
    referenceSources: references.size, configurationBytes };
}

/** Public website metadata creates a compact synthetic scenario, never historical customer measurements. */
export function buildServiceDemo(value: unknown, copiedAt = new Date().toISOString()): Project {
  const source = serviceDemoSourceSchema.parse(value), official = domain(source.website);
  const dates = serviceDemoDates(source.anchorDate);
  if (!Number.isFinite(Date.parse(copiedAt))) throw new Error('Supply a valid copy timestamp.');
  if (new Set(source.services.map(normalized)).size < 5) throw new Error('Supply at least five distinct verified services.');
  if (new Set(source.competitors.map(item => normalized(item.name))).size !== 5 ||
    new Set(source.competitors.map(item => domain(item.website))).size !== 5 ||
    source.competitors.some(item => owns(item.website, official) ||
      [source.name, ...source.aliases].some(name => normalized(item.name) === normalized(name))))
    throw new Error('Supply five distinct verified competitors, excluding the selected company.');
  const officialReferences = source.sources.filter(item => item.kind === 'official' || (!item.kind && owns(item.url, official)));
  const independentReferences = source.sources.filter(item => item.kind === 'independent' || (!item.kind && !owns(item.url, official)));
  if (!independentReferences.length) throw new Error('Include an independent public reference for citation variety.');
  const knowledgeSources = unique([source.website, ...source.sources.map(item => item.url),
    ...source.competitors.flatMap(item => [item.website, ...item.sourceUrls])]);
  if (knowledgeSources.length > 30) throw new Error('Keep the researched source list within the brandbook limit of 30 URLs.');
  const brand = { id: 'target', name: source.name, aliases: source.aliases, domains: [official] };
  const prompts = source.prompts || generatedPrompts(source);
  if (new Set(prompts.map(prompt => normalized(prompt.text))).size !== 50) throw new Error('Supply fifty distinct industry-specific questions.');
  const at = `${dates.startDate}T00:00:00.000Z`, raw = source.brandbook;
  const brandbook: Brandbook = {
    about: source.description, industryCategory: raw.industryCategory || source.industry,
    subIndustryCategory: raw.subIndustryCategory || source.services[0], companyCountry: source.country.toUpperCase(), language: source.language,
    names: [source.name, ...source.aliases], domains: [official], keyFeatures: raw.keyFeatures || source.services,
    toneOfVoice: raw.toneOfVoice || [], values: raw.values || [], personality: raw.personality || [], targetAudience: raw.targetAudience || source.audience,
    knowledgeSources, sitemapUrl: raw.sitemapUrl || null, caseStudiesSourceUrl: raw.caseStudiesSourceUrl || null, caseStudies: [],
    postGuidelines: raw.postGuidelines || { dos: ['Use the supplied public sources.', 'Explain services in clear, practical language.'],
      donts: ['Invent credentials, guarantees, prices or customer testimonials.', 'Publish estimates as verified business results.'] },
    evidence: source.sources.filter(item => item.quote).map(item => ({ field: item.field || 'about', quote: item.quote!, url: item.url })),
    unknowns: raw.unknowns || [], generatedAt: new Date(copiedAt).toISOString(), model: 'public-website-demo', version: 1,
    generationId: `website-demo:${official}`,
  };
  const criteria = source.criteria || ['Service suitability', 'The proposed scope', 'Costs and scheduling'];
  const citationPool = unique([source.blogs[0].url, source.website, independentReferences[0].url,
    ...officialReferences.map(item => item.url), ...independentReferences.map(item => item.url)]);
  const project: Project = {
    id: source.id, name: source.name, brand,
    competitors: source.competitors.map((item, index) => ({ id: `${source.id}-competitor-${index + 1}`, name: item.name,
      aliases: item.aliases, domains: [domain(item.website)] })), competitorsConfiguredAt: copiedAt,
    country: source.country.toUpperCase(), language: source.language, timezone: source.timezone,
    enabled: false, scheduleExpression: 'cron(0 6 ? * MON *)', scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] }, scheduleStatus: 'synced',
    generationModel: 'gpt-4.1-2025-04-14', extractionModel: 'gpt-6-luna', parserVersion: PARSER_VERSION, version: 1,
    scanProviders: [{ provider: 'openai', model: 'gpt-4.1-2025-04-14' }, { provider: 'perplexity', model: DEFAULT_PERPLEXITY_PRESET },
      { provider: 'gemini', model: DEFAULT_GEMINI_MODEL }],
    prompts: prompts.map((prompt, index) => { const stage = prompt.stage || stageFor(prompt.text); return {
      id: `${source.id}-p${String(index + 1).padStart(2, '0')}`, text: prompt.text, version: 1, active: true,
      branded: isBrandedPrompt(prompt.text, brand), stage, topic: prompt.topic || source.industry, intent: STAGE_INTENTS[stage][0],
      seoKeyword: prompt.seoKeyword || undefined, tags: 'tags' in prompt ? prompt.tags || [] : [source.industry], createdAt: at, updatedAt: at,
    }; }), brandbook, createdAt: at, updatedAt: copiedAt,
    demo: { version: 1, source: 'website-demo', ...dates, companyDiscovery: source.companyDiscovery,
      dashboardComparison: source.dashboardComparison, publicationAlignment: source.publicationAlignment,
      reportingProfile: source.reportingProfile,
      sourceAccountId: `website:${official}`, sourceCopiedAt: copiedAt,
      profile: { ...serviceDemoProfile(source.id), ...source.profile },
      industry: { label: source.industry, audience: source.audience.join('; '), services: source.services, criteria }, copy: source.copy,
      samples: source.services.slice(0, 5).map((service, index) => ({ promptText: prompts[index * 10].text,
        answerText: `${source.name} lists ${service.toLowerCase()} among its services in ${source.serviceArea}. ${source.description}`.slice(0, 2500),
        citations: unique([source.blogs[index % source.blogs.length].url, source.competitors[index].website,
          independentReferences[index % independentReferences.length].url, source.website,
          ...officialReferences.map(item => item.url), ...independentReferences.map(item => item.url)]).slice(0, 8)
          .map(url => ({ url, title: source.sources.find(item => item.url === url)?.title ||
            source.blogs.find(item => item.url === url)?.title || source.competitors.find(item => item.website === url)?.name })),
        companies: index === 0 ? [source.name, ...source.competitors.map(item => item.name)] : undefined })),
      traffic: { pages: source.traffic?.pages || unique(['/', ...source.blogs.slice(0, 5).map(item => new URL(item.url).pathname)]),
        countries: source.traffic?.countries || [source.country.toUpperCase(), 'GB', 'CA', 'AU'],
        devices: source.traffic?.devices || ['desktop', 'mobile', 'tablet'], browsers: source.traffic?.browsers || ['Chrome', 'Safari', 'Edge', 'Firefox'] },
      trackedUrls: trackedContent(source),
    },
  };
  validateServiceDemo(project);
  return project;
}

function validateServiceDemo(project: Project) {
  const dates = serviceDemoDates(project.demo?.anchorDate);
  if (!/^account_[a-z0-9][a-z0-9_-]{0,80}_demo_v1$/.test(project.id) || project.demo?.source !== 'website-demo' ||
    project.demo.sourceAccountId !== `website:${project.brand.domains[0]}` || project.enabled ||
    project.prompts.length !== 50 || project.competitors.length !== 5 || !project.demo.trackedUrls?.length ||
    Object.entries(dates).some(([key, value]) => project.demo![key as keyof typeof SERVICE_DEMO_DATES] !== value) ||
    JSON.stringify(project.scanSchedule?.slotsUtcMinutes) !== '[600,5640]' ||
    JSON.stringify(project.scanProviders?.map(item => item.provider)) !== '["openai","perplexity","gemini"]')
    throw new Error('Refusing to save a configuration without a complete public website demo identity.');
  const seen = new Set<string>();
  for (const article of project.demo.trackedUrls) {
    const key = trackedUrlKey(article.url);
    if (!key || seen.has(key)) throw new Error('Demo publications require distinct normalized URLs.');
    seen.add(key);
    if (article.demoPost || (article.contentType === 'SOCIAL'
      ? !supportedSocialUrl(article.url) : !owns(article.url, project.brand.domains[0])))
      throw new Error('Tracked articles must belong to the selected company website; social links require a YouTube video or Reddit discussion.');
  }
}

export async function createServiceDemo(repository: Pick<Repository, 'getProject' | 'saveProject'>, project: Project, apply = false) {
  validateServiceDemo(project);
  const existing = await repository.getProject(project.id);
  if (existing && (existing.demo?.source !== 'website-demo' || existing.demo.sourceAccountId !== project.demo!.sourceAccountId ||
    existing.brand.domains[0] !== project.brand.domains[0])) throw new Error('Refusing to replace an existing real account or another website demo.');
  const bytes = Buffer.byteLength(JSON.stringify(project));
  if (bytes > 250000) throw new Error('Compact demo configuration exceeds 250 KB.');
  if (existing) return { status: 'exists', projectId: existing.id, configurationBytes: Buffer.byteLength(JSON.stringify(existing)) };
  if (apply && !await repository.saveProject(project, null)) throw new Error('Account changed concurrently; retry to inspect it.');
  return { status: apply ? 'created' : 'preview', projectId: project.id, name: project.name, prompts: project.prompts.length,
    competitors: project.competitors.length, trackedUrls: project.demo!.trackedUrls!.length,
    officialArticles: project.demo!.trackedUrls!.filter(article => !article.demoPost && article.contentType !== 'SOCIAL').length,
    socialLinks: project.demo!.trackedUrls!.filter(article => article.contentType === 'SOCIAL').length,
    demoArticles: project.demo!.trackedUrls!.filter(article => article.demoPost).length,
    ...serviceDemoDates(project.demo!.anchorDate), scansPerWeek: 2, providers: 3, configurationBytes: bytes,
    persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 };
}

/** Add researched tracking content without reenrolling existing URLs or replacing account settings. */
export async function expandServiceDemoTracking(
  repository: Pick<Repository, 'getProject' | 'saveProject'>, value: unknown, apply = false, now = new Date(),
) {
  const source = serviceDemoSourceSchema.parse(value), built = buildServiceDemo(source, now.toISOString());
  const existing = await repository.getProject(source.id);
  if (!existing?.demo || existing.enabled || existing.demo.presentation || existing.demo.source !== 'website-demo' ||
    existing.demo.sourceAccountId !== built.demo!.sourceAccountId || existing.brand.domains[0] !== built.brand.domains[0])
    throw new Error('Tracking expansion requires the matching disabled website demo account.');
  if (source.anchorDate !== existing.demo.anchorDate || built.demo!.startDate !== existing.demo.startDate ||
    built.demo!.endDate !== existing.demo.endDate)
    throw new Error('Tracking expansion must preserve the explicitly supplied saved scenario timeline.');
  const trackedUrls: NonNullable<DemoConfig['trackedUrls']> = JSON.parse(JSON.stringify(trackedContent(source, existing.demo.trackedUrls)));
  const unchanged = isDeepStrictEqual(existing.demo.trackedUrls, trackedUrls);
  const desired: Project = unchanged ? existing : { ...existing, version: existing.version + 1, updatedAt: now.toISOString(),
    demo: { ...existing.demo, trackedUrls } };
  validateServiceDemo(desired);
  if (Buffer.byteLength(JSON.stringify(desired)) > 250000) throw new Error('Compact demo configuration exceeds 250 KB.');
  if (apply && !unchanged && !await repository.saveProject(desired, existing.version))
    throw new Error('Account changed concurrently; retry to inspect it.');
  return { status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview', projectId: existing.id,
    previousTrackedUrls: existing.demo.trackedUrls?.length || 0, trackedUrls: trackedUrls.length,
    added: trackedUrls.length - (existing.demo.trackedUrls?.length || 0),
    blogs: trackedUrls.filter(item => item.contentType === 'BLOG').length,
    youtube: trackedUrls.filter(item => item.contentType === 'SOCIAL' && domain(item.url) !== 'reddit.com').length,
    reddit: trackedUrls.filter(item => item.contentType === 'SOCIAL' && domain(item.url) === 'reddit.com').length,
    paidCalls: 0 };
}

/** Synchronize a curated report profile using the saved project version. */
export async function syncServiceDemoReporting(
  repository: Pick<Repository, 'getProject' | 'saveProject'>, value: unknown, apply = false, now = new Date(),
) {
  const source = serviceDemoSourceSchema.parse(value), existing = await repository.getProject(source.id);
  const demo = existing?.demo;
  if (!existing || !demo || existing.enabled || demo.presentation || demo.source !== 'website-demo' ||
    !source.reportingProfile || !source.anchorDate || source.publicationAlignment !== 'scans' ||
    demo.sourceAccountId !== `website:${domain(source.website)}` || existing.brand.domains[0] !== domain(source.website) ||
    (demo.reportingProfile && demo.reportingProfile !== source.reportingProfile))
    throw new Error('Reporting updates require the matching disabled website account and reporting profile.');
  validateServiceDemo(existing);

  // Older payment accounts enrolled a few articles on a sparse timeline. Adopt the
  // curated reporting year once; subsequent syncs must respect its saved dates.
  const firstPaymentUpgrade = source.reportingProfile === 'merchant_payments' && !demo.reportingProfile && !demo.publicationAlignment;
  if (!firstPaymentUpgrade && (demo.publicationAlignment !== 'scans' || source.anchorDate !== demo.anchorDate))
    throw new Error('Reporting updates require a matching saved scenario timeline.');
  const configured = firstPaymentUpgrade ? buildServiceDemo(source, now.toISOString()).demo! : demo;
  const trackedUrls = firstPaymentUpgrade ? configured.trackedUrls! : withDemoPublicationLeadTimes(demo.trackedUrls!, demo);
  const keys = new Set(trackedUrls.map(row => trackedUrlKey(row.url)));
  if (demo.trackedUrls!.some(row => !keys.has(trackedUrlKey(row.url))))
    throw new Error('The updated tracking catalog must retain every previously enrolled URL.');

  // JSON storage omits optional undefined fields. Compare the same representation on retries.
  const reporting = JSON.parse(JSON.stringify({
    ...demo, ...serviceDemoDates(source.anchorDate), reportingProfile: source.reportingProfile,
    publicationAlignment: source.publicationAlignment, dashboardComparison: source.dashboardComparison ?? demo.dashboardComparison,
    profile: configured.profile, traffic: configured.traffic, samples: configured.samples, trackedUrls,
  })) as DemoConfig;
  const unchanged = isDeepStrictEqual(demo, reporting);
  const desired: Project = unchanged ? existing : { ...existing, updatedAt: now.toISOString(), version: existing.version + 1, demo: reporting };
  validateServiceDemo(desired);
  if (Buffer.byteLength(JSON.stringify(desired)) > 250000) throw new Error('Compact demo configuration exceeds 250 KB.');
  if (apply && !unchanged && !await repository.saveProject(desired, existing.version))
    throw new Error('Account changed concurrently; retry to inspect it.');
  const previousDates = new Map(demo.trackedUrls!.map(row => [trackedUrlKey(row.url), row.publishedAt]));
  return { status: unchanged ? 'unchanged' : apply ? 'updated' : 'preview', projectId: source.id, version: desired.version,
    reportingProfile: source.reportingProfile, trackedUrls: trackedUrls.length, added: trackedUrls.length - previousDates.size,
    updatedPublicationDates: trackedUrls.filter(row => previousDates.has(trackedUrlKey(row.url)) && previousDates.get(trackedUrlKey(row.url)) !== row.publishedAt).length };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { source: { type: 'string' }, mode: { type: 'string', default: 'local' },
    apply: { type: 'boolean' }, 'expand-tracking': { type: 'boolean' }, 'sync-reporting': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('npm run demo:service -- --source /private/path/public-website-sources.json --mode local|aws [--expand-tracking | --sync-reporting] [--apply]\nSource accepts one account, an array, or {accounts:[...]}. Defaults to preview. First-time payment reporting upgrades adopt the source timeline. Later updates preserve enrollments. Never calls iGEO or an AI provider.'); return; }
  if (values['expand-tracking'] && values['sync-reporting']) throw new Error('Choose one update mode.');
  if (!values.source || !['local', 'aws'].includes(values.mode)) throw new Error('Supply --source and choose --mode local|aws.');
  const value = JSON.parse(await readFile(resolve(values.source), 'utf8'));
  const sources = Array.isArray(value) ? value : Array.isArray(value?.accounts) ? value.accounts : [value];
  if (!sources.length) throw new Error('Supply at least one public website account source.');
  const copiedAt = new Date().toISOString(), projects = sources.map((source: unknown) => buildServiceDemo(source, copiedAt));
  if (new Set(projects.map((project: Project) => project.id)).size !== projects.length ||
    new Set(projects.map((project: Project) => project.demo!.sourceAccountId)).size !== projects.length)
    throw new Error('Each account in a source batch must have a distinct id and official website.');
  const db = await openConfigurationDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const repository = new PostgresRepository(db), results = [];
    for (const [index, project] of projects.entries()) results.push(values['sync-reporting']
      ? await syncServiceDemoReporting(repository, sources[index], values.apply) : values['expand-tracking']
      ? await expandServiceDemoTracking(repository, sources[index], values.apply)
      : await createServiceDemo(repository, project, values.apply));
    console.log(JSON.stringify(results, null, 2));
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Service demo creation failed'); process.exitCode = 1; });
