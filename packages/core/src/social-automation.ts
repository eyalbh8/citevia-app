import { z } from 'zod';
import type { Brand, Brandbook, Project, Prompt } from './types.js';
import type { AgentImage } from './agents.js';

/** Public social destinations; blogs are generated as internal drafts only. */
export const SOCIAL_CHANNELS = ['facebook', 'instagram', 'linkedin', 'x', 'pinterest', 'reddit', 'tiktok'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const MAX_SOCIAL_AUTOMATION_SLOTS = 28;
export const MAX_SOCIAL_AUTOMATION_BRANDS = 20;
export const SOCIAL_OCCURRENCE_MAX_AGE_MS = 60 * 60 * 1000;
export interface SocialAutomationSlot {
  id: string;
  /** Sunday = 0, matching JavaScript Date.getDay(). */
  dayOfWeek: number;
  time: string;
}
export interface SocialBrandBrief {
  id: string;
  name: string;
  description: string;
}
export interface SocialAutomationBrand extends SocialBrandBrief {
  facebookDestinationId: string;
  instagramDestinationId: string;
  shareFacebookInstagramContent: boolean;
  slots: SocialAutomationSlot[];
}
export interface SocialAutomationSettings {
  enabled: boolean;
  createBlogDrafts: boolean;
  /** Absent legacy settings retain OpenAI artwork. Applies to connected social accounts. */
  imageSource?: 'openai' | 'unsplash';
  /** Opt-in; absent legacy settings keep separate platform-specific generation. */
  shareFacebookInstagramContent?: boolean;
  /** Optional for records saved before batch preparation was introduced. */
  generationCadence?: 'daily' | 'weekly' | 'monthly';
  generationTime?: string;
  revision: number;
  timezone: string;
  slots: SocialAutomationSlot[];
  /** A nonempty brand list selects per-brand weekly planning. */
  brands?: SocialAutomationBrand[];
  effectiveFrom: string;
  scheduleStatus: 'pending' | 'synced' | 'error';
}
const timezoneSchema = z.string().trim().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Choose a valid timezone.');
export const socialAutomationSlotSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  dayOfWeek: z.number().int().min(0).max(6),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict();
const publishingSlotsSchema = z.array(socialAutomationSlotSchema).max(MAX_SOCIAL_AUTOMATION_SLOTS).refine(slots =>
  new Set(slots.map(slot => slot.id)).size === slots.length &&
  new Set(slots.map(slot => `${slot.dayOfWeek}:${slot.time}`)).size === slots.length, 'Publishing times must be unique.');
const brandSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(600),
  facebookDestinationId: z.string().trim().min(1).max(255),
  instagramDestinationId: z.string().trim().min(1).max(255),
  shareFacebookInstagramContent: z.boolean(),
  slots: publishingSlotsSchema,
}).strict();
/** Only these settings may be accepted from the browser; revisions and profile IDs are server-owned. */
export const socialAutomationInputSchema = z.object({
  enabled: z.boolean(),
  createBlogDrafts: z.boolean().default(true),
  imageSource: z.enum(['openai', 'unsplash']).default('openai'),
  shareFacebookInstagramContent: z.boolean().default(false),
  generationCadence: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
  generationTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  timezone: timezoneSchema,
  slots: publishingSlotsSchema,
  brands: z.array(brandSchema).max(MAX_SOCIAL_AUTOMATION_BRANDS).optional(),
}).strict().superRefine((value, ctx) => {
  const brands = value.brands ?? [];
  if (brands.reduce((total, brand) => total + brand.slots.length, 0) > MAX_SOCIAL_AUTOMATION_SLOTS)
    ctx.addIssue({ code: 'custom', path: ['brands'], message: `Choose up to ${MAX_SOCIAL_AUTOMATION_SLOTS} weekly publishing times across all brands.` });
  if (value.enabled && !brands.length && !value.slots.length) ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Choose at least one publishing time.' });
  const destinations = brands.flatMap(brand => [brand.facebookDestinationId, brand.instagramDestinationId]);
  if (new Set(destinations).size !== destinations.length)
    ctx.addIssue({ code: 'custom', path: ['brands'], message: 'Assign each social account to only one brand.' });
  if (new Set(brands.map(brand => brand.id)).size !== brands.length ||
      new Set(brands.map(brand => brand.name.toLowerCase())).size !== brands.length)
    ctx.addIssue({ code: 'custom', path: ['brands'], message: 'Give each brand a distinct name and ID.' });
  if (value.enabled) brands.forEach((brand, index) => {
    if (!brand.slots.length) ctx.addIssue({ code: 'custom', path: ['brands', index, 'slots'], message: 'Choose at least one publishing time for each brand.' });
    if (brand.slots.some(slot => slot.dayOfWeek === 1 && slot.time <= value.generationTime))
      ctx.addIssue({ code: 'custom', path: ['brands', index, 'slots'], message: 'Choose Monday publishing times after the weekly preparation time.' });
  });
});
export type SocialAutomationInput = z.infer<typeof socialAutomationInputSchema>;
export function defaultSocialAutomationSettings(timezone = 'UTC'): SocialAutomationSettings {
  return { enabled: false, createBlogDrafts: true, imageSource: 'openai', shareFacebookInstagramContent: false, generationCadence: 'daily', generationTime: '08:00', revision: 0, timezone, slots: [], effectiveFrom: new Date(0).toISOString(), scheduleStatus: 'synced' };
}
export interface SocialDestination {
  id: string;
  channel: SocialChannel;
  username: string;
  profileId: string;
  active: boolean;
  requiresReconnect: boolean;
  options?: Record<string, JsonValue>;
}
/** This internal destination only creates a draft; it is never sent to a publishing provider. */
export interface BlogDraftDestination {
  id: 'blog-draft';
  channel: 'blog';
  username: 'Blog drafts';
  profileId: '';
  active: true;
  requiresReconnect: false;
}
export type AutomationDestination = SocialDestination | BlogDraftDestination;
export interface SocialContent { title: string; body: string; hashtags: string[] }
export interface SocialMediaAsset { id?: string; type: 'image' | 'video'; url: string; mimeType: string; attribution?: AgentImage[]; contentDigest?: string }
export interface SocialGenerationContext {
  brand: Brand;
  brandbook?: Brandbook;
  country: string;
  language: string;
  imageSource?: 'openai' | 'unsplash';
  socialBrand?: SocialBrandBrief;
  weeklyCreative?: { number: number; total: number; scheduledAt: string };
}
export interface SocialOccurrence {
  id: string;
  projectId: string;
  revision: number;
  slotId: string;
  brandId?: string;
  localDate: string;
  scheduledAt: string;
  createdAt: string;
  sequence: number;
  prompt: Prompt;
  destinations: AutomationDestination[];
  context: SocialGenerationContext;
}
export const SOCIAL_PUBLICATION_STATUSES = ['queued', 'generating', 'review_required', 'scheduled', 'publishing', 'published', 'draft_created', 'failed', 'cancelled', 'uncertain'] as const;
export type SocialPublicationStatus = (typeof SOCIAL_PUBLICATION_STATUSES)[number];
export const ACTIVE_SOCIAL_PUBLICATION_STATUSES: SocialPublicationStatus[] = ['queued', 'generating', 'scheduled', 'publishing'];
export interface SocialPublication {
  id: string;
  projectId: string;
  occurrenceId: string;
  revision: number;
  scheduledAt: string;
  prompt: Prompt;
  destination: AutomationDestination;
  context: SocialGenerationContext;
  status: SocialPublicationStatus;
  /** Frozen at occurrence reservation. Only this publication's durable lease may produce shared AI receipts. */
  sharedGeneration?: { sourcePublicationId: string; memberPublicationIds: string[]; format: 'facebook-instagram' };
  stage: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  leaseUntil?: string;
  leaseOwner?: string;
  attempts?: number;
  nextAttemptAt?: string;
  draftPostId?: string;
  content?: SocialContent;
  media?: SocialMediaAsset[];
  style?: Record<string, JsonValue>;
  /** Internal stage checkpoints must contain JSON-serializable values and no credentials. */
  checkpoints?: Record<string, unknown>;
  receiptKeys?: Record<string, string>;
  providerPostId?: string;
  publishAttemptAt?: string;
  publishedAt?: string;
  publishedUrl?: string;
  error?: { code: string; message: string } | null;
  approval?: {
    approvedBy: string;
    approvedAt: string;
    previewConfirmed: boolean;
    expressConsentGiven: boolean;
    /** SHA-256 of socialApprovalSnapshot; absent historical approvals need a new review. */
    contentHash?: string;
    privacyLevel?: string;
    allowComment?: boolean;
    allowDuet?: boolean;
    allowStitch?: boolean;
    musicSoundId?: string;
  };
}
/** Stable across JSONB object-key reordering; callers hash this snapshot server-side. */
export function socialApprovalSnapshot(post: Pick<SocialPublication, 'content' | 'media' | 'scheduledAt' | 'destination'>): string {
  return JSON.stringify({
    content: post.content ? { title: post.content.title, body: post.content.body, hashtags: post.content.hashtags } : null,
    media: (post.media ?? []).map(asset => ({ id: asset.id ?? null, type: asset.type, url: asset.url, mimeType: asset.mimeType })),
    scheduledAt: post.scheduledAt,
    destinationId: post.destination.id,
  });
}
export interface SocialReconcileMessage { kind: 'social-reconcile' }
export interface SocialGenerationMessage {
  kind: 'social-generation';
  projectId: string;
  revision: number;
  scheduledAt: string;
  trigger?: 'scheduled' | 'manual';
}
export interface SocialOccurrenceMessage {
  kind: 'social-occurrence';
  projectId: string;
  revision: number;
  slotId: string;
  brandId?: string;
  scheduledAt: string;
}
export interface ReserveSocialOccurrenceInput extends Omit<SocialOccurrenceMessage, 'kind'> {
  now: string;
  /** A validated preparation event may reserve later publishing times in its calendar period. */
  generationScheduledAt?: string;
  generationTrigger?: 'scheduled' | 'manual';
  /** Server-read connections for the project's private social profile. */
  destinations: SocialDestination[];
}
export type ReserveSocialOccurrenceResult =
  | { status: 'created' | 'existing'; occurrence: SocialOccurrence; publications: SocialPublication[] }
  | { status: 'stale' | 'empty' };

export function socialSlotCron(slot: SocialAutomationSlot): string {
  const parsed = socialAutomationSlotSchema.parse(slot);
  const [hour, minute] = parsed.time.split(':').map(Number);
  return `cron(${minute} ${hour} ? * ${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][parsed.dayOfWeek]} *)`;
}

type CadenceSettings = Pick<SocialAutomationSettings, 'generationCadence' | 'brands'>;
const generationCadence = (settings: CadenceSettings) => settings.brands?.length ? 'weekly' : settings.generationCadence ?? 'daily';
export function socialGenerationCron(settings: CadenceSettings & Pick<SocialAutomationSettings, 'generationTime'>): string {
  const cadence = generationCadence(settings), time = settings.generationTime ?? '08:00';
  if (!['daily', 'weekly', 'monthly'].includes(cadence) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error('Invalid content preparation schedule');
  const [hour, minute] = time.split(':').map(Number);
  return cadence === 'weekly' ? `cron(${minute} ${hour} ? * MON *)`
    : cadence === 'monthly' ? `cron(${minute} ${hour} 1 * ? *)` : `cron(${minute} ${hour} * * ? *)`;
}

function localParts(timestamp: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Resolve a local minute, skipping nonexistent times and choosing the first repeated minute. */
function localInstant(date: string, time: string, timezone: string): number | null {
  const desired = Date.parse(`${date}T${time}:00Z`), offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = desired + hours * 3600000, parts = localParts(sample, timezone);
    offsets.add(Date.parse(`${parts.date}T${parts.time}:00Z`) - sample);
  }
  const candidates = [...offsets].map(offset => desired - offset).filter(candidate => {
    const parts = localParts(candidate, timezone);
    return parts.date === date && parts.time === time;
  });
  return candidates.length ? Math.min(...candidates) : null;
}

export function parseStoredSocialAutomation(settings: SocialAutomationSettings) {
  const { enabled, createBlogDrafts, imageSource, shareFacebookInstagramContent, generationCadence, generationTime, timezone, slots, brands } = settings;
  return socialAutomationInputSchema.safeParse({ enabled, createBlogDrafts, imageSource, shareFacebookInstagramContent, generationCadence, generationTime, timezone, slots, brands });
}
/** No brand-scoped post may be adopted by the legacy project plan or another brand. */
export function socialPublicationDestinationAssigned(project: Project, post: Pick<SocialPublication, 'projectId' | 'destination' | 'context'>) {
  if (project.id !== post.projectId) return false;
  const { destination } = post, brands = project.socialAutomation?.brands;
  if (destination.channel !== 'blog' && (!project.socialProfileId || destination.profileId !== project.socialProfileId)) return false;
  if (!brands?.length) return !post.context.socialBrand;
  const brand = brands.find(brand => brand.id === post.context.socialBrand?.id);
  return !!brand && socialBrandHasDestination(brand, destination);
}
export function socialBrandHasDestination(brand: SocialAutomationBrand, destination: Pick<AutomationDestination, 'id' | 'channel'>) {
  return destination.channel === 'facebook' && brand.facebookDestinationId === destination.id ||
    destination.channel === 'instagram' && brand.instagramDestinationId === destination.id;
}

function generationWindow(project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: Pick<SocialGenerationMessage, 'revision' | 'scheduledAt' | 'trigger'>, now: string | Date) {
  const settings = project.socialAutomation;
  if (project.demo || !settings?.enabled || settings.revision !== message.revision || !Number.isInteger(settings.revision) || settings.revision < 1) return null;
  const parsed = parseStoredSocialAutomation(settings);
  if (!parsed.success) return null;
  const scheduled = Date.parse(message.scheduledAt), current = new Date(now).getTime(), effective = Date.parse(settings.effectiveFrom);
  const minimum = message.trigger === 'manual' ? effective : Math.floor(effective / 60000) * 60000;
  if (![scheduled, current, effective].every(Number.isFinite) || scheduled < minimum ||
    scheduled > current + 60000 || current - scheduled > SOCIAL_OCCURRENCE_MAX_AGE_MS) return null;
  const local = localParts(scheduled, settings.timezone), start = Date.parse(`${local.date}T00:00:00Z`), day = new Date(start).getUTCDay();
  const normalized = parsed.data;
  const cadence = generationCadence(normalized);
  if (message.trigger !== 'manual' && (scheduled % 60000 !== 0 || local.time !== normalized.generationTime ||
    (cadence === 'weekly' && day !== 1) ||
    (cadence === 'monthly' && new Date(start).getUTCDate() !== 1))) return null;
  const end = cadence === 'monthly'
    ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1)
    : start + (cadence === 'weekly' ? 7 - (day + 6) % 7 : 1) * 86400000;
  return { settings: normalized, start, end, earliest: Math.max(current, effective) };
}

/** Enumerate remaining publishing slots, never backfilling the elapsed part of a calendar period. */
export function socialGenerationOccurrences(project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: SocialGenerationMessage, now: string | Date = new Date()): SocialOccurrenceMessage[] | null {
  const window = generationWindow(project, message, now);
  if (!window) return null;
  const occurrences: SocialOccurrenceMessage[] = [];
  const slots = window.settings.brands?.length
    ? window.settings.brands.flatMap(brand => brand.slots.map(slot => ({ ...slot, brandId: brand.id })))
    : window.settings.slots.map(slot => ({ ...slot, brandId: undefined }));
  for (let day = window.start; day < window.end; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10), weekday = new Date(day).getUTCDay();
    for (const slot of slots.filter(slot => slot.dayOfWeek === weekday)) {
      const timestamp = localInstant(date, slot.time, window.settings.timezone);
      if (timestamp === null || timestamp <= window.earliest) continue;
      occurrences.push({ kind: 'social-occurrence', projectId: message.projectId, revision: message.revision,
        slotId: slot.id, ...(slot.brandId ? { brandId: slot.brandId } : {}), scheduledAt: new Date(timestamp).toISOString() });
    }
  }
  return occurrences.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.slotId.localeCompare(b.slotId));
}

/** A local date is the deduplication boundary, including the repeated hour when daylight saving ends. */
export function socialOccurrenceLocalDate(
  project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: Pick<SocialOccurrenceMessage, 'revision' | 'brandId' | 'slotId' | 'scheduledAt'> & Pick<Partial<ReserveSocialOccurrenceInput>, 'generationScheduledAt' | 'generationTrigger'>,
  now: string | Date = new Date(),
): string | null {
  const settings = project.socialAutomation;
  if (project.demo || !settings?.enabled || !Number.isInteger(settings.revision) || settings.revision < 1 || settings.revision !== message.revision ||
    !parseStoredSocialAutomation(settings).success) return null;
  const scheduled = Date.parse(message.scheduledAt), current = new Date(now).getTime(), effective = Date.parse(settings.effectiveFrom);
  if (![scheduled, current, effective].every(Number.isFinite) || scheduled % 60000 !== 0 || scheduled < effective) return null;
  const slots = settings.brands?.length ? settings.brands.find(brand => brand.id === message.brandId)?.slots
    : message.brandId === undefined ? settings.slots : undefined;
  const slot = slots?.find(value => value.id === message.slotId);
  if (!slot) return null;
  const local = localParts(scheduled, settings.timezone), day = Date.parse(`${local.date}T00:00:00Z`);
  if (local.time !== slot.time || new Date(day).getUTCDay() !== slot.dayOfWeek) return null;
  if (message.generationScheduledAt !== undefined) {
    const window = generationWindow(project, { revision: message.revision, scheduledAt: message.generationScheduledAt, trigger: message.generationTrigger }, now);
    if (!window || day < window.start || day >= window.end || scheduled <= window.earliest ||
      localInstant(local.date, slot.time, settings.timezone) !== scheduled) return null;
  } else if (message.generationTrigger !== undefined || scheduled > current + 60000 || current - scheduled > SOCIAL_OCCURRENCE_MAX_AGE_MS) return null;
  return local.date;
}
