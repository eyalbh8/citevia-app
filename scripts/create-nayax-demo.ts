import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { z } from 'zod';
import { DEFAULT_GEMINI_MODEL, DEFAULT_PERPLEXITY_PRESET, isBrandedPrompt, PARSER_VERSION, STAGE_INTENTS, type Brandbook, type JourneyStage, type Project } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';

export const NAYAX_DEMO_ID = 'account_nayax_demo_v1';
const providers = () => [
  { provider: 'openai' as const, model: 'gpt-4.1-2025-04-14' },
  { provider: 'perplexity' as const, model: DEFAULT_PERPLEXITY_PRESET },
  { provider: 'gemini' as const, model: DEFAULT_GEMINI_MODEL },
];
const brandSchema = z.object({ name: z.string().min(1), aliases: z.array(z.string()).default([]), domains: z.array(z.string()).min(1) });
const sourceSchema = z.object({
  brand: brandSchema,
  competitors: z.array(brandSchema).max(30),
  prompts: z.array(z.object({
    text: z.string().min(5).max(2000), stage: z.string().optional(), topic: z.string().optional(), seoKeyword: z.string().optional().nullable(),
  })).min(50),
  brandbook: z.record(z.unknown()),
  samples: z.array(z.record(z.unknown())).default([]),
  traffic: z.record(z.unknown()).optional(),
}).passthrough();

function shiftedMonth(day: string, amount: number) {
  const date = new Date(`${day}T00:00:00Z`), target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + amount);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}
const strings = (value: unknown) => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
const field = (raw: Record<string, unknown>, camel: string, snake: string) => raw[camel] ?? raw[snake];

/** Source is an explicitly selected, sanitized export, never a connection to iGEO. */
export function buildNayaxDemo(value: unknown, anchorDate: string, copiedAt = new Date().toISOString()): Project {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || new Date(`${anchorDate}T00:00:00Z`).toISOString().slice(0, 10) !== anchorDate)
    throw new Error('Supply a valid --anchor YYYY-MM-DD.');
  const source = sourceSchema.parse(value);
  if (source.brand.name.toLowerCase() !== 'nayax' || !source.brand.domains.some(d => /(^|\.)nayax\.com$/i.test(d)))
    throw new Error('The source must be the explicitly selected Nayax account.');
  const startDate = shiftedMonth(anchorDate, -6), endDate = shiftedMonth(anchorDate, 6), at = `${startDate}T00:00:00.000Z`;
  const raw = source.brandbook;
  const text = (camel: string, snake: string, fallback = '') => String(field(raw, camel, snake) || fallback);
  const list = (camel: string, snake: string) => strings(field(raw, camel, snake));
  const brandbook: Brandbook = {
    about: text('about', 'about'), industryCategory: text('industryCategory', 'industry_category'), subIndustryCategory: text('subIndustryCategory', 'sub_industry_category'),
    companyCountry: text('companyCountry', 'company_country', 'US').toUpperCase(), language: /^english$/i.test(text('language', 'language', 'en')) ? 'en' : text('language', 'language', 'en'),
    names: [source.brand.name, ...source.brand.aliases], domains: source.brand.domains,
    keyFeatures: list('keyFeatures', 'key_features'), toneOfVoice: list('toneOfVoice', 'tone_of_voice'), values: list('values', 'values'),
    personality: list('personality', 'personality'), targetAudience: list('targetAudience', 'target_audience'), knowledgeSources: list('knowledgeSources', 'knowledge_sources'),
    sitemapUrl: text('sitemapUrl', 'sitemap_url') || null, caseStudiesSourceUrl: text('caseStudiesSourceUrl', 'case_studies_source_url') || null,
    caseStudies: [], postGuidelines: { dos: [], donts: [] }, evidence: [], unknowns: [], generatedAt: copiedAt,
    model: 'gpt-4.1-2025-04-14', version: 1, generationId: 'nayax-import-v1',
  };
  const unique = [...new Map(source.prompts.map(p => [p.text.trim().toLowerCase(), p])).values()].slice(0, 50);
  if (unique.length !== 50) throw new Error('The export must contain 50 distinct source prompts.');
  const stages: JourneyStage[] = ['understand', 'prefer', 'trust', 'convert'];
  const labels = (items: unknown, fallback: string[]) => {
    if (!Array.isArray(items) || !items.length) return fallback;
    return items.map(item => typeof item === 'string' ? item : String(item.label ?? item.country ?? item.path ?? '')).filter(Boolean).slice(0, 20);
  };
  const traffic = source.traffic || {};
  const preferredCompetitors = ['cantaloupe.com', 'cranepi.com', 'ingenico.com', 'payrange.com', '365retailmarkets.com'];
  const competitors = [...source.competitors].sort((a, b) => {
    const score = (domains: string[]) => {
      const rank = preferredCompetitors.findIndex(domain => domains.includes(domain));
      return rank < 0 ? preferredCompetitors.length : rank;
    };
    return score(a.domains) - score(b.domains);
  }).slice(0, 5);
  return {
    id: NAYAX_DEMO_ID, name: 'Nayax', brand: { id: 'target', ...source.brand },
    competitors: competitors.map((b, i) => ({ id: `nayax-demo-competitor-${i + 1}`, ...b })),
    competitorsConfiguredAt: copiedAt, country: brandbook.companyCountry, language: brandbook.language, timezone: 'UTC',
    enabled: false, scheduleExpression: 'cron(0 6 ? * MON *)', scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] }, scheduleStatus: 'synced',
    generationModel: 'gpt-4.1-2025-04-14', extractionModel: 'gpt-6-luna', parserVersion: PARSER_VERSION, version: 1,
    scanProviders: providers(),
    prompts: unique.map((prompt, i) => {
      // iGEO has no populated journey stages for Nayax. Infer the demo grouping from the question.
      const inferred: JourneyStage = /trust|safe|secur|compli|reliab|certif|fraud/i.test(prompt.text) ? 'trust'
        : /buy|purchas|contact|demo|price|pricing|cost|order|install|integrat/i.test(prompt.text) ? 'convert'
        : prompt.stage === 'consideration' ? 'prefer' : prompt.stage === 'decision' ? 'convert' : 'understand';
      const stage = stages.includes(prompt.stage as JourneyStage) ? prompt.stage as JourneyStage : inferred;
      return { id: `nayax-demo-p${String(i + 1).padStart(2, '0')}`, text: prompt.text, version: 1, active: true,
        branded: isBrandedPrompt(prompt.text, source.brand), stage, topic: prompt.topic || 'Cashless payments', intent: STAGE_INTENTS[stage][0],
        seoKeyword: prompt.seoKeyword || undefined, tags: [], createdAt: at, updatedAt: at };
    }),
    brandbook, createdAt: at, updatedAt: copiedAt,
    demo: {
      version: 1, source: 'igeo-nayax', anchorDate, startDate, endDate,
      sourceAccountId: '333d2ee5-e99c-4e69-a59d-43656f6d8244', sourceCopiedAt: copiedAt,
      samples: source.samples.slice(0, 12).map((sample, index) => ({
        promptText: String(sample.promptText || ''), answerText: String(sample.answerText || sample.text || '').slice(0, 2500),
        citations: Array.isArray(sample.citations) ? sample.citations.filter(c => c && typeof c.url === 'string').slice(0, 8).map(c => ({ url: c.url, title: c.title })) : [],
        companies: index === 0 ? source.competitors.map(competitor => competitor.name) : undefined,
      })).filter(sample => sample.answerText),
      traffic: { pages: labels(traffic.pages, ['/','/solutions/','/contact/']), countries: labels(traffic.countries || traffic.locations, ['US', 'GB', 'IL', 'DE', 'AU']),
        devices: labels(traffic.devices, ['desktop', 'mobile', 'tablet']), browsers: labels(traffic.browsers, ['Chrome', 'Safari', 'Edge', 'Firefox']) },
    },
  };
}

export async function createNayaxDemo(repository: Pick<Repository, 'getProject' | 'saveProject'>, project: Project, apply = false) {
  const existing = await repository.getProject(project.id);
  if (existing && (!existing.demo || existing.demo.sourceAccountId !== project.demo?.sourceAccountId))
    throw new Error('Refusing to replace an existing real account.');
  const bytes = Buffer.byteLength(JSON.stringify(project));
  if (bytes > 250000) throw new Error('Compact demo configuration exceeds 250 KB.');
  if (existing) return { status: 'exists', projectId: existing.id, bytes: Buffer.byteLength(JSON.stringify(existing)) };
  if (apply && !await repository.saveProject(project, null)) throw new Error('Account changed concurrently; retry to inspect it.');
  return { status: apply ? 'created' : 'preview', projectId: project.id, name: project.name, prompts: project.prompts.length,
    startDate: project.demo!.startDate, endDate: project.demo!.endDate, scansPerWeek: 2, providers: 3, configurationBytes: bytes,
    persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 };
}

export function enrollNayaxBlogs(project: Project, value: unknown): NonNullable<Project['demo']>['trackedUrls'] {
  if (!project.demo) throw new Error('The account must have a saved scenario configuration.');
  const blogs = z.array(z.object({
    url: z.string().url().refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)nayax\.com$/i.test(url.hostname) && url.pathname.startsWith('/blog/') && !url.username && !url.password;
    }),
    title: z.string().min(1).max(200), imageUrl: z.string().url().optional(),
    sourcePublishedAt: z.string().datetime().optional(), sourceTrackedAt: z.string().datetime().optional(),
  })).min(1).max(40).parse(value);
  const unique = [...new Map(blogs.map(blog => [blog.url, blog])).values()];
  const groups = Math.ceil(unique.length / 4), start = Date.parse(`${project.demo.startDate}T00:00:00Z`), end = Date.parse(`${project.demo.endDate}T00:00:00Z`);
  const padding = Math.min(20 * 86400000, (end - start) / 4);
  return unique.map((blog, index) => {
    const position = groups === 1 ? 0.5 : Math.floor(index / 4) / (groups - 1);
    const date = new Date(start + padding + (end - start - 2 * padding) * position).toISOString().slice(0, 10);
    const enrolledAt = `${date}T08:00:00.000Z`;
    return { ...blog, contentType: 'BLOG' as const, publishedAt: enrolledAt, createdAt: enrolledAt };
  });
}

export async function refreshNayaxAccount(repository: Pick<Repository, 'getProject' | 'saveProject'>, blogs: unknown, apply = false, now = new Date()) {
  const existing = await repository.getProject(NAYAX_DEMO_ID);
  if (!existing?.demo || existing.demo.sourceAccountId !== '333d2ee5-e99c-4e69-a59d-43656f6d8244')
    throw new Error('Refusing to change an account without the expected Nayax source identity.');
  const desired: Project = {
    ...existing, name: existing.brand.name, enabled: false,
    generationModel: 'gpt-4.1-2025-04-14', extractionModel: 'gpt-6-luna', scanProviders: providers(),
    prompts: existing.prompts.map(prompt => ({ ...prompt, tags: prompt.tags?.filter(tag => tag.toLowerCase() !== 'demo') })),
    brandbook: existing.brandbook ? { ...existing.brandbook, model: 'gpt-4.1-2025-04-14', generationId: 'nayax-import-v1' } : undefined,
    demo: { ...existing.demo, trackedUrls: enrollNayaxBlogs(existing, blogs) },
  };
  if (isDeepStrictEqual(JSON.parse(JSON.stringify(desired)), JSON.parse(JSON.stringify(existing))))
    return { status: 'unchanged', projectId: existing.id, name: existing.name };
  const bytes = Buffer.byteLength(JSON.stringify(desired));
  if (bytes > 250000) throw new Error('Account configuration exceeds 250 KB.');
  if (apply && !await repository.saveProject({ ...desired, version: existing.version + 1, updatedAt: now.toISOString() }, existing.version))
    throw new Error('Account changed concurrently. Retry to inspect it.');
  return { status: apply ? 'updated' : 'preview', projectId: desired.id, name: desired.name, trackedUrls: desired.demo!.trackedUrls!.length,
    configurationBytes: bytes, enabled: false, paidCalls: 0 };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { source: { type: 'string' }, blogs: { type: 'string' }, refresh: { type: 'boolean' }, mode: { type: 'string', default: 'local' }, anchor: { type: 'string', default: '2026-10-23' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('npm run demo:nayax -- --source /private/path/sanitized-source.json --mode local|aws [--anchor YYYY-MM-DD] [--apply]\nnpm run demo:nayax -- --refresh --blogs /private/path/nayax-blogs.json --mode local|aws [--apply]\nDefault previews configuration only. Never connects to or writes iGEO. Refresh requires the saved Nayax source identity. Local server must be stopped.'); return; }
  if ((!values.refresh && !values.source) || (values.refresh && !values.blogs) || !['local', 'aws'].includes(values.mode)) throw new Error('Supply --source, or --refresh --blogs; choose --mode local|aws.');
  const project = values.refresh ? null : buildNayaxDemo(JSON.parse(await readFile(resolve(values.source!), 'utf8')), values.anchor);
  const db = await openConfigurationDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try {
    const repository = new PostgresRepository(db);
    console.log(JSON.stringify(values.refresh
      ? await refreshNayaxAccount(repository, JSON.parse(await readFile(resolve(values.blogs!), 'utf8')), values.apply)
      : await createNayaxDemo(repository, project!, values.apply), null, 2));
  }
  finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo creation failed'); process.exitCode = 1; });
