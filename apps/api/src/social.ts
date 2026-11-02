import { z } from 'zod';
import { SOCIAL_CHANNELS, defaultSocialAutomationSettings, socialAutomationInputSchema, type Project, type SocialPublication } from '@citevia/core';
import { AccessError, type Runtime, type SocialPublisher } from '@citevia/storage';
import { repairSocialSchedule, syncSocialSchedule } from './social-scheduler.js';

export interface SocialApiOptions {
  publisher?: () => Promise<SocialPublisher>;
  generationAvailable: boolean;
  blogAvailable: boolean;
  videoAvailable?: boolean;
  frontendOrigin: string;
  sync?: (project: Project) => Promise<void>;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const fail = (status: number, code: string, message: string): never => { throw new AccessError(status, code, message); };
export function publicSocialPublication(post: SocialPublication) {
  return { id: post.id, prompt: post.prompt.text, promptId: post.prompt.id, channel: post.destination.channel,
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
  const settings = project.socialAutomation ?? defaultSocialAutomationSettings(project.timezone);
  const publisher = async () => {
    if (!options.publisher) return fail(503, 'SOCIAL_NOT_CONFIGURED', 'Social connections are not configured yet. Contact your administrator.');
    return options.publisher();
  };
  const connections = async () => project.socialProfileId && options.publisher
    ? (await publisher()).accounts(project.socialProfileId) : [];
  if (tail === 'social' && request.method === 'GET') {
    const accounts = await connections();
    return json({ settings, version: project.version, destinationOptions: project.socialDestinationOptions ?? {}, connections: accounts.map(({ profileId: _profile, ...account }) => account),
      publishingAvailable: !!options.publisher, generationAvailable: options.generationAvailable, blogAvailable: options.blogAvailable, videoAvailable: !!options.videoAvailable });
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
    const input = z.object({ version: z.number().int().positive(), settings: socialAutomationInputSchema }).strict().parse(await body(request));
    if (input.version !== project.version) fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    if (input.settings.enabled) {
      if (!options.generationAvailable) fail(503, 'GENERATION_UNAVAILABLE', 'Content generation is not configured yet.');
      if (!project.prompts.some(prompt => prompt.active)) fail(400, 'NO_PROMPTS', 'Add an active prompt before enabling automation.');
      if (input.settings.createBlogDrafts && !options.blogAvailable) fail(503, 'BLOG_UNAVAILABLE', 'Blog draft generation is not configured yet.');
      const accounts = await connections();
      if (!input.settings.createBlogDrafts && !accounts.some(account => account.active && !account.requiresReconnect))
        fail(400, 'NO_SOCIAL_CONNECTIONS', 'Connect at least one social account before enabling automation.');
    }
    const next: Project = { ...project, version: project.version + 1, updatedAt: now.toISOString(),
      socialAutomation: { ...input.settings, revision: settings.revision + 1, effectiveFrom: now.toISOString(), scheduleStatus: 'pending' } };
    if (!await repository.saveProject(next, project.version)) fail(409, 'VERSION_CONFLICT', 'Settings changed. Refresh and try again.');
    try {
      const saved = await repairSocialSchedule(repository, project.id, options.sync ?? syncSocialSchedule, () => now);
      return json({ settings: saved.socialAutomation, version: saved.version });
    } catch {
      return fail(503, 'SCHEDULE_SYNC_FAILED', 'Your settings were saved. The schedule could not sync yet and will be retried automatically.');
    }
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
    const page = await repository.listSocialPublications(project.id, offset, 20);
    return json({ items: page.items.map(publicSocialPublication), total: page.total });
  }
  const match = tail.match(/^social\/publications\/([a-zA-Z0-9_-]+)(?:\/(approve|tiktok-options))?$/);
  if (match) {
    const post = await repository.getSocialPublication(project.id, match[1]);
    if (!post) return fail(404, 'NOT_FOUND', 'Post not found.');
    if (!match[2] && request.method === 'GET') return json(publicSocialPublication(post));
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
      const input = z.object({ version: z.number().int().positive(), previewConfirmed: z.literal(true), expressConsentGiven: z.literal(true),
        privacyLevel: z.string().min(1).max(80), allowComment: z.boolean(), allowDuet: z.boolean(), allowStitch: z.boolean(),
        musicSoundId: z.string().min(1).max(200),
      }).strict().parse(await body(request));
      if (post.destination.channel !== 'tiktok' || post.status !== 'review_required' || post.version !== input.version)
        return fail(409, 'POST_CHANGED', 'This post changed. Open its latest preview before approving.');
      if (!settings.enabled || post.revision !== settings.revision || !project.socialProfileId)
        return fail(409, 'AUTOMATION_PAUSED', 'The schedule changed. This draft cannot be published.');
      if (now.getTime() - Date.parse(post.createdAt) > 6 * 86400000)
        return fail(409, 'PREVIEW_EXPIRED', 'This preview expired. Use a newly generated post.');
      const next: SocialPublication = { ...post, status: 'queued', stage: 'publish', version: post.version + 1,
        updatedAt: now.toISOString(), approval: { ...input, approvedBy: userId, approvedAt: now.toISOString() } };
      if (!await repository.saveSocialPublication(next, post.version)) return fail(409, 'POST_CHANGED', 'This post changed. Refresh the preview.');
      await queue.send([{ kind: 'social-publication', projectId: project.id, publicationId: post.id }]);
      return json(publicSocialPublication(next), 202);
    }
  }
  return fail(404, 'NOT_FOUND', 'Social endpoint not found.');
}
