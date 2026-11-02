import { z } from 'zod';
import type { Brand, Brandbook, Project, Prompt } from './types.js';

/** Public social destinations; blogs are generated as internal drafts only. */
export const SOCIAL_CHANNELS = ['facebook', 'instagram', 'linkedin', 'x', 'pinterest', 'reddit', 'tiktok'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const MAX_SOCIAL_AUTOMATION_SLOTS = 28;
export const SOCIAL_OCCURRENCE_MAX_AGE_MS = 60 * 60 * 1000;
export interface SocialAutomationSlot {
  id: string;
  /** Sunday = 0, matching JavaScript Date.getDay(). */
  dayOfWeek: number;
  time: string;
}
export interface SocialAutomationSettings {
  enabled: boolean;
  createBlogDrafts: boolean;
  /** Optional for records saved before batch preparation was introduced. */
  generationCadence?: 'daily' | 'weekly' | 'monthly';
  generationTime?: string;
  revision: number;
  timezone: string;
  slots: SocialAutomationSlot[];
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
/** Only these settings may be accepted from the browser; revisions and profile IDs are server-owned. */
export const socialAutomationInputSchema = z.object({
  enabled: z.boolean(),
  createBlogDrafts: z.boolean().default(true),
  generationCadence: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
  generationTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  timezone: timezoneSchema,
  slots: z.array(socialAutomationSlotSchema).max(MAX_SOCIAL_AUTOMATION_SLOTS),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.slots.length) ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Choose at least one publishing time.' });
  if (new Set(value.slots.map(slot => slot.id)).size !== value.slots.length ||
    new Set(value.slots.map(slot => `${slot.dayOfWeek}:${slot.time}`)).size !== value.slots.length)
    ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Publishing times must be unique.' });
});
export type SocialAutomationInput = z.infer<typeof socialAutomationInputSchema>;
export function defaultSocialAutomationSettings(timezone = 'UTC'): SocialAutomationSettings {
  return { enabled: false, createBlogDrafts: true, generationCadence: 'daily', generationTime: '08:00', revision: 0, timezone, slots: [], effectiveFrom: new Date(0).toISOString(), scheduleStatus: 'synced' };
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
export interface SocialMediaAsset { id?: string; type: 'image' | 'video'; url: string; mimeType: string }
export interface SocialGenerationContext { brand: Brand; brandbook?: Brandbook; country: string; language: string }
export interface SocialOccurrence {
  id: string;
  projectId: string;
  revision: number;
  slotId: string;
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

export function socialGenerationCron(settings: Pick<SocialAutomationSettings, 'generationCadence' | 'generationTime'>): string {
  const cadence = settings.generationCadence ?? 'daily', time = settings.generationTime ?? '08:00';
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

function generationWindow(project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: Pick<SocialGenerationMessage, 'revision' | 'scheduledAt' | 'trigger'>, now: string | Date) {
  const settings = project.socialAutomation;
  if (project.demo || !settings?.enabled || settings.revision !== message.revision || !Number.isInteger(settings.revision) || settings.revision < 1) return null;
  const parsed = socialAutomationInputSchema.safeParse({ enabled: settings.enabled, createBlogDrafts: settings.createBlogDrafts,
    generationCadence: settings.generationCadence, generationTime: settings.generationTime, timezone: settings.timezone, slots: settings.slots });
  if (!parsed.success) return null;
  const scheduled = Date.parse(message.scheduledAt), current = new Date(now).getTime(), effective = Date.parse(settings.effectiveFrom);
  const minimum = message.trigger === 'manual' ? effective : Math.floor(effective / 60000) * 60000;
  if (![scheduled, current, effective].every(Number.isFinite) || scheduled < minimum ||
    scheduled > current + 60000 || current - scheduled > SOCIAL_OCCURRENCE_MAX_AGE_MS) return null;
  const local = localParts(scheduled, settings.timezone), start = Date.parse(`${local.date}T00:00:00Z`), day = new Date(start).getUTCDay();
  const normalized = parsed.data;
  if (message.trigger !== 'manual' && (scheduled % 60000 !== 0 || local.time !== normalized.generationTime ||
    (normalized.generationCadence === 'weekly' && day !== 1) ||
    (normalized.generationCadence === 'monthly' && new Date(start).getUTCDate() !== 1))) return null;
  const end = normalized.generationCadence === 'monthly'
    ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1)
    : start + (normalized.generationCadence === 'weekly' ? 7 - (day + 6) % 7 : 1) * 86400000;
  return { settings: normalized, start, end, earliest: Math.max(current, effective) };
}

/** Enumerate remaining publishing slots, never backfilling the elapsed part of a calendar period. */
export function socialGenerationOccurrences(project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: SocialGenerationMessage, now: string | Date = new Date()): SocialOccurrenceMessage[] | null {
  const window = generationWindow(project, message, now);
  if (!window) return null;
  const occurrences: SocialOccurrenceMessage[] = [];
  for (let day = window.start; day < window.end; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10), weekday = new Date(day).getUTCDay();
    for (const slot of window.settings.slots.filter(slot => slot.dayOfWeek === weekday)) {
      const timestamp = localInstant(date, slot.time, window.settings.timezone);
      if (timestamp === null || timestamp <= window.earliest) continue;
      occurrences.push({ kind: 'social-occurrence', projectId: message.projectId, revision: message.revision,
        slotId: slot.id, scheduledAt: new Date(timestamp).toISOString() });
    }
  }
  return occurrences.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.slotId.localeCompare(b.slotId));
}

/** A local date is the deduplication boundary, including the repeated hour when daylight saving ends. */
export function socialOccurrenceLocalDate(
  project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: Pick<SocialOccurrenceMessage, 'revision' | 'slotId' | 'scheduledAt'> & Pick<Partial<ReserveSocialOccurrenceInput>, 'generationScheduledAt' | 'generationTrigger'>,
  now: string | Date = new Date(),
): string | null {
  const settings = project.socialAutomation;
  if (project.demo || !settings?.enabled || !Number.isInteger(settings.revision) || settings.revision < 1 || settings.revision !== message.revision ||
    !socialAutomationInputSchema.safeParse({ enabled: settings.enabled, createBlogDrafts: settings.createBlogDrafts,
      generationCadence: settings.generationCadence, generationTime: settings.generationTime, timezone: settings.timezone, slots: settings.slots }).success) return null;
  const scheduled = Date.parse(message.scheduledAt), current = new Date(now).getTime(), effective = Date.parse(settings.effectiveFrom);
  if (![scheduled, current, effective].every(Number.isFinite) || scheduled % 60000 !== 0 || scheduled < effective) return null;
  const slot = settings.slots.find(value => value.id === message.slotId);
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
