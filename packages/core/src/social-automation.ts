import { z } from 'zod';
import type { Brand, Brandbook, Project, Prompt } from './types.js';

/** Blog generation remains a separate, manual workflow. */
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
  return { enabled: false, createBlogDrafts: true, revision: 0, timezone, slots: [], effectiveFrom: new Date(0).toISOString(), scheduleStatus: 'synced' };
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
export interface SocialMediaAsset { type: 'image' | 'video'; url: string; mimeType: string }
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
export const SOCIAL_PUBLICATION_STATUSES = ['queued', 'generating', 'review_required', 'publishing', 'published', 'draft_created', 'failed', 'cancelled', 'uncertain'] as const;
export type SocialPublicationStatus = (typeof SOCIAL_PUBLICATION_STATUSES)[number];
export const ACTIVE_SOCIAL_PUBLICATION_STATUSES: SocialPublicationStatus[] = ['queued', 'generating', 'publishing'];
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
    privacyLevel: string;
    allowComment: boolean;
    allowDuet: boolean;
    allowStitch: boolean;
    musicSoundId?: string;
  };
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

/** A local date is the deduplication boundary, including the repeated hour when daylight saving ends. */
export function socialOccurrenceLocalDate(
  project: Pick<Project, 'socialAutomation' | 'demo'>,
  message: Pick<SocialOccurrenceMessage, 'revision' | 'slotId' | 'scheduledAt'>,
  now: string | Date = new Date(),
): string | null {
  const settings = project.socialAutomation;
  if (project.demo || !settings?.enabled || !Number.isInteger(settings.revision) || settings.revision < 1 || settings.revision !== message.revision ||
    !socialAutomationInputSchema.safeParse({ enabled: settings.enabled, createBlogDrafts: settings.createBlogDrafts, timezone: settings.timezone, slots: settings.slots }).success) return null;
  const scheduled = Date.parse(message.scheduledAt), current = new Date(now).getTime(), effective = Date.parse(settings.effectiveFrom);
  if (![scheduled, current, effective].every(Number.isFinite) || scheduled % 60000 !== 0 ||
    scheduled < effective || scheduled > current + 60000 || current - scheduled > SOCIAL_OCCURRENCE_MAX_AGE_MS) return null;
  const slot = settings.slots.find(value => value.id === message.slotId);
  if (!slot) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(scheduled)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return `${parts.hour}:${parts.minute}` === slot.time && new Date(`${date}T00:00:00Z`).getUTCDay() === slot.dayOfWeek ? date : null;
}
