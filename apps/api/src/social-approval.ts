import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicReportMarkdown, agentCopyValid, socialApprovalSnapshot, socialPublicationDestinationAssigned,
  type Project, type SocialContent, type SocialPublication } from '@citevia/core';
import { AccessError, createSocialMediaUploadStore, type SocialMediaUploadStore, type SocialUploadedMedia,
  type SocialPublisher, type Runtime } from '@citevia/storage';

export const fail = (status: number, code: string, message: string): never => { throw new AccessError(status, code, message); };
export interface SocialReviewServices {
  publisher?: () => Promise<SocialPublisher>;
  uploads?: () => SocialMediaUploadStore | undefined;
}
export const approvalHash = (post: SocialPublication) => createHash('sha256').update(socialApprovalSnapshot(post)).digest('hex');
// A new brand plan can prepare replacements for the same week. Clients may approve only the current batch.
export function fromPreviousBrandPlan(project: Project, post: SocialPublication) {
  return Boolean(post.context.socialBrand && project.socialAutomation?.revision !== post.revision);
}

export const contentSchema = z.object({ title: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(30000),
  hashtags: z.array(z.string().trim().regex(/^#[^\s#]+$/).max(100)).max(30) }).strict();
export function editable(post: SocialPublication, now: Date) {
  return post.destination.channel !== 'blog' && ['review_required', 'scheduled'].includes(post.status) &&
    !post.publishAttemptAt && !post.providerPostId && !(Date.parse(post.leaseUntil || '') > now.getTime());
}
export function validateContent(post: SocialPublication, content?: SocialContent) {
  if (!content) return fail(400, 'CONTENT_REQUIRED', 'Wait for the post content to finish.');
  contentSchema.parse(content);
  // The worker publishes the approved snapshot verbatim. Require a clean saved
  // revision before approval, including for drafts created by older generators.
  if ([content.title, content.body, ...content.hashtags].some(value => publicReportMarkdown(value) !== value)) {
    return fail(400, 'CONTENT_REVIEW_REQUIRED', 'Edit the caption, title, or hashtags and save the wording you want to publish.');
  }
  const channel = post.destination.channel;
  const fullText = [content.body, content.hashtags.join(' ')].filter(Boolean).join('\n\n');
  const valid = channel === 'linkedin' ? [...fullText].length <= 3000 : channel === 'tiktok' ? [...fullText].length <= 2200 : agentCopyValid(channel, content);
  if (!valid) fail(400, 'CONTENT_TOO_LONG', 'The caption or title exceeds this channel’s limit. Shorten it before saving.');
}
export function validateMedia(post: SocialPublication, media = post.media, allowEmpty = false) {
  const channel = post.destination.channel;
  if (!media || (!media.length && !allowEmpty)) return fail(400, 'MEDIA_REQUIRED', 'Add an image or video before approving this post.');
  const max = channel === 'instagram' ? 10 : 1;
  if (media.length > max || media.some(asset => asset.type !== (channel === 'tiktok' ? 'video' : 'image')))
    fail(400, 'INVALID_MEDIA', channel === 'instagram' ? 'Choose up to 10 images for Instagram.' : channel === 'tiktok' ? 'Choose one MP4 video for TikTok.' : 'Choose one image for this channel.');
  if (new Set(media.map(asset => asset.id || asset.url)).size !== media.length) fail(400, 'INVALID_MEDIA', 'Each media item may appear only once.');
}

export async function previewSocialMedia(post: SocialPublication, services: SocialReviewServices) {
  const sources = (post.checkpoints?.mediaSources ?? {}) as Record<string, SocialUploadedMedia>;
  const store = (services.uploads ?? createSocialMediaUploadStore)();
  return Promise.all((post.media ?? []).map(async asset => {
    const source = asset.id ? sources[asset.id] : undefined;
    const { type, mimeType, id, attribution } = asset;
    return { type, mimeType, id, attribution, url: source && store ? await store.preview(source) : asset.url };
  }));
}

export const approvalSchema = z.object({ version: z.number().int().positive(), previewConfirmed: z.literal(true), expressConsentGiven: z.literal(true),
        privacyLevel: z.string().min(1).max(80).optional(), allowComment: z.boolean().optional(), allowDuet: z.boolean().optional(), allowStitch: z.boolean().optional(),
        musicSoundId: z.string().min(1).max(200).optional(),
      }).strict();

export async function approveSocialPublication(runtime: Runtime, project: Project, post: SocialPublication, userId: string,
  now: Date, services: SocialReviewServices, input: z.infer<typeof approvalSchema>, reviewLinkId?: string) {
  const settings = project.socialAutomation;
  if (post.version !== input.version || !editable(post, now)) return fail(409, 'POST_CHANGED', 'This post changed or is already publishing. Open its latest preview.');
  if (post.status !== 'review_required') return fail(409, 'POST_CHANGED', 'This version is already approved.');
  if (!settings?.enabled) return fail(409, 'AUTOMATION_PAUSED', 'Enable automation before approving this post.');
  if (Date.parse(post.scheduledAt) <= now.getTime()) return fail(400, 'PUBLISH_TIME_PASSED', 'Choose a future publishing time, save, and review this post again.');
  validateContent(post, post.content); validateMedia(post);
  if (!socialPublicationDestinationAssigned(project, post) || !project.socialProfileId)
    return fail(409, 'DESTINATION_CHANGED', 'This publishing destination is no longer assigned. Prepare a new post.');
  if (!services.publisher) return fail(503, 'SOCIAL_NOT_CONFIGURED', 'Social connections are unavailable.');
  const adapter = await services.publisher();
  const account = (await adapter.accounts(project.socialProfileId)).find(account => account.id === post.destination.id && account.channel === post.destination.channel &&
    account.profileId === post.destination.profileId && account.active && !account.requiresReconnect);
  if (!account) return fail(409, 'DISCONNECTED', 'Reconnect this social account before approving the post.');
  if (post.destination.channel === 'tiktok') {
    if (!input.privacyLevel || !input.musicSoundId || ['allowComment', 'allowDuet', 'allowStitch'].some(key => typeof input[key as keyof typeof input] !== 'boolean'))
      return fail(400, 'TIKTOK_APPROVAL_REQUIRED', 'Choose music, privacy and interaction settings before approving TikTok.');
    const [creator, music] = await Promise.all([adapter.tiktokCreatorInfo(account.profileId, account.id), adapter.tiktokMusic(account.profileId, account.id)]);
    if (!creator.canPostMore || !creator.privacyLevels.includes(input.privacyLevel) || !music.some(track => track.id === input.musicSoundId) ||
      (['allowComment', 'allowDuet', 'allowStitch'] as const).some(key => input[key] && !creator.interactions[key]))
      return fail(400, 'TIKTOK_OPTIONS_CHANGED', 'TikTok options changed. Refresh the privacy and music choices.');
  }
  const { version: _version, ...consent } = input;
  const next: SocialPublication = { ...post, revision: settings.revision, status: 'scheduled', stage: 'publish', version: post.version + 1,
    nextAttemptAt: post.scheduledAt, attempts: 0, error: null, updatedAt: now.toISOString(),
    approval: { ...consent, approvedBy: userId, approvedAt: now.toISOString(), contentHash: approvalHash(post) } };
  if (!await runtime.repository.saveSocialPublication(next, post.version, reviewLinkId)) return fail(409, 'POST_CHANGED', 'This post changed. Refresh the preview.');
  // The due-work reconciler also recovers this record if enqueueing is interrupted.
  await runtime.queue.send([{ kind: 'social-publication', projectId: project.id, publicationId: post.id }], Math.min(900, Math.max(1, Math.ceil((Date.parse(post.scheduledAt) - now.getTime()) / 1000))));
  return next;
}
