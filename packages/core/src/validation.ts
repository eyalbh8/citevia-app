import { z } from 'zod';
import { normalizeDomain } from './urls.js';
import { journeyStageSchema } from './onboarding.js';
import { scanProvidersSchema } from './providers.js';
import { PROMPT_INTENTS } from './prompt-policy.js';
import { DEFAULT_GEO_BACKLINK_SETTINGS, geoBacklinkDomain } from './geo-backlinks.js';
export const geoBacklinkSettingsSchema = z.object({
  enabled: z.boolean(),
  target: z.number().int().min(1).max(50).default(10),
  exclusionDays: z.number().int().min(180).max(3650).default(180),
  weights: z.object({
    citationConsistency: z.number().min(0).max(100), competitorGap: z.number().min(0).max(100),
    relevance: z.number().min(0).max(100), visibilityGap: z.number().min(0).max(100), placement: z.number().min(0).max(100),
  }).strict().refine(value => Object.values(value).reduce((a,b) => a+b, 0) > 0, 'At least one score weight must be positive').default(DEFAULT_GEO_BACKLINK_SETTINGS.weights),
  excludedDomains: z.array(z.string().max(253).refine(value => Boolean(geoBacklinkDomain(value)), 'Enter a public domain')).max(500).optional(),
}).strict();
export const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid identifier');
const domain = z
  .string()
  .trim()
  .max(253)
  .refine((value) => !!normalizeDomain(value), 'Enter a valid domain');
export const brandSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20),
    domains: z.array(domain).max(10),
  })
  .strict();
export const timeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid timezone');
export const settingsSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    brand: brandSchema.optional(),
    competitors: z.array(brandSchema).max(5).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      .optional(),
    timezone: timeZoneSchema.optional(),
    enabled: z.boolean().optional(),
    scanRunsPerWeek: z.number().int().min(1).max(7).optional(),
    geoBacklinks: geoBacklinkSettingsSchema.optional(),
    scanProviders: scanProvidersSchema.optional(),
  })
  .strict();
export const promptTextSchema = z.string().trim().min(3).max(2000);
const promptMetadata = {
  intent: z.enum(PROMPT_INTENTS).optional(),
  seoKeyword: z.string().trim().max(160).optional(),
  tags: z
    .array(z.string().trim().min(1).max(60))
    .max(10)
    .transform((tags) => [...new Set(tags)])
    .optional(),
};
export const promptCreateSchema = z.union([
  z
    .object({
      text: promptTextSchema,
      branded: z.boolean().optional(),
      stage: journeyStageSchema.optional(),
      topic: z.string().trim().max(120).optional(),
      ...promptMetadata,
    })
    .strict(),
  z
    .object({
      texts: z.array(promptTextSchema).min(1).max(50),
      branded: z.boolean().optional(),
      stage: journeyStageSchema.optional(),
      topic: z.string().trim().max(120).optional(),
      ...promptMetadata,
    })
    .strict(),
]);
export const promptUpdateSchema = z
  .object({
    version: z.number().int().positive().optional(),
    text: promptTextSchema.optional(),
    active: z.boolean().optional(),
    branded: z.boolean().optional(),
    stage: journeyStageSchema.optional(),
    topic: z.string().trim().max(120).optional(),
    ...promptMetadata,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'version'),
    'No changes supplied',
  );
export const WEEKLY_SCHEDULE = 'cron(0 6 ? * MON *)';

export function nextWeeklyScan(timezone: string, from = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) =>
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    );
  const local = parts(from);
  for (let days = 0; days <= 7; days++) {
    const target = new Date(
      Date.UTC(local.year, local.month - 1, local.day + days, 6),
    );
    if (target.getUTCDay() !== 1) continue;
    let candidate = target.getTime();
    for (let n = 0; n < 3; n++) {
      const p = parts(new Date(candidate));
      candidate +=
        target.getTime() -
        Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    if (candidate > from.getTime()) return new Date(candidate).toISOString();
  }
  throw new Error('Unable to calculate next scan');
}
