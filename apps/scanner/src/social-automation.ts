import { createHash, randomUUID } from 'node:crypto';
import { ACTIVE_SOCIAL_PUBLICATION_STATUSES, DEFAULT_AGENT_CONTENT_MODEL, socialOccurrenceLocalDate, socialGenerationOccurrences, socialApprovalSnapshot,
  type AgentPostJob, type Project, type SocialGenerationMessage, type SocialOccurrenceMessage, type SocialPublication } from '@citevia/core';
import { createSocialPublisher, createSocialMediaUploadStore, socialPublisherConfigured, SocialPublisherError,
  type Runtime, type SocialPublisher, type SocialPublishResult, type SocialPublishMedia, type SocialMediaUploadStore, type SocialUploadedMedia } from '@citevia/storage';
import { createSocialMediaGenerator, type SocialBrandStyle, type SocialGeneratedCopy, type SocialGeneratedImage,
  type SocialGeneratedVideo, type SocialMediaGenerator } from './social-media.js';
import { inspectSocialVideo } from './social-video.js';

type ImageReceipt = Omit<SocialGeneratedImage, 'bytes'> & { base64: string };
type VideoReceipt = Omit<SocialGeneratedVideo, 'bytes'> & { base64: string };
const terminal = (post: SocialPublication) => !ACTIVE_SOCIAL_PUBLICATION_STATUSES.includes(post.status);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publishKey = (id: string) => { const hash = digest(id); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const uncertainty = () => new SocialPublisherError('generation_uncertain', 'A generation request may have completed without a saved result. This post was stopped to avoid duplicate charges.');

/** One generation/upload/publish stage per delivery, with durable receipts between paid calls. */
export class SocialAutomationEngine {
  constructor(private runtime: Runtime, private publisher: () => Promise<SocialPublisher> = createSocialPublisher,
    private generator: () => Promise<SocialMediaGenerator> = createSocialMediaGenerator, private now = () => new Date(),
    private publishingConfigured = () => publisher !== createSocialPublisher || socialPublisherConfigured(),
    private uploads: () => SocialMediaUploadStore | undefined = createSocialMediaUploadStore,
    private inspectVideo = inspectSocialVideo) {}

  async handleGeneration(message: SocialGenerationMessage): Promise<void> {
    const project = await this.runtime.repository.getProject(message.projectId);
    const now = this.now().toISOString();
    const occurrences = project && socialGenerationOccurrences(project, message, now);
    if (!project || !occurrences?.length) return;
    const destinations = project.socialProfileId && this.publishingConfigured()
      ? await (await this.publisher()).accounts(project.socialProfileId) : [];
    // Reserve chronologically so prompt rotation follows the publishing calendar.
    // A partially completed batch is safe to replay: each slot/date is unique.
    for (const occurrence of occurrences) {
      const reserved = await this.runtime.repository.reserveSocialOccurrence({ ...occurrence, now, destinations,
        generationScheduledAt: message.scheduledAt, generationTrigger: message.trigger });
      if (reserved.status !== 'created' && reserved.status !== 'existing') continue;
      await this.runtime.queue.send(reserved.publications.filter(post => !terminal(post) &&
        !(Date.parse(post.nextAttemptAt || '') > this.now().getTime())).map(post => ({
        kind: 'social-publication' as const, projectId: project.id, publicationId: post.id,
      })));
    }
  }

  async handleOccurrence(message: SocialOccurrenceMessage): Promise<void> {
    const project = await this.runtime.repository.getProject(message.projectId);
    if (!project || !socialOccurrenceLocalDate(project, message, this.now())) return;
    // Missing deployment configuration is distinct from a transient discovery error:
    // blog-only setups can run; vendor outages retain the occurrence for retry.
    const destinations = project.socialProfileId && this.publishingConfigured() ? await (await this.publisher()).accounts(project.socialProfileId) : [];
    const reserved = await this.runtime.repository.reserveSocialOccurrence({ ...message, now: this.now().toISOString(), destinations });
    if (reserved.status !== 'created' && reserved.status !== 'existing') return;
    await this.runtime.queue.send(reserved.publications.filter(post => !terminal(post)).map(post => ({
      kind: 'social-publication' as const, projectId: project.id, publicationId: post.id,
    })));
  }

  private key(post: SocialPublication, stage: string) { return `projects/${post.projectId}/social/${post.id}/${stage}.json`; }
  private async persist(post: SocialPublication, patch: Partial<SocialPublication>): Promise<SocialPublication> {
    const next = { ...post, ...patch, version: post.version + 1, updatedAt: this.now().toISOString() };
    if (!await this.runtime.repository.saveSocialPublication(next, post.version)) throw new Error('social_lease_lost');
    return next;
  }
  private async advance(post: SocialPublication, stage: string, patch: Partial<SocialPublication> = {}, delay = 0) {
    const next = await this.persist(post, { ...patch, stage, leaseOwner: undefined, leaseUntil: undefined, attempts: 0,
      nextAttemptAt: delay ? new Date(this.now().getTime() + delay * 1000).toISOString() : undefined });
    if (!terminal(next)) await this.runtime.queue.send([{ kind: 'social-publication', projectId: next.projectId, publicationId: next.id }], delay);
  }
  private async enabled(post: SocialPublication): Promise<Project | null> {
    const project = await this.runtime.repository.getProject(post.projectId);
    return project && !project.demo && project.socialAutomation?.enabled && project.socialAutomation.revision === post.revision ? project : null;
  }

  async handlePublication(projectId: string, publicationId: string): Promise<void> {
    const { repository, artifacts, queue } = this.runtime;
    const saved = await repository.getSocialPublication(projectId, publicationId);
    if (!saved || terminal(saved) || Date.parse(saved.leaseUntil || '') > this.now().getTime() ||
      Date.parse(saved.nextAttemptAt || '') > this.now().getTime()) return;
    let current: SocialPublication = { ...saved, version: saved.version + 1, attempts: (saved.attempts || 0) + 1,
      leaseOwner: randomUUID(), leaseUntil: new Date(this.now().getTime() + 6 * 60000).toISOString(), updatedAt: this.now().toISOString() };
    if (!await repository.saveSocialPublication(current, saved.version)) return;
    const stop = async (status: 'failed' | 'cancelled' | 'uncertain', code: string, message: string) => {
      await this.persist(current, { status, error: { code, message }, leaseOwner: undefined, leaseUntil: undefined });
    };
    const stopPaused = () => stop(current.publishAttemptAt ? 'uncertain' : 'cancelled', 'automation_paused', current.publishAttemptAt
      ? 'Automation was paused after a publishing request. Check the connected account to confirm its outcome.'
      : 'Automation was paused or its schedule changed. Saved content is preserved.');
    try {
      if (current.publishAttemptAt && !current.providerPostId) {
        const receipt = await artifacts.get<SocialPublishResult>(this.key(current, 'publication'));
        if (receipt) { await this.recordPublication(current, receipt); return; }
      }
      // Record the final outcome of a request already sent, even if the user paused in the meantime.
      if (current.providerPostId && current.status === 'publishing' && current.destination.channel !== 'blog') {
        const outcome = await (await this.publisher()).getPost(current.destination.profileId, current.destination.id, current.providerPostId);
        await this.recordPublication(current, outcome);
        return;
      }
      const project = await this.enabled(current);
      if (!project) { await stopPaused(); return; }
      if ((current.attempts || 0) > 5) { await stop(current.publishAttemptAt ? 'uncertain' : 'failed', 'recovery_exhausted', 'This post could not finish after repeated interruptions.'); return; }
      if (this.now().getTime() - Date.parse(current.scheduledAt) > 6 * 86400000) {
        await stop('cancelled', 'post_expired', 'This scheduled post expired before publication.'); return;
      }
      if (current.destination.channel === 'blog') {
        await this.blog(current, project); return;
      }
      const destination = current.destination;
      const destinationOptions = destination.options ? {
        ...(typeof destination.options.boardId === 'string' ? { boardId: destination.options.boardId } : {}),
        ...(typeof destination.options.subreddit === 'string' ? { subreddit: destination.options.subreddit } : {}),
        ...(typeof destination.options.flairId === 'string' ? { flairId: destination.options.flairId } : {}),
      } : undefined;
      if ((destination.channel === 'pinterest' && !destinationOptions?.boardId) ||
          (destination.channel === 'reddit' && !destinationOptions?.subreddit)) {
        await stop('failed', 'destination_required', 'Choose a publishing board or community in project settings first.'); return;
      }
      const publisher = await this.publisher();
      if (project.socialProfileId !== destination.profileId || !(await publisher.accounts(destination.profileId))
        .some(account => account.id === destination.id && account.channel === destination.channel && account.active && !account.requiresReconnect)) {
        await stop('cancelled', 'account_disconnected', 'The social account was disconnected. Saved content is preserved.'); return;
      }
      const frozenProject = { ...project, ...current.context };
      let mediaGenerator: Promise<SocialMediaGenerator> | undefined;
      const media = () => mediaGenerator ??= this.generator();
      if (destination.channel === 'tiktok' && current.stage === 'queued' && !await (await media()).videoReady()) {
        await stop('failed', 'video_not_configured', 'Video generation is not configured. No TikTok post was published.'); return;
      }
      const paid = async <T>(stage: string, execute: () => Promise<T>): Promise<T> => {
        const key = this.key(current, stage);
        const receipt = await artifacts.get<{ value: T }>(key);
        if (receipt) return receipt.value;
        if (current.checkpoints?.paidStage === stage) throw uncertainty();
        if (!await this.enabled(current)) throw new SocialPublisherError('automation_paused', 'Automation was paused.');
        current = await this.persist(current, { status: 'generating', checkpoints: { ...current.checkpoints, paidStage: stage } });
        const value = await execute();
        await artifacts.put(key, { value });
        return value;
      };
      if (current.stage === 'queued') {
        const posts = await publisher.recentPosts(destination.profileId, destination.id);
        await paid('style', async () => (await media()).analyzeStyle(frozenProject, destination, posts));
        await this.advance(current, 'copy'); return;
      }
      const style = (await artifacts.get<{ value: SocialBrandStyle }>(this.key(current, 'style')))?.value;
      if (!style && current.stage !== 'publish') throw new Error('social_style_missing');
      if (current.stage === 'copy') {
        const copy = await paid('copy', async () => (await media()).generateCopy(frozenProject, current.prompt, destination, style!));
        await this.advance(current, 'image-0', { content: { title: copy.title, body: copy.body, hashtags: copy.hashtags } }); return;
      }
      const copy = (await artifacts.get<{ value: SocialGeneratedCopy }>(this.key(current, 'copy')))?.value;
      if (!copy && current.stage !== 'publish') throw new Error('social_copy_missing');
      const total = copy?.slides.length ?? 0;
      const imageStep = current.stage.match(/^(image|qa|upload)-(\d+)$/);
      if (imageStep) {
        const index = Number(imageStep[2]);
        if (index >= total) throw new Error('social_image_index');
        if (imageStep[1] === 'image') {
          await paid<ImageReceipt>(current.stage, async () => {
            const { bytes, ...meta } = await (await media()).generateImage(frozenProject, current.prompt, copy!, destination, style!, index, total);
            return { ...meta, base64: Buffer.from(bytes).toString('base64') };
          });
          await this.advance(current, `qa-${index}`); return;
        }
        const image = (await artifacts.get<{ value: ImageReceipt }>(this.key(current, `image-${index}`)))?.value;
        if (!image) throw new Error('social_image_missing');
        const bytes = Buffer.from(image.base64, 'base64');
        if (imageStep[1] === 'qa') {
          await paid(current.stage, async () => { await (await media()).checkImage(frozenProject, current.prompt, copy!, destination, style!, { ...image, bytes }, index); return true; });
          await this.advance(current, `upload-${index}`); return;
        }
        if (destination.channel !== 'tiktok') {
          const key = this.key(current, `upload-${index}`);
          let uploaded = await artifacts.get<{ url: string; source?: SocialUploadedMedia }>(key);
          if (!uploaded) {
            const store = this.uploads(), id = `image-${index}`;
            if (store) {
              const source = await store.put(`projects/${current.projectId}/social/${current.id}/media/${id}`, bytes, image.mime, id);
              uploaded = { url: source.url, source };
            } else uploaded = await publisher.uploadMedia(`${current.id}-${index}.jpg`, bytes, image.mime);
          }
          await artifacts.put(key, uploaded);
          current = await this.persist(current, { media: [...(current.media || []).slice(0, index), { type: 'image', mimeType: image.mime, url: uploaded.url,
            ...(uploaded.source ? { id: uploaded.source.id } : {}) }],
            ...(uploaded.source ? { checkpoints: { ...current.checkpoints, mediaSources: {
              ...(current.checkpoints?.mediaSources as Record<string, SocialUploadedMedia> | undefined), [uploaded.source.id]: uploaded.source } } } : {}) });
        }
        await this.advance(current, index + 1 < total ? `image-${index + 1}` : destination.channel === 'tiktok' ? 'render' : 'publish'); return;
      }
      if (current.stage === 'render') {
        const key = this.key(current, 'video');
        if (!await artifacts.get<VideoReceipt>(key)) {
          const images: SocialGeneratedImage[] = [];
          for (let index = 0; index < total; index++) {
            const image = (await artifacts.get<{ value: ImageReceipt }>(this.key(current, `image-${index}`)))?.value;
            if (!image) throw new Error('social_image_missing');
            images.push({ ...image, bytes: Buffer.from(image.base64, 'base64') });
          }
          const { bytes, ...meta } = await (await media()).renderVideo(copy!, images);
          await artifacts.put(key, { ...meta, base64: Buffer.from(bytes).toString('base64') });
        }
        await this.advance(current, 'upload-video'); return;
      }
      if (current.stage === 'upload-video') {
        const video = await artifacts.get<VideoReceipt>(this.key(current, 'video'));
        if (!video) throw new Error('social_video_missing');
        const key = this.key(current, 'video-upload');
        let uploaded = await artifacts.get<{ url: string; source?: SocialUploadedMedia }>(key);
        if (!uploaded) {
          const store = this.uploads();
          if (store) {
            const source = await store.put(`projects/${current.projectId}/social/${current.id}/media/video`, Buffer.from(video.base64, 'base64'), video.mime, 'video');
            uploaded = { url: source.url, source };
          } else uploaded = await publisher.uploadMedia(`${current.id}.mp4`, Buffer.from(video.base64, 'base64'), video.mime);
        }
        await artifacts.put(key, uploaded);
        await this.advance(current, 'publish', { media: [{ type: 'video', url: uploaded.url, mimeType: video.mime, ...(uploaded.source ? { id: uploaded.source.id } : {}) }],
          checkpoints: { ...current.checkpoints, videoDuration: video.durationSeconds,
            ...(uploaded.source ? { mediaSources: { ...(current.checkpoints?.mediaSources as Record<string, SocialUploadedMedia> | undefined), [uploaded.source.id]: uploaded.source } } : {}) } }); return;
      }
      if (current.stage !== 'publish') throw new Error('social_stage_unknown');
      const approval = current.approval;
      if (!approval?.previewConfirmed || !approval.expressConsentGiven || !current.content ||
        approval.contentHash !== digest(socialApprovalSnapshot(current))) {
        if (current.publishAttemptAt) { await stop('uncertain', 'approval_changed', 'The publishing request no longer matches its reviewed content. Check the connected account.'); return; }
        await this.advance(current, 'publish', { status: 'review_required', approval: undefined }); return;
      }
      const scheduled = Date.parse(current.scheduledAt);
      if (!Number.isFinite(scheduled)) {
        await this.advance(current, 'publish', { status: 'review_required', approval: undefined,
          error: { code: 'invalid_publishing_time', message: 'Choose a valid publishing time and approve this post again.' } }); return;
      }
      if (scheduled > this.now().getTime()) {
        // Long waits live in the database, not in SQS (which permits at most 15 minutes).
        // Even a premature/duplicate delivery must never send a public post early.
        await this.persist(current, { status: 'scheduled', leaseOwner: undefined, leaseUntil: undefined,
          attempts: 0, nextAttemptAt: current.scheduledAt }); return;
      }
      const receiptKey = this.key(current, 'publication');
      const receipt = await artifacts.get<SocialPublishResult>(receiptKey);
      if (receipt) { await this.recordPublication(current, receipt); return; }
      if (current.publishAttemptAt && this.now().getTime() - Date.parse(current.publishAttemptAt) >= 23 * 3600000) {
        await stop('uncertain', 'publication_uncertain', 'The publishing result could not be confirmed. Check the social account before creating another post.'); return;
      }
      if (!await this.enabled(current)) { await stopPaused(); return; }
      // Vendor media links need not survive a month in review. Keep original bytes
      // privately and upload the immutable approved version only when it is due.
      const mediaReceiptKey = this.key(current, `publish-media-${approval.contentHash}`);
      let prepared = await artifacts.get<{ media: SocialPublishMedia[]; videoDuration?: number }>(mediaReceiptKey);
      if (!prepared) {
        if (current.publishAttemptAt) { await stop('uncertain', 'publication_media_uncertain', 'The sent media could not be recovered. Check the connected account before retrying.'); return; }
        prepared = await this.preparePublishMedia(current, publisher);
        await artifacts.put(mediaReceiptKey, prepared);
      }
      if (destination.channel === 'tiktok') {
        const creator = await publisher.tiktokCreatorInfo(destination.profileId, destination.id);
        const tracks = await publisher.tiktokMusic(destination.profileId, destination.id);
        if (!approval.privacyLevel || !creator.privacyLevels.includes(approval.privacyLevel) || !creator.canPostMore ||
          !tracks.some(track => track.id === approval.musicSoundId) ||
          (creator.maxVideoDurationSec && (!prepared.videoDuration || prepared.videoDuration > creator.maxVideoDurationSec)) ||
          (['allowComment', 'allowDuet', 'allowStitch'] as const).some(key => approval[key] && !creator.interactions[key]))
          throw new SocialPublisherError('tiktok_options_changed', 'TikTok publishing options changed. This post needs a new review.');
      }
      // Uploading a large video and checking platform options can take time.
      // Honor a pause/revision change that happened during those awaits before
      // recording a new public request; already-sent outcomes remain uncertain.
      if (!await this.enabled(current)) { await stopPaused(); return; }
      current = await this.persist(current, { publishAttemptAt: current.publishAttemptAt ?? this.now().toISOString() });
      const result = await publisher.publish(destination.profileId, destination, {
        title: current.content!.title, text: [current.content!.body, current.content!.hashtags.join(' ')].filter(Boolean).join('\n\n'), media: prepared.media,
        ...(destinationOptions ? { platformSpecificData: { ...destinationOptions } } : {}),
        ...(destination.channel === 'instagram' ? { platformSpecificData: { isAiGenerated: true } } : {}),
        ...(destination.channel === 'tiktok' && approval ? {
          tiktokApproval: { previewConfirmed: true, expressConsentGiven: true, privacyLevel: approval.privacyLevel!,
            allowComment: approval.allowComment === true, allowDuet: approval.allowDuet === true, allowStitch: approval.allowStitch === true },
          platformSpecificData: { videoMadeWithAi: true, musicSoundInfo: { musicSoundId: approval.musicSoundId! }, commercialContentType: 'brand_organic' },
        } : {}),
      }, publishKey(current.id));
      await artifacts.put(receiptKey, result);
      await this.recordPublication(current, result);
    } catch (error) {
      if ((error as Error).message === 'social_lease_lost') return;
      if (error instanceof SocialPublisherError && ['tiktok_options_changed', 'review_media_invalid'].includes(error.code) && !current.publishAttemptAt) {
        await this.advance(current, 'publish', { status: 'review_required', approval: undefined,
          error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof SocialPublisherError && (error.retryable || error.outcomeUnknown) && (current.attempts || 0) < 5) {
        const delay = Math.max(60, Math.min(86400, error.retryAfterSeconds || 60));
        await this.persist(current, { leaseOwner: undefined, leaseUntil: undefined,
          nextAttemptAt: new Date(this.now().getTime() + delay * 1000).toISOString() });
        await queue.send([{ kind: 'social-publication', projectId, publicationId }], Math.min(900, delay));
        return;
      }
      const code = error instanceof SocialPublisherError ? error.code : 'social_generation_failed';
      await stop(current.publishAttemptAt ? 'uncertain' : 'failed', code,
        error instanceof SocialPublisherError ? error.message : 'Content generation could not finish. No new post was published.');
    }
  }

  private async preparePublishMedia(post: SocialPublication, publisher: SocialPublisher): Promise<{ media: SocialPublishMedia[]; videoDuration?: number }> {
    const media: SocialPublishMedia[] = [];
    let videoDuration: number | undefined;
    let legacyImages: Map<string, number> | undefined;
    const sources = (post.checkpoints?.mediaSources ?? {}) as Record<string, SocialUploadedMedia>;
    for (const [index, asset] of (post.media ?? []).entries()) {
      let bytes: Uint8Array | undefined;
      if (asset.id) {
        const source = sources[asset.id], store = this.uploads();
        if (!store || !source || source.id !== asset.id || source.type !== asset.type || source.mimeType !== asset.mimeType || source.url !== asset.url ||
          !source.key.startsWith(`projects/${post.projectId}/social/${post.id}/`))
          throw new SocialPublisherError('review_media_invalid', 'This media is no longer available. Replace it and approve the post again.');
        try {
          bytes = await store.read(source);
          if (asset.type === 'video') videoDuration = (await this.inspectVideo(bytes)).durationSeconds;
        } catch {
          throw new SocialPublisherError('review_media_invalid', 'This image or video could not be validated. Replace it with a valid image or vertical MP4 and approve again.');
        }
      } else if (asset.type === 'video') {
        const upload = await this.runtime.artifacts.get<{ url: string }>(this.key(post, 'video-upload'));
        const video = upload?.url === asset.url ? await this.runtime.artifacts.get<VideoReceipt>(this.key(post, 'video')) : undefined;
        if (video?.mime === asset.mimeType) { bytes = Buffer.from(video.base64, 'base64'); videoDuration = video.durationSeconds; }
      } else {
        // Legacy/local previews may have no private object id yet; original
        // generated receipts still allow a fresh delivery URL without a paid call.
        // Resolve the original asset identity, not its edited carousel position.
        if (!legacyImages) {
          const generated = await this.runtime.artifacts.get<{ value: SocialGeneratedCopy }>(this.key(post, 'copy'));
          const count = Math.max(1, Math.min(10, generated?.value.slides.length ?? 10));
          const uploads = await Promise.all(Array.from({ length: count }, async (_, originalIndex) => ({ originalIndex,
            upload: await this.runtime.artifacts.get<{ url: string }>(this.key(post, `upload-${originalIndex}`)) })));
          legacyImages = new Map(uploads.filter(item => typeof item.upload?.url === 'string').map(item => [item.upload!.url, item.originalIndex]));
        }
        const originalIndex = legacyImages.get(asset.url);
        const image = originalIndex !== undefined ? await this.runtime.artifacts.get<{ value: ImageReceipt }>(this.key(post, `image-${originalIndex}`)) : undefined;
        if (image?.value.mime === asset.mimeType) bytes = Buffer.from(image.value.base64, 'base64');
      }
      if (!bytes) throw new SocialPublisherError('review_media_invalid', 'The original media could not be recovered. Replace it and approve the post again.');
      const uploaded = await publisher.uploadMedia(`${post.id}-${post.approval!.contentHash}-${index}.${asset.type === 'video' ? 'mp4' : asset.mimeType === 'image/png' ? 'png' : asset.mimeType === 'image/webp' ? 'webp' : 'jpg'}`, bytes, asset.mimeType);
      media.push({ type: asset.type, url: uploaded.url });
    }
    if (!media.length) throw new SocialPublisherError('review_media_invalid', 'Add an image or video and approve this post again.');
    return { media, ...(videoDuration ? { videoDuration } : {}) };
  }

  private async recordPublication(post: SocialPublication, result: SocialPublishResult) {
    if (result.status === 'publishing' && this.now().getTime() - Date.parse(post.publishAttemptAt || post.createdAt) > 86400000) {
      await this.advance(post, 'publish', { status: 'uncertain', providerPostId: result.providerPostId,
        error: { code: 'publication_pending', message: 'Publication is still unconfirmed. Check the connected account.' } }); return;
    }
    await this.advance(post, 'publish', { providerPostId: result.providerPostId, status: result.status,
      publishedUrl: result.url, publishedAt: result.status === 'published' ? this.now().toISOString() : undefined,
      error: result.error ? { code: 'publication_failed', message: result.error } : null }, result.status === 'publishing' ? 60 : 0);
  }

  private async blog(post: SocialPublication, project: Project) {
    const id = `post_${digest(post.id).slice(0, 40)}`;
    let draft = await this.runtime.repository.getAgentPost(project.id, id);
    if (!draft) {
      const job: AgentPostJob = { id, projectId: project.id, channel: 'blog', createdBy: 'social-automation',
        fingerprint: digest(post.id), prompt: post.prompt.text, promptId: post.prompt.id, topic: post.prompt.topic || 'General',
        status: 'queued', content: null, error: null, version: 1, generation: 1, attempts: 0,
        model: process.env.OPENAI_CONTENT_MODEL || DEFAULT_AGENT_CONTENT_MODEL, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
        context: post.context, socialAutomation: { publicationId: post.id, revision: post.revision } };
      const result = await this.runtime.repository.reserveAgentPost(job, null);
      if (result === 'limit') { await this.advance(post, 'blog', {}, 60); return; }
      draft = await this.runtime.repository.getAgentPost(project.id, id);
    }
    if (!draft) throw new Error('social_blog_missing');
    if (draft.status === 'draft') { await this.advance(post, 'blog', { status: 'draft_created', draftPostId: id }); return; }
    if (draft.status === 'failed') { await this.advance(post, 'blog', { status: 'failed', draftPostId: id, error: draft.error }); return; }
    await this.runtime.queue.send([{ kind: 'agent-post', projectId: project.id, postId: id }]);
    await this.advance(post, 'blog', { draftPostId: id }, 60);
  }

  async reconcile() {
    const posts = await this.runtime.repository.listActiveSocialPublications(100, this.now().toISOString());
    await this.runtime.queue.send(posts.filter(post => !(Date.parse(post.leaseUntil || '') > this.now().getTime()) &&
      !(Date.parse(post.nextAttemptAt || '') > this.now().getTime())).map(post => ({ kind: 'social-publication' as const,
        projectId: post.projectId, publicationId: post.id })));
  }
  async deadLetter(projectId: string, publicationId: string) {
    // Durable leases/attempts own retries; old duplicate SQS messages cannot cancel newer stages.
    await this.handlePublication(projectId, publicationId);
  }
}
