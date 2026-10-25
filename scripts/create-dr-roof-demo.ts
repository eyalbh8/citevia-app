import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DEFAULT_GEMINI_MODEL, DEFAULT_PERPLEXITY_PRESET, isBrandedPrompt, PARSER_VERSION, STAGE_INTENTS, trackedUrlKey,
  type Brandbook, type JourneyStage, type Project } from '@citevia/core';
import { PostgresRepository, type Repository } from '@citevia/storage';
import { openConfigurationDatabase } from './configure-analysis.js';

export const DR_ROOF_DEMO_ID = 'account_dr_roof_demo_v1';
export const DR_ROOF_SOURCE_ACCOUNT_ID = '2812fba4-a1d9-4b0b-a649-8d69ce4903dc';
export const DR_ROOF_DEMO_PROFILE = { visibilityAdjustment: -0.03, growthCurve: 1.06, trafficScale: 0.92, monthlyGrowth: 0.095 };
const brandSchema = z.object({ name: z.string().min(1), aliases: z.array(z.string()).default([]), domains: z.array(z.string()).min(1) });
const officialDomain = (value: string) => {
  try { const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    return !url.username && !url.password && /(^|\.)drroof\.com$/i.test(url.hostname) ? url.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch { return null; }
};
const blogSchema = z.object({
  url: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !!officialDomain(value) && url.pathname.startsWith('/blog/') && !!trackedUrlKey(value); }),
  title: z.string().min(1).max(200), imageUrl: z.string().url().optional(),
  sourcePublishedAt: z.string().datetime().optional(), sourceTrackedAt: z.string().datetime().optional(),
});
const sourceSchema = z.object({
  sourceAccountId: z.literal(DR_ROOF_SOURCE_ACCOUNT_ID), brand: brandSchema, competitors: z.array(brandSchema).min(5).max(30),
  prompts: z.array(z.object({ text: z.string().min(5).max(2000), stage: z.string().optional(), topic: z.string().optional(), seoKeyword: z.string().nullable().optional() })).min(50),
  brandbook: z.record(z.unknown()), samples: z.array(z.record(z.unknown())).min(1),
  traffic: z.record(z.unknown()).optional(), blogs: z.array(blogSchema).max(200).default([]),
});
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 30) : [];
function shiftedMonth(day: string, amount: number) {
  const date = new Date(`${day}T00:00:00Z`), target = new Date(date);
  target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + amount);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last)); return target.toISOString().slice(0, 10);
}
function stageFor(text: string, source?: string): JourneyStage {
  if (['understand', 'prefer', 'trust', 'convert'].includes(source || '')) return source as JourneyStage;
  if (/trust|safe|secur|licen[cs]|certif|warrant|inspect|review|insur|reliab|reputab/i.test(text)) return 'trust';
  if (/buy|purchas|contact|price|pricing|cost|quote|book|hire|order|install|request/i.test(text) || source === 'decision') return 'convert';
  if (/best|top\b|\bvs\b|versus|compar|alternativ|recommend/i.test(text) || source === 'consideration') return 'prefer';
  return 'understand';
}

/** An explicitly selected sanitized source file; this command never connects to iGEO. */
export function buildDrRoofDemo(value: unknown, anchorDate = '2026-10-25', copiedAt = new Date().toISOString()): Project {
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== anchorDate)
    throw new Error('Supply a valid --anchor YYYY-MM-DD.');
  const source = sourceSchema.parse(value), domains = [...new Set(source.brand.domains.map(officialDomain).filter((v): v is string => !!v))];
  if (source.brand.name.toLowerCase().replace(/[^a-z0-9]/g, '') !== 'drroof' || !domains.length)
    throw new Error('The source must be the explicitly selected Dr. Roof account and official drroof.com website.');
  const brand = { ...source.brand, name: 'Dr. Roof', domains };
  const startDate = shiftedMonth(anchorDate, -6), endDate = shiftedMonth(anchorDate, 6), at = `${startDate}T00:00:00.000Z`;
  const raw = source.brandbook, text = (camel: string, snake: string, fallback = '') => String(raw[camel] ?? raw[snake] ?? fallback);
  const list = (camel: string, snake: string) => strings(raw[camel] ?? raw[snake]);
  const brandbook: Brandbook = {
    about: text('about', 'about'), industryCategory: text('industryCategory', 'industry_category'), subIndustryCategory: text('subIndustryCategory', 'sub_industry_category'),
    companyCountry: (text('companyCountry', 'company_country') || 'US').toUpperCase(), language: /^english$/i.test(text('language', 'language', 'en')) ? 'en' : text('language', 'language', 'en'),
    names: [brand.name, ...brand.aliases], domains, keyFeatures: list('keyFeatures', 'key_features'), toneOfVoice: list('toneOfVoice', 'tone_of_voice'),
    values: list('values', 'values'), personality: list('personality', 'personality'), targetAudience: list('targetAudience', 'target_audience'), knowledgeSources: list('knowledgeSources', 'knowledge_sources'),
    sitemapUrl: text('sitemapUrl', 'sitemap_url') || null, caseStudiesSourceUrl: text('caseStudiesSourceUrl', 'case_studies_source_url') || null,
    caseStudies: [], postGuidelines: { dos: [], donts: [] }, evidence: [], unknowns: [], generatedAt: copiedAt,
    model: 'gpt-4.1-2025-04-14', version: 1, generationId: 'dr-roof-import-v1',
  };
  const unique = [...new Map(source.prompts.map(p => [p.text.trim().toLowerCase().replace(/\s+/g, ' '), p])).values()].slice(0, 50);
  if (unique.length !== 50) throw new Error('The export must contain 50 distinct source prompts.');
  const competitors = source.competitors.filter((item, index, all) =>
    all.findIndex(other => other.name.trim().toLowerCase() === item.name.trim().toLowerCase()) === index).slice(0, 5);
  if (competitors.length !== 5) throw new Error('The export must contain five distinct source competitors.');
  const samples = source.samples.slice(0, 12).map((sample, index) => ({
    promptText: String(sample.promptText || ''), answerText: String(sample.answerText || sample.text || '').slice(0, 2500),
    citations: Array.isArray(sample.citations) ? sample.citations.filter(c => c && typeof c.url === 'string').slice(0, 8).map(c => ({ url: c.url, title: c.title })) : [],
    companies: index === 0 ? [...new Set([...source.competitors.map(competitor => competitor.name), ...source.samples.flatMap(sample => strings(sample.companies))])] : undefined,
  })).filter(sample => sample.answerText);
  if (!samples.length) throw new Error('The source must contain at least one saved answer excerpt.');
  const labels = (items: unknown, fallback: string[]) => !Array.isArray(items) || !items.length ? fallback
    : items.map(item => typeof item === 'string' ? item : String(item?.label ?? item?.country ?? item?.path ?? '')).filter(Boolean).slice(0, 20);
  const traffic = source.traffic || {}, enrollmentDates: string[] = [];
  const end = Date.parse(`${endDate}T23:59:59.999Z`);
  for (let day = Date.parse(at); day <= end; day += 86400000) {
    if ([1, 3, 5].includes(new Date(day).getUTCDay()))
      enrollmentDates.push(`${new Date(day).toISOString().slice(0, 10)}T08:00:00.000Z`);
  }
  const pastSlots = enrollmentDates.filter(date => date.slice(0, 10) <= anchorDate).length;
  const uniqueBlogs = [...new Map(source.blogs.map(blog => [trackedUrlKey(blog.url), blog])).values()];
  if (uniqueBlogs.length < pastSlots) throw new Error(`The source needs at least ${pastSlots} distinct official blogs for three posts per week through the anchor date.`);
  const blogs = uniqueBlogs.slice(0, enrollmentDates.length);
  return {
    id: DR_ROOF_DEMO_ID, name: 'Dr. Roof', brand: { id: 'target', ...brand },
    competitors: competitors.map((b, i) => ({ id: `dr-roof-demo-competitor-${i + 1}`, ...b })), competitorsConfiguredAt: copiedAt,
    country: brandbook.companyCountry, language: brandbook.language, timezone: 'UTC', enabled: false,
    scheduleExpression: 'cron(0 6 ? * MON *)', scanSchedule: { version: 1, slotsUtcMinutes: [600, 5640] }, scheduleStatus: 'synced',
    generationModel: 'gpt-4.1-2025-04-14', extractionModel: 'gpt-6-luna', parserVersion: PARSER_VERSION, version: 1,
    scanProviders: [{ provider: 'openai', model: 'gpt-4.1-2025-04-14' }, { provider: 'perplexity', model: DEFAULT_PERPLEXITY_PRESET }, { provider: 'gemini', model: DEFAULT_GEMINI_MODEL }],
    prompts: unique.map((prompt, index) => { const stage = stageFor(prompt.text, prompt.stage); return {
      id: `dr-roof-demo-p${String(index + 1).padStart(2, '0')}`, text: prompt.text, version: 1, active: true,
      branded: isBrandedPrompt(prompt.text, brand), stage, topic: prompt.topic || 'Roofing services', intent: STAGE_INTENTS[stage][0],
      seoKeyword: prompt.seoKeyword || undefined, tags: [], createdAt: at, updatedAt: at,
    }; }),
    brandbook, createdAt: at, updatedAt: copiedAt,
    demo: { version: 1, source: 'igeo-dr-roof', anchorDate, startDate, endDate, sourceAccountId: source.sourceAccountId, sourceCopiedAt: copiedAt,
      profile: { ...DR_ROOF_DEMO_PROFILE }, samples,
      traffic: { pages: labels(traffic.pages, ['/', '/roof-repair/', '/roof-replacement/', '/contact/']), countries: labels(traffic.countries || traffic.locations, ['US', 'GB', 'CA', 'AU']),
        devices: labels(traffic.devices, ['desktop', 'mobile', 'tablet']), browsers: labels(traffic.browsers, ['Chrome', 'Safari', 'Edge', 'Firefox']) },
      trackedUrls: blogs.map((blog, index) => {
        const enrolledAt = enrollmentDates[index];
        return { ...blog, contentType: 'BLOG', publishedAt: enrolledAt, createdAt: enrolledAt }; }),
    },
  };
}

export async function createDrRoofDemo(repository: Pick<Repository, 'getProject' | 'saveProject'>, project: Project, apply = false) {
  if (project.id !== DR_ROOF_DEMO_ID || project.demo?.source !== 'igeo-dr-roof' || project.demo.sourceAccountId !== DR_ROOF_SOURCE_ACCOUNT_ID)
    throw new Error('Refusing to save a configuration without the selected Dr. Roof demo identity.');
  const existing = await repository.getProject(project.id);
  if (existing && (existing.demo?.source !== 'igeo-dr-roof' || existing.demo.sourceAccountId !== DR_ROOF_SOURCE_ACCOUNT_ID))
    throw new Error('Refusing to replace an existing real account.');
  const bytes = Buffer.byteLength(JSON.stringify(project));
  if (bytes > 250000) throw new Error('Compact demo configuration exceeds 250 KB.');
  if (existing) return { status: 'exists', projectId: existing.id, configurationBytes: Buffer.byteLength(JSON.stringify(existing)) };
  if (apply && !await repository.saveProject(project, null)) throw new Error('Account changed concurrently; retry to inspect it.');
  return { status: apply ? 'created' : 'preview', projectId: project.id, name: project.name, prompts: project.prompts.length, competitors: project.competitors.length,
    trackedUrls: project.demo.trackedUrls?.length || 0, startDate: project.demo.startDate, endDate: project.demo.endDate, scansPerWeek: 2, providers: 3,
    configurationBytes: bytes, persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { source: { type: 'string' }, mode: { type: 'string', default: 'local' }, anchor: { type: 'string', default: '2026-10-25' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('node --import tsx scripts/create-dr-roof-demo.ts --source /private/path/sanitized-source.json [--mode local|aws] [--anchor YYYY-MM-DD] [--apply]\nDefault previews compact configuration. Never connects to iGEO. Applying is idempotent and refuses to replace real accounts.'); return; }
  if (!values.source || !['local', 'aws'].includes(values.mode)) throw new Error('Supply --source and choose --mode local|aws.');
  const project = buildDrRoofDemo(JSON.parse(await readFile(resolve(values.source), 'utf8')), values.anchor);
  const db = await openConfigurationDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real'));
  try { console.log(JSON.stringify(await createDrRoofDemo(new PostgresRepository(db), project, values.apply), null, 2)); }
  finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Dr. Roof demo creation failed'); process.exitCode = 1; });
