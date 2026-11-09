import { restoreReportFields } from './public-report.js';
import { socialPublicationDestinationAssigned } from '@citevia/core';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SOCIAL_CHANNELS, defaultSocialAutomationSettings, socialAutomationInputSchema, parseStoredSocialAutomation, agentImageSchema, type Project, type SocialPublication } from '@citevia/core';
import { createSocialMediaUploadStore, validateSocialUpload, type SocialMediaUploadStore, type SocialUploadedMedia, type Runtime, type SocialPublisher } from '@citevia/storage';
import { approvalSchema, approveSocialPublication, contentSchema, editable, fail, fromPreviousBrandPlan, previewSocialMedia, validateContent, validateMedia } from './social-approval.js';
import { manageReviewLinks } from './social-review-links.js';
import { repairSocialSchedule, syncSocialSchedule } from './social-scheduler.js';

export interface SocialApiOptions {
  publisher?: () => Promise<SocialPublisher>;
  generationAvailable: boolean;
  unsplashAvailable?: boolean;
  blogAvailable: boolean;
  videoAvailable?: boolean;
  frontendOrigin: string;
  sync?: (project: Project) => Promise<void>;
  uploads?: () => SocialMediaUploadStore | undefined;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const mediaSchema = z.object({ id: z.string().min(1).max(200).optional(), type: z.enum(['image', 'video']), url: z.string().url().max(8192), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']), attribution: z.array(agentImageSchema).max(3).optional(), contentDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
interface UploadIntent { projectId: string; publicationId: string; version: number; id: string; key: string; mimeType: string; size: number; replaceIndex?: number; expiresAt: string }
export function publicSocialPublication(post: SocialPublication) {
  return { id: post.id, prompt: post.prompt.text, promptId: post.prompt.id, channel: post.destination.channel,
    brandName: post.context.socialBrand?.name,
    clientApproved: post.approval?.approvedBy.startsWith('client-review:') || undefined,
    destination: post.destination.username, status: post.status, createdAt: post.createdAt, scheduledAt: post.scheduledAt,
    updatedAt: post.updatedAt, version: post.version, content: post.content, media: post.media,
    draftPostId: post.draftPostId, publishedUrl: post.publishedUrl, error: post.error };
}

export async function socialRoute(runtime: Runtime, project: Project, userId: string, tail: string,
  request: Request, now: Date, options: SocialApiOptions, body: (request: Request) => Promise<unknown>): Promise<Response | null> {
  if (tail !== 'social' && !tail.startsWith('social/')) return null;
  const { repository, queue } = runtime;
  if (request.method !== 'GET' && (project.role !== 'owner' || project.demo))
    fail(403, 'FORBIDDEN', 'Project owner access is required.');
  if (tail === 'social/review-links' || tail.startsWith('social/review-links/'))
    return manageReviewLinks(runtime, project, userId, tail, request, now, options.frontendOrigin, body);
  const settings = { ...(project.socialAutomation ?? defaultSocialAutomationSettings(project.timezone)),
    imageSource: project.socialAutomation?.imageSource ?? 'openai',
    shareFacebookInstagramContent: project.socialAutomation?.shareFacebookInstagramContent ?? false };
  const uploadStore = () => (options.uploads ?? createSocialMediaUploadStore)();
  const preview = async (post: SocialPublication) => {
    const media = await previewSocialMedia(post, options);
    return { ...publicSocialPublication(post), media, editable: project.role === 'owner' && !project.demo && editable(post, now) };
  };
  const generate = () => queue.send([{ kind: 'social-generation', projectId: project.id, revision: settings.revision, scheduledAt: now.toISOString(), trigger: 'manual' }]);
  const publisher = async () => {
    if (!options.publisher) return fail(503, 'SOCIAL_NOT_CONFIGURED', 'Social connections are not configured yet. Contact your administrator.');
    return options.publisher();
  };
  const connections = async () => project.socialProfileId && options.publisher
    ? (await (await publisher()).accounts(project.socialProfileId)).filter(account => account.profileId === project.socialProfileId) : [];
  if (tail === 'social' && request.method === 'GET') {
    const accounts = await connections();
    return json({ settings, version: project.version, destinationOptions: project.socialDestinationOptions ?? {}, connections: accounts.map(({ profileId: _profile, ...account }) => account),
      publishingAvailable: !!options.publisher, generationAvailable: options.generationAvailable, unsplashAvailable: !!options.unsplashAvailable, blogAvailable: options.blogAvailable, videoAvailable: !!options.videoAvailable });
  }
  const boards = tail.match(/^social\/accounts\/([^/]+)\/boards$/);
  if (boards && request.method === 'GET') {
    if (!project.socialProfileId) return fail(404, 'NOT_FOUND', 'Connected account not found.');
    return json({ items: await (await publisher()).pinterestBoards(project.socialProfileId, decodeURIComponent(boards[1])) });
  }
  if (tail === 'social/destinations' && request.method === 'PATCH') {
    const input = z.object({ version: z.number().int().positive(), destinationId: z.string().min(1).max(255),
      boardId: z.string().min(1).max(255).optional(), subreddit: z.string().regex(/^[A-Za-z0-9_]{2,30}$/).optional(),
      flairId: z.string().max(100).optional(),
    }).strict().parse(await body(request));
    if (input.version !== project.version) return fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    const account = (await connections()).find(account => account.id === input.destinationId && account.active && !account.requiresReconnect);
    if (!account) return fail(404, 'NOT_FOUND', 'Connected account not found.');
    if (account.channel !== 'pinterest' && account.channel !== 'reddit') return fail(400, 'INVALID_DESTINATION', 'This channel does not need a publishing destination.');
    if (account.channel === 'pinterest' && (!input.boardId || !(await (await publisher()).pinterestBoards(account.profileId, account.id)).some(board => board.id === input.boardId)))
      return fail(400, 'INVALID_BOARD', 'Choose one of this account’s Pinterest boards.');
    if (account.channel === 'reddit' && !input.subreddit) return fail(400, 'INVALID_COMMUNITY', 'Choose a subreddit for this account.');
    const destinationOptions = account.channel === 'pinterest' ? { boardId: input.boardId } : { subreddit: input.subreddit, ...(input.flairId ? { flairId: input.flairId } : {}) };
    const saved = { ...project, socialDestinationOptions: { ...project.socialDestinationOptions, [account.id]: destinationOptions }, version: project.version + 1, updatedAt: now.toISOString() };
    if (!await repository.saveProject(saved, project.version)) return fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    return json({ version: saved.version, destinationOptions: saved.socialDestinationOptions });
  }
  if (tail === 'social/settings' && request.method === 'PATCH') {
    const raw = z.object({ version: z.number().int().positive(), settings: z.record(z.string(), z.unknown()) }).strict().parse(await body(request));
    if (raw.version !== project.version) fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    // The public form can contain withheld wording. Match by ID so reordering brands cannot transfer a brief.
    const incomingBrands = raw.settings.brands;
    const restoredBrands = Array.isArray(incomingBrands) ? incomingBrands.map(brand => {
      const saved = settings.brands?.find(item => item.id === brand?.id);
      return saved ? restoreReportFields(brand, { name: saved.name, description: saved.description }) : brand;
    }) : incomingBrands;
    const input = { settings: socialAutomationInputSchema.parse({ ...raw.settings,
      brands: Object.hasOwn(raw.settings, 'brands') ? restoredBrands : settings.brands,
      generationTime: Object.hasOwn(raw.settings, 'generationTime') ? raw.settings.generationTime : settings.generationTime,
      generationCadence: Object.hasOwn(raw.settings, 'generationCadence') ? raw.settings.generationCadence : settings.generationCadence,
      imageSource: Object.hasOwn(raw.settings, 'imageSource') ? raw.settings.imageSource : settings.imageSource,
      shareFacebookInstagramContent: Object.hasOwn(raw.settings, 'shareFacebookInstagramContent')
        ? raw.settings.shareFacebookInstagramContent : settings.shareFacebookInstagramContent ?? false }) };
    const brands = input.settings.brands ?? [];
    const unchanged = brands.length > 0 && isDeepStrictEqual(parseStoredSocialAutomation(settings).data, input.settings);
    if (unchanged && settings.scheduleStatus === 'synced') return json({ settings, version: project.version });
    // Always allow a pause during a provider outage. Verify new assignments even on paused plans.
    const changedAssignments = brands.filter(brand => !settings.brands?.some(previous =>
      previous.id === brand.id && previous.facebookDestinationId === brand.facebookDestinationId && previous.instagramDestinationId === brand.instagramDestinationId));
    const accounts = input.settings.enabled || changedAssignments.length ? await connections() : [];
    for (const brand of input.settings.enabled ? brands : changedAssignments) {
      for (const channel of ['facebook', 'instagram'] as const) {
        const id = channel === 'facebook' ? brand.facebookDestinationId : brand.instagramDestinationId;
        if (!accounts.some(account => account.id === id && account.channel === channel && account.active && !account.requiresReconnect))
          return fail(400, 'INVALID_BRAND_DESTINATION', `Choose a connected ${channel === 'facebook' ? 'Facebook' : 'Instagram'} account for ${brand.name}.`);
      }
    }
    if (input.settings.enabled) {
      if (!options.generationAvailable) fail(503, 'GENERATION_UNAVAILABLE', 'Content generation is not configured yet.');
      if (!project.prompts.some(prompt => prompt.active)) fail(400, 'NO_PROMPTS', 'Add an active prompt before enabling automation.');
      if (!brands.length && input.settings.createBlogDrafts && !options.blogAvailable) fail(503, 'BLOG_UNAVAILABLE', 'Blog draft generation is not configured yet.');
      if (input.settings.imageSource === 'unsplash' && !options.unsplashAvailable && accounts.some(account => account.active && !account.requiresReconnect))
        fail(503, 'UNSPLASH_UNAVAILABLE', 'Unsplash images are not configured yet. Choose OpenAI or contact your administrator.');
      if (!input.settings.createBlogDrafts && !accounts.some(account => account.active && !account.requiresReconnect))
        fail(400, 'NO_SOCIAL_CONNECTIONS', 'Connect at least one social account before enabling automation.');
    }
    if (!unchanged) {
      const next: Project = { ...project, version: project.version + 1, updatedAt: now.toISOString(),
        socialAutomation: { ...input.settings, revision: settings.revision + 1, effectiveFrom: now.toISOString(), scheduleStatus: 'pending' } };
      if (!await repository.saveProject(next, project.version)) fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    }
    try {
      const saved = await repairSocialSchedule(repository, project.id, options.sync ?? syncSocialSchedule, () => now);
      if (saved.socialAutomation?.enabled) await queue.send([{ kind: 'social-generation', projectId: saved.id,
        revision: saved.socialAutomation.revision, scheduledAt: now.toISOString(), trigger: 'manual' }]);
      return json({ settings: saved.socialAutomation, version: saved.version });
    } catch {
      return fail(503, 'SCHEDULE_SYNC_FAILED', 'Your settings were saved. The schedule could not sync yet and will be retried automatically.');
    }
  }
  if (tail === 'social/generate' && request.method === 'POST') {
    const input = z.object({ version: z.number().int().positive() }).strict().parse(await body(request));
    if (input.version !== project.version) return fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    if (!settings.enabled) return fail(409, 'AUTOMATION_PAUSED', 'Enable automation before preparing content.');
    if (!options.generationAvailable) return fail(503, 'GENERATION_UNAVAILABLE', 'Content generation is not configured yet.');
    if (settings.imageSource === 'unsplash' && !options.unsplashAvailable && (await connections()).some(account => account.active && !account.requiresReconnect))
      return fail(503, 'UNSPLASH_UNAVAILABLE', 'Unsplash images are not configured yet. Choose OpenAI or contact your administrator.');
    await generate();
    return json({ queued: true }, 202);
  }
  if (tail === 'social/connect' && request.method === 'POST') {
    const input = z.object({ channel: z.enum(SOCIAL_CHANNELS) }).strict().parse(await body(request));
    const adapter = await publisher();
    let profileId = project.socialProfileId;
    if (!profileId) {
      const proposed = await adapter.ensureProfile(project.id, project.name, settings.timezone);
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await repository.getProject(project.id);
        if (!latest) return fail(404, 'NOT_FOUND', 'Project not found.');
        if (latest.socialProfileId) { profileId = latest.socialProfileId; break; }
        if (await repository.saveProject({ ...latest, socialProfileId: proposed, version: latest.version + 1, updatedAt: now.toISOString() }, latest.version)) {
          profileId = proposed; break;
        }
      }
      if (!profileId) return fail(409, 'VERSION_CONFLICT', 'Settings changed. Try connecting again.');
    }
    // The browser cannot choose a redirect origin or another account's vendor profile.
    const redirect = new URL('/#integrations', options.frontendOrigin).href;
    return json({ url: await adapter.connectUrl(profileId, input.channel, redirect) });
  }
  if (tail === 'social/publications' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const offset = z.coerce.number().int().min(0).max(1000000).parse(params.get('offset') || 0);
    if (params.get('clientReview') === 'true') {
      const page = await repository.listSocialPublications(project.id, offset, 100, true);
      const items = page.items.map(post => {
        const previousPlan = fromPreviousBrandPlan(project, post);
        return {
          id: post.id, version: post.version, brandName: post.context.socialBrand?.name, title: post.content?.title ?? post.prompt.text,
          channel: post.destination.channel, destination: post.destination.username, scheduledAt: post.scheduledAt, previousPlan,
          shareable: !previousPlan && editable(post, now) && Boolean(post.content && post.media?.length) &&
            Date.parse(post.scheduledAt) > now.getTime() && socialPublicationDestinationAssigned(project, post),
        };
      });
      return json({ items, total: page.total });
    }
    const page = await repository.listSocialPublications(project.id, offset, 20);
    return json({ items: await Promise.all(page.items.map(preview)), total: page.total });
  }
  const match = tail.match(/^social\/publications\/([a-zA-Z0-9_-]+)(?:\/(approve|tiktok-options|media\/start|media\/complete))?$/);
  if (match) {
    const post = await repository.getSocialPublication(project.id, match[1]);
    if (!post) return fail(404, 'NOT_FOUND', 'Post not found.');
    if (!match[2] && request.method === 'GET') return json(await preview(post));
    const assertEditable = (version: number) => {
      if (post.version !== version || !editable(post, now)) return fail(409, 'POST_CHANGED', 'This post changed or is already publishing. Open its latest preview.');
    };
    const saveReview = async (patch: Partial<SocialPublication>) => {
      const next: SocialPublication = { ...post, ...patch, status: 'review_required', stage: 'publish', version: post.version + 1,
        approval: undefined, leaseOwner: undefined, leaseUntil: undefined, nextAttemptAt: undefined, attempts: 0, error: null, updatedAt: now.toISOString() };
      if (!await repository.saveSocialPublication(next, post.version)) return fail(409, 'POST_CHANGED', 'This post changed. Your changes were not applied. Refresh the preview.');
      return json(await preview(next));
    };
    if (!match[2] && request.method === 'PATCH') {
      const input = z.object({ version: z.number().int().positive(), content: contentSchema,
        media: z.array(mediaSchema).max(10).optional(), scheduledAt: z.string().datetime({ offset: true }).optional() }).strict().parse(restoreReportFields(await body(request), { content: post.content }));
      assertEditable(input.version); validateContent(post, input.content);
      if (input.scheduledAt && (Date.parse(input.scheduledAt) <= now.getTime() || Date.parse(input.scheduledAt) > now.getTime() + 366 * 86400000))
        return fail(400, 'INVALID_PUBLISH_TIME', 'Choose a future publishing time within the next year.');
      const media = input.media?.map(asset => {
        const owned = post.media?.find(existing => asset.id ? existing.id === asset.id : !existing.id && existing.url === asset.url);
        if (!owned || owned.type !== asset.type || owned.mimeType !== asset.mimeType) return fail(400, 'INVALID_MEDIA', 'Upload replacement media through this post’s editor.');
        return owned; // Preview URLs expire; the canonical version-pinned identity must stay unchanged.
      }) ?? post.media;
      validateMedia(post, media, true);
      return saveReview({ content: input.content, media, ...(input.scheduledAt ? { scheduledAt: new Date(input.scheduledAt).toISOString() } : {}) });
    }
    if (match[2] === 'media/start' && request.method === 'POST') {
      const input = z.object({ version: z.number().int().positive(), filename: z.string().min(1).max(255), mimeType: z.string(),
        size: z.number().int().positive(), replaceIndex: z.number().int().min(0).max(9).optional() }).strict().parse(await body(request));
      assertEditable(input.version);
      const type = validateSocialUpload(input.mimeType, input.size), current = post.media ?? [];
      if (type !== (post.destination.channel === 'tiktok' ? 'video' : 'image')) return fail(400, 'INVALID_MEDIA', 'Choose the correct image or video format for this channel.');
      if (input.replaceIndex !== undefined && input.replaceIndex >= current.length) return fail(400, 'INVALID_MEDIA', 'That media item changed. Refresh the preview.');
      if (post.destination.channel === 'instagram' && input.replaceIndex === undefined && current.length >= 10) return fail(400, 'INVALID_MEDIA', 'Instagram supports up to 10 images in this editor.');
      const store = uploadStore(); if (!store) return fail(503, 'UPLOADS_UNAVAILABLE', 'Media uploads are not configured yet.');
      const id = randomUUID(), key = `projects/${project.id}/social/${post.id}/uploads/${id}`;
      const intent: UploadIntent = { projectId: project.id, publicationId: post.id, version: post.version, id, key, mimeType: input.mimeType,
        size: input.size, replaceIndex: input.replaceIndex, expiresAt: new Date(now.getTime() + 3600000).toISOString() };
      await runtime.artifacts.put(key + '.json', intent);
      return json({ uploadId: id, ...await store.start(key, input.mimeType, input.size) });
    }
    if (match[2] === 'media/complete' && request.method === 'POST') {
      const input = z.object({ version: z.number().int().positive(), uploadId: z.string().uuid() }).strict().parse(await body(request));
      assertEditable(input.version);
      const key = `projects/${project.id}/social/${post.id}/uploads/${input.uploadId}`;
      const intent = await runtime.artifacts.get<UploadIntent>(key + '.json');
      if (!intent || intent.projectId !== project.id || intent.publicationId !== post.id || intent.version !== post.version || Date.parse(intent.expiresAt) <= now.getTime())
        return fail(409, 'UPLOAD_EXPIRED', 'This upload expired or the post changed. Upload the file again.');
      const store = uploadStore(); if (!store) return fail(503, 'UPLOADS_UNAVAILABLE', 'Media uploads are not configured yet.');
      const source = await store.complete(intent.key, intent.mimeType, intent.size, intent.id);
      // Only a shared image needs byte comparison across separately scoped private object keys.
      // read() verifies the pinned version, declared image size and file signature.
      const contentDigest = post.sharedGeneration && source.type === 'image'
        ? createHash('sha256').update(await store.read(source)).digest('hex') : undefined;
      const asset = { id: source.id, type: source.type, url: source.url, mimeType: source.mimeType, ...(contentDigest ? { contentDigest } : {}) };
      const media = [...(post.media ?? [])];
      if (intent.replaceIndex !== undefined) media[intent.replaceIndex] = asset;
      else if (post.destination.channel === 'instagram') media.push(asset);
      else media.splice(0, media.length, asset);
      validateMedia(post, media);
      return saveReview({ media, checkpoints: { ...post.checkpoints, mediaSources: { ...((post.checkpoints?.mediaSources ?? {}) as Record<string, SocialUploadedMedia>), [source.id]: source } } });
    }
    if (match[2] === 'tiktok-options' && request.method === 'GET' && post.destination.channel === 'tiktok') {
      if (!project.socialProfileId) return fail(409, 'DISCONNECTED', 'Reconnect TikTok first.');
      const adapter = await publisher();
      const [creator, music] = await Promise.all([
        adapter.tiktokCreatorInfo(project.socialProfileId, post.destination.id),
        adapter.tiktokMusic(project.socialProfileId, post.destination.id),
      ]);
      return json({ creator, music });
    }
    if (match[2] === 'approve' && request.method === 'POST') {
      const input = approvalSchema.parse(await body(request));
      const next = await approveSocialPublication(runtime, project, post, userId, now, options, input);
      return json(await preview(next), 202);
    }
  }
  return fail(404, 'NOT_FOUND', 'Social endpoint not found.');
}
