import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SOCIAL_CHANNELS, type JsonValue, type SocialChannel, type SocialDestination } from '@citevia/core';

export interface SocialReferencePost {
  id: string;
  text: string;
  imageUrls: string[];
  publishedAt?: string;
}
export interface SocialPublishMedia {
  type: 'image' | 'video';
  url: string;
  altText?: string;
}
/** These values must come from a user reviewing this specific TikTok post. */
export interface TikTokPublishApproval {
  previewConfirmed: true;
  expressConsentGiven: true;
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
}
export interface SocialPublishPayload {
  text: string;
  title?: string;
  media: SocialPublishMedia[];
  platformSpecificData?: Record<string, JsonValue>;
  tiktokApproval?: TikTokPublishApproval;
}
export interface SocialPublishResult {
  providerPostId: string;
  status: 'publishing' | 'published' | 'failed';
  url?: string;
  error?: string;
}
export interface TikTokCreatorInfo {
  privacyLevels: string[];
  maxVideoDurationSec?: number;
  canPostMore: boolean;
  interactions: Record<'allowComment' | 'allowDuet' | 'allowStitch', boolean>;
}
export interface TikTokMusicTrack {
  id: string;
  name: string;
  artist: string;
  durationSec?: number;
  previewUrl?: string;
}
export interface PinterestBoard { id: string; name: string; description?: string }
export interface SocialPublisher {
  ensureProfile(projectId: string, name: string, timezone: string): Promise<string>;
  connectUrl(profileId: string, channel: SocialChannel, redirectUrl: string): Promise<string>;
  accounts(profileId: string): Promise<SocialDestination[]>;
  recentPosts(profileId: string, destinationId: string): Promise<SocialReferencePost[]>;
  uploadMedia(filename: string, bytes: Uint8Array, mime: string): Promise<{ url: string }>;
  publish(profileId: string, destination: SocialDestination, payload: SocialPublishPayload, idempotencyKey: string): Promise<SocialPublishResult>;
  getPost(profileId: string, destinationId: string, providerPostId: string): Promise<SocialPublishResult>;
  tiktokCreatorInfo(profileId: string, destinationId: string): Promise<TikTokCreatorInfo>;
  tiktokMusic(profileId: string, destinationId: string, countryCode?: string): Promise<TikTokMusicTrack[]>;
  pinterestBoards(profileId: string, destinationId: string): Promise<PinterestBoard[]>;
}

export class SocialPublisherError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public outcomeUnknown = false,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SocialPublisherError';
  }
}

export function socialPublisherConfigured(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY?.trim() || process.env.ZERNIO_SECRET_ARN?.trim());
}
export async function createSocialPublisher(): Promise<SocialPublisher> {
  let key = process.env.ZERNIO_API_KEY?.trim();
  if (!key && process.env.ZERNIO_SECRET_ARN?.trim()) {
    const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.ZERNIO_SECRET_ARN.trim() }));
    if (secret.SecretString) {
      try {
        const parsed: unknown = JSON.parse(secret.SecretString);
        key = typeof parsed === 'string' ? parsed.trim() : string(record(parsed).ZERNIO_API_KEY)?.trim();
      } catch {
        key = secret.SecretString.trim();
      }
    }
  }
  if (!key) throw new SocialPublisherError('social_publisher_not_configured', 'Configure ZERNIO_API_KEY or ZERNIO_SECRET_ARN before connecting social accounts.');
  return new ZernioPublisher(key, fetch, process.env.ZERNIO_API_BASE_URL?.trim());
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function objectId(value: unknown): string | undefined {
  return string(value) ?? string(record(value)._id) ?? string(record(value).id);
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function platform(channel: SocialChannel): string {
  if (!SOCIAL_CHANNELS.includes(channel)) throw new SocialPublisherError('social_channel_unsupported', 'This channel is not supported for social automation.');
  return channel === 'x' ? 'twitter' : channel;
}
function channel(value: unknown): SocialChannel | undefined {
  const normalized = value === 'twitter' ? 'x' : value;
  return SOCIAL_CHANNELS.includes(normalized as SocialChannel) ? normalized as SocialChannel : undefined;
}
function requiredId(value: string, name: string): string {
  if (!value.trim() || value.length > 255) throw new SocialPublisherError('social_invalid_id', `A valid ${name} is required.`);
  return value;
}

/** No IP literals, local names, credentials, non-HTTPS, or unexpected ports. */
function publicHttps(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SocialPublisherError('social_unsafe_url', 'A public HTTPS URL is required.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) ||
      ['localhost', 'local', 'internal', 'test', 'invalid', 'home', 'lan'].some((suffix) => host === suffix || host.endsWith('.' + suffix))) {
    throw new SocialPublisherError('social_unsafe_url', 'A public HTTPS URL is required.');
  }
  return url;
}
function maybePublicUrl(value: unknown): string | undefined {
  const candidate = string(value);
  if (!candidate) return undefined;
  try { return publicHttps(candidate).href; } catch { return undefined; }
}
function safeUploadUrl(value: unknown): string {
  const url = publicHttps(string(value) ?? '');
  // Presigned uploads are the only provider-supplied URLs this adapter fetches.
  // Restrict them to Zernio's documented Cloudflare R2 storage service.
  if (!url.hostname.endsWith('.r2.cloudflarestorage.com')) {
    throw new SocialPublisherError('social_unsafe_upload_url', 'The publisher returned an unsupported media upload host.');
  }
  return url.href;
}
function profileIdempotencyKey(projectId: string): string {
  const digest = createHash('sha256').update('citevia-social-profile:' + projectId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Zernio REST adapter. It does not retry mutations after an uncertain outcome. */
export class ZernioPublisher implements SocialPublisher {
  private readonly baseUrl: string;
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch, baseUrl = 'https://zernio.com/api') {
    if (!key.trim()) throw new SocialPublisherError('social_publisher_not_configured', 'Configure a social publisher API key.');
    const parsed = publicHttps(baseUrl);
    if (parsed.search || parsed.hash) throw new SocialPublisherError('social_unsafe_url', 'Publisher base URL cannot contain a query or fragment.');
    this.baseUrl = parsed.href.replace(/\/$/, '');
  }

  private async api(path: string, method = 'GET', body?: unknown, idempotencyKey?: string, publication = false): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await this.request(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(publication ? 90_000 : 30_000),
        redirect: 'error',
      });
    } catch {
      throw new SocialPublisherError('social_publisher_unreachable', publication ? 'The publisher did not confirm the outcome. Check the existing publication before retrying.' : 'The social publisher could not be reached.', true, publication);
    }
    let data: JsonRecord;
    try { data = record(await response.json()); } catch {
      throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher returned an unreadable response.', response.status >= 500, publication, response.status);
    }
    if (!response.ok) {
      const code = string(data.code) ?? 'social_publisher_error';
      const retryAfter = Number(response.headers.get('retry-after'));
      // A timeout/5xx can follow successful creation; never assume it is safe to create another post.
      const unknown = publication && (response.status >= 500 || response.status === 408 || code === 'idempotency_conflict');
      throw new SocialPublisherError(code, this.safeError(data.error ?? data.message) ?? `The social publisher rejected the request (${response.status}).`, response.status === 429 || response.status >= 500 || code === 'idempotency_conflict', unknown, response.status, retryAfter > 0 ? retryAfter : undefined);
    }
    return data;
  }

  private safeError(value: unknown): string | undefined {
    const text = string(value) ?? string(record(value).message);
    if (!text) return undefined;
    return text.split(this.key).join('[redacted]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 500);
  }

  async ensureProfile(projectId: string, name: string, timezone: string): Promise<string> {
    requiredId(projectId, 'project id');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new SocialPublisherError('social_invalid_timezone', 'Choose a valid publishing timezone.'); }
    const lookup = async () => {
      const response = await this.api('/v1/profiles?' + new URLSearchParams({ externalId: projectId }));
      return array(response.profiles).map(record).find((profile) => profile.externalId === projectId);
    };
    const existing = await lookup();
    const existingId = objectId(existing);
    if (existingId) return existingId;
    try {
      const response = await this.api('/v1/profiles', 'POST', { name, timezone, externalId: projectId }, profileIdempotencyKey(projectId));
      const created = record(response.profile);
      if (created.externalId !== undefined && created.externalId !== projectId) throw new SocialPublisherError('social_profile_mismatch', 'The publisher returned a different customer profile.');
      const id = objectId(created);
      if (!id) throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher did not return a profile ID.');
      return id;
    } catch (error) {
      // A concurrent signup, prior response loss, or a timed-out create can leave the profile already present.
      if (error instanceof SocialPublisherError && (error.status === 409 || error.retryable)) {
        const recovered = objectId(await lookup());
        if (recovered) return recovered;
      }
      throw error;
    }
  }

  async connectUrl(profileId: string, destinationChannel: SocialChannel, redirectUrl: string): Promise<string> {
    requiredId(profileId, 'profile id');
    publicHttps(redirectUrl);
    const response = await this.api(`/v1/connect/${platform(destinationChannel)}?` + new URLSearchParams({ profileId, redirect_url: redirectUrl, scopes: 'posting,analytics' }));
    const authUrl = string(response.authUrl);
    if (!authUrl) throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher did not return a connection URL.');
    return publicHttps(authUrl).href;
  }

  async accounts(profileId: string): Promise<SocialDestination[]> {
    requiredId(profileId, 'profile id');
    const result: SocialDestination[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ profileId, category: 'social', excludeHidden: 'true', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const response = await this.api('/v1/accounts?' + params);
      if (!Array.isArray(response.accounts)) throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher did not return connected accounts.');
      for (const value of response.accounts) {
        const account = record(value), id = objectId(account), accountChannel = channel(account.platform);
        // Check the response as well as the query: team keys otherwise span every tenant.
        if (!id || !accountChannel || objectId(account.profileId) !== profileId) continue;
        const metadata = record(account.metadata);
        const options: Record<string, JsonValue> = {};
        // Explicit allowlist: do not send credentials or arbitrary provider metadata to clients.
        for (const field of ['boardId', 'subreddit', 'subredditName', 'organizationId', 'accountType']) {
          const value = string(metadata[field]);
          if (value) options[field] = value;
        }
        if (!options.boardId && string(metadata.defaultBoardId)) options.boardId = string(metadata.defaultBoardId)!;
        if (!options.subreddit && string(metadata.defaultSubreddit)) options.subreddit = string(metadata.defaultSubreddit)!;
        if (accountChannel === 'linkedin' && !options.accountType) {
          const profileUrl = maybePublicUrl(account.profileUrl);
          if (profileUrl) {
            const url = new URL(profileUrl);
            if ((url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) && url.pathname.startsWith('/in/')) options.accountType = 'personal';
          }
        }
        result.push({ id, channel: accountChannel, profileId, username: string(account.username) ?? string(account.displayName) ?? id,
          active: account.isActive === true && account.enabled !== false, requiresReconnect: account.needsReconnection === true,
          ...(Object.keys(options).length ? { options } : {}) });
      }
      cursor = string(record(response.pagination).nextCursor);
      if (cursor && seen.has(cursor)) throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher returned a repeated account cursor.');
      if (cursor) seen.add(cursor);
      if (seen.size > 100) throw new SocialPublisherError('social_publisher_invalid_response', 'The publisher returned too many account pages.');
    } while (cursor);
    return result;
  }

  private async ownedAccount(profileId: string, destinationId: string, connected = true): Promise<SocialDestination> {
    requiredId(destinationId, 'destination id');
    const account = (await this.accounts(profileId)).find((item) => item.id === destinationId);
    if (!account) throw new SocialPublisherError('social_destination_not_found', 'This social destination does not belong to this project.', false, false, 404);
    if (connected && (!account.active || account.requiresReconnect)) throw new SocialPublisherError('social_reconnection_required', 'Reconnect this social account before publishing.', false, false, 409);
    return account;
  }

  async recentPosts(profileId: string, destinationId: string): Promise<SocialReferencePost[]> {
    const destination = await this.ownedAccount(profileId, destinationId);
    // LinkedIn does not expose a personal feed or its captions/media. An explicit
    // empty reference set lets the generator use the verified brandbook instead.
    if (destination.channel === 'linkedin' && destination.options?.accountType === 'personal') return [];
    const response = await this.api('/v1/posts/sync-external', 'POST', { accountId: destinationId });
    return array(response.posts).slice(0, 20).flatMap((value) => {
      const post = record(value), id = string(post.platformPostId) ?? objectId(post);
      if (!id) return [];
      const urls = array(post.mediaItems).map(record).filter((item) => String(item.type ?? item.mediaType).toLowerCase() !== 'video')
        .map((item) => maybePublicUrl(item.url ?? item.mediaUrl)).filter((url): url is string => Boolean(url));
      const thumbnail = maybePublicUrl(post.thumbnailUrl);
      if (thumbnail && !urls.includes(thumbnail)) urls.push(thumbnail);
      return [{ id, text: string(post.content) ?? '', imageUrls: urls.slice(0, 10), ...(string(post.publishedAt) ? { publishedAt: string(post.publishedAt) } : {}) }];
    });
  }

  async uploadMedia(filename: string, bytes: Uint8Array, mime: string): Promise<{ url: string }> {
    if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(mime) || bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 ** 3) {
      throw new SocialPublisherError('social_invalid_media', 'Upload a non-empty JPEG, PNG, WebP, or MP4 within the publisher size limit.');
    }
    const response = await this.api('/v1/media/presign', 'POST', { filename, contentType: mime, size: bytes.byteLength });
    const uploadUrl = safeUploadUrl(response.uploadUrl);
    const publicUrl = publicHttps(string(response.publicUrl) ?? '').href;
    let uploaded: Response;
    try {
      uploaded = await this.request(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: Buffer.from(bytes), signal: AbortSignal.timeout(90_000), redirect: 'error' });
    } catch { throw new SocialPublisherError('social_upload_failed', 'The generated media could not be uploaded.', true); }
    if (!uploaded.ok) throw new SocialPublisherError('social_upload_failed', `The generated media upload failed (${uploaded.status}).`, uploaded.status >= 500, false, uploaded.status);
    return { url: publicUrl };
  }

  async publish(profileId: string, destination: SocialDestination, payload: SocialPublishPayload, idempotencyKey: string): Promise<SocialPublishResult> {
    requiredId(idempotencyKey, 'publication idempotency key');
    if (destination.profileId !== profileId) throw new SocialPublisherError('social_destination_not_found', 'This social destination does not belong to this project.', false, false, 404);
    const current = await this.ownedAccount(profileId, destination.id);
    if (current.channel !== destination.channel) throw new SocialPublisherError('social_destination_mismatch', 'The social destination has changed. Refresh its connection.');
    if (!payload.text.trim() && !payload.media.length) throw new SocialPublisherError('social_empty_post', 'The social post needs text or media.');
    for (const item of payload.media) {
      if (!['image', 'video'].includes(item.type)) throw new SocialPublisherError('social_invalid_media', 'Unsupported social media type.');
      publicHttps(item.url);
    }
    const settings: Record<string, JsonValue> = { ...payload.platformSpecificData };
    if (payload.title && ['pinterest', 'reddit'].includes(current.channel)) settings.title = payload.title;
    if (current.channel === 'pinterest' && !settings.boardId && current.options?.boardId) settings.boardId = current.options.boardId;
    if (current.channel === 'reddit' && !settings.subreddit && current.options?.subreddit) settings.subreddit = current.options.subreddit;
    if (current.channel === 'reddit' && (!string(settings.subreddit) || !/^[a-zA-Z0-9_]{2,30}$/.test(String(settings.subreddit)))) throw new SocialPublisherError('social_subreddit_required', 'Choose a subreddit name without the r/ prefix before publishing to Reddit.');
    if (current.channel === 'pinterest' && !string(settings.boardId)) throw new SocialPublisherError('social_board_required', 'Choose a Pinterest board before publishing.');
    if (current.channel === 'tiktok') {
      const approval = payload.tiktokApproval;
      if (!approval || approval.previewConfirmed !== true || approval.expressConsentGiven !== true ||
          !approval.privacyLevel || ['allowComment', 'allowDuet', 'allowStitch'].some((field) => typeof approval[field as keyof TikTokPublishApproval] !== 'boolean')) {
        throw new SocialPublisherError('social_tiktok_approval_required', 'Review this TikTok post and confirm its privacy and interaction choices before publishing.');
      }
      const info = await this.creatorInfo(current);
      if (!info.canPostMore) throw new SocialPublisherError('social_tiktok_posting_limit', 'TikTok cannot accept another post for this account right now.');
      if (!info.privacyLevels.includes(approval.privacyLevel)) throw new SocialPublisherError('social_tiktok_privacy_invalid', 'Choose a privacy level supported by this TikTok account.');
      for (const field of ['allowComment', 'allowDuet', 'allowStitch'] as const) {
        if (approval[field] && !info.interactions[field]) throw new SocialPublisherError('social_tiktok_interaction_invalid', 'This TikTok account does not allow the selected interactions.');
      }
      // Translate only supplied, verified approval. platformSpecificData cannot bypass it.
      for (const field of ['privacy_level', 'allow_comment', 'allow_duet', 'allow_stitch', 'content_preview_confirmed', 'express_consent_given']) delete settings[field];
      Object.assign(settings, { privacyLevel: approval.privacyLevel, allowComment: approval.allowComment, allowDuet: approval.allowDuet, allowStitch: approval.allowStitch, contentPreviewConfirmed: true, expressConsentGiven: true });
    }
    const response = await this.api('/v1/posts', 'POST', {
      content: payload.text, mediaItems: payload.media,
      platforms: [{ platform: platform(current.channel), accountId: current.id, ...(Object.keys(settings).length ? { platformSpecificData: settings } : {}) }],
      publishNow: true,
    }, idempotencyKey, true);
    return this.publication(response, current.id);
  }

  async getPost(profileId: string, destinationId: string, providerPostId: string): Promise<SocialPublishResult> {
    await this.ownedAccount(profileId, destinationId, false);
    requiredId(providerPostId, 'provider post id');
    const response = await this.api('/v1/posts/' + encodeURIComponent(providerPostId));
    return this.publication(response, destinationId);
  }

  private publication(response: JsonRecord, destinationId: string): SocialPublishResult {
    const post = record(response.post);
    const providerPostId = objectId(post);
    const target = array(post.platforms).map(record).find((item) => objectId(item.accountId) === destinationId);
    if (!providerPostId || !target) throw new SocialPublisherError('social_publication_unconfirmed', 'The publisher did not confirm this destination. Reconcile the existing publication before retrying.', false, true);
    const status = target.status === 'published' ? 'published' : ['failed', 'cancelled', 'skipped'].includes(String(target.status)) ? 'failed' : 'publishing';
    const url = maybePublicUrl(target.platformPostUrl);
    const error = this.safeError(target.error ?? target.errorMessage);
    return { providerPostId, status, ...(url ? { url } : {}), ...(error ? { error } : {}) };
  }

  private async creatorInfo(destination: SocialDestination): Promise<TikTokCreatorInfo> {
    const response = await this.api(`/v1/accounts/${encodeURIComponent(destination.id)}/tiktok/creator-info?mediaType=video`);
    const limits = record(response.postingLimits), interactions = record(limits.interactionSettings);
    return {
      privacyLevels: array(response.privacyLevels).map((item) => string(record(item).value)).filter((value): value is string => Boolean(value)),
      canPostMore: record(response.creator).canPostMore === true,
      ...(typeof limits.maxVideoDurationSec === 'number' ? { maxVideoDurationSec: limits.maxVideoDurationSec } : {}),
      interactions: { allowComment: record(interactions.allow_comment).enabled === true, allowDuet: record(interactions.allow_duet).enabled === true, allowStitch: record(interactions.allow_stitch).enabled === true },
    };
  }
  async tiktokCreatorInfo(profileId: string, destinationId: string): Promise<TikTokCreatorInfo> {
    const destination = await this.ownedAccount(profileId, destinationId);
    if (destination.channel !== 'tiktok') throw new SocialPublisherError('social_destination_mismatch', 'Choose a connected TikTok account.');
    return this.creatorInfo(destination);
  }
  async tiktokMusic(profileId: string, destinationId: string, countryCode?: string): Promise<TikTokMusicTrack[]> {
    const destination = await this.ownedAccount(profileId, destinationId);
    if (destination.channel !== 'tiktok') throw new SocialPublisherError('social_destination_mismatch', 'Choose a connected TikTok account.');
    if (countryCode && !/^[a-z]{2}$/i.test(countryCode)) throw new SocialPublisherError('social_invalid_country', 'Use a two-letter country code for TikTok music.');
    const query = countryCode ? '?' + new URLSearchParams({ countryCode: countryCode.toUpperCase() }) : '';
    const response = await this.api(`/v1/accounts/${encodeURIComponent(destinationId)}/tiktok/commercial-music${query}`);
    return array(response.tracks).flatMap((value) => {
      const track = record(value), clip = record(track.clip), id = string(clip.id) ?? string(track.id);
      if (!id) return [];
      const duration = clip.durationSec ?? track.durationSec, previewUrl = maybePublicUrl(clip.previewUrl ?? track.previewUrl);
      return [{ id, name: string(track.name) ?? '', artist: string(track.artist) ?? '', ...(typeof duration === 'number' ? { durationSec: duration } : {}), ...(previewUrl ? { previewUrl } : {}) }];
    });
  }
  async pinterestBoards(profileId: string, destinationId: string): Promise<PinterestBoard[]> {
    const destination = await this.ownedAccount(profileId, destinationId);
    if (destination.channel !== 'pinterest') throw new SocialPublisherError('social_destination_mismatch', 'Choose a connected Pinterest account.');
    const response = await this.api(`/v1/accounts/${encodeURIComponent(destinationId)}/pinterest-boards`);
    return array(response.boards).flatMap((value) => {
      const board = record(value), id = string(board.id), name = string(board.name);
      return id && name ? [{ id, name, ...(string(board.description) ? { description: string(board.description) } : {}) }] : [];
    });
  }
}
