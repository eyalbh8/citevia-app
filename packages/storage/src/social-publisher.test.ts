import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocialDestination } from '@citevia/core';
import { createSocialPublisher, socialPublisherConfigured, ZernioPublisher } from './social-publisher.js';

const profile = 'profile-one';
const destination: SocialDestination = { id: 'account-one', profileId: profile, channel: 'instagram', username: 'acme', active: true, requiresReconnect: false };
const account = (overrides: Record<string, unknown> = {}) => ({ _id: destination.id, platform: 'instagram', profileId: profile, isActive: true, username: 'acme', ...overrides });
const payload = { text: 'An answer to a saved prompt.', media: [{ type: 'image' as const, url: 'https://media.zernio.com/post.jpg' }] };
const reply = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers });
const fetchQueue = (...responses: (Response | Error)[]) => vi.fn<typeof fetch>().mockImplementation(async () => {
  const next = responses.shift();
  if (next instanceof Error) throw next;
  if (!next) throw new Error('Unexpected request');
  return next;
});
const postResponse = (status = 'published', overrides: Record<string, unknown> = {}) => ({ post: { _id: 'post-one', status, platforms: [{ accountId: destination.id, status, platformPostUrl: 'https://www.instagram.com/p/example/', ...overrides }] } });

afterEach(() => vi.unstubAllEnvs());

describe('Zernio tenant boundaries', () => {
  it('filters to supported accounts actually belonging to the requested profile and paginates', async () => {
    const request = fetchQueue(reply({ accounts: [account(), account({ _id: 'foreign', profileId: 'other' }), account({ _id: 'blog', platform: 'wordpress' })], pagination: { nextCursor: 'cursor-two' } }), reply({ accounts: [account({ _id: 'x-account', platform: 'twitter', profileId: { _id: profile }, metadata: { accessToken: 'secret', defaultBoardId: 'board' } })], pagination: { nextCursor: null } }));
    const result = await new ZernioPublisher('key', request).accounts(profile);
    expect(result.map(item => [item.id, item.channel])).toEqual([['account-one', 'instagram'], ['x-account', 'x']]);
    expect(result[1].options).toEqual({ boardId: 'board' });
    expect(String(request.mock.calls[1][0])).toContain('cursor=cursor-two');
    expect(String(request.mock.calls[0][0])).toContain('profileId=profile-one');
  });

  it('does not publish when a previously connected account belongs to another tenant now', async () => {
    const request = fetchQueue(reply({ accounts: [account({ profileId: 'other' })] }));
    await expect(new ZernioPublisher('key', request).publish(profile, destination, payload, 'stable-key')).rejects.toMatchObject({ code: 'social_destination_not_found' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('checks connections again on every publication and rejects a newly revoked connection', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply(postResponse()), reply({ accounts: [account({ needsReconnection: true })] }));
    const publisher = new ZernioPublisher('key', request);
    await publisher.publish(profile, destination, payload, 'first');
    await expect(publisher.publish(profile, destination, payload, 'second')).rejects.toMatchObject({ code: 'social_reconnection_required' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not expose a provider post that targets another account', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply(postResponse('published', { accountId: 'other-account' })));
    await expect(new ZernioPublisher('key', request).getPost(profile, destination.id, 'foreign-post')).rejects.toMatchObject({ code: 'social_publication_unconfirmed' });
  });

  it('validates destination ownership before querying reference posts', async () => {
    const request = fetchQueue(reply({ accounts: [] }));
    await expect(new ZernioPublisher('key', request).recentPosts(profile, 'foreign')).rejects.toMatchObject({ code: 'social_destination_not_found' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses brandbook fallback for LinkedIn personal profiles after checking ownership and connection', async () => {
    const request = fetchQueue(reply({ accounts: [account({ platform: 'linkedin', profileUrl: 'https://www.linkedin.com/in/acme-owner/' })] }));
    expect(await new ZernioPublisher('key', request).recentPosts(profile, destination.id)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('Zernio profiles and connection flow', () => {
  it('recovers a profile after a concurrent create conflict using the exact external tenant ID', async () => {
    const request = fetchQueue(reply({ profiles: [{ _id: 'foreign', externalId: 'other-project' }] }), reply({ code: 'profile_external_id_conflict' }, 409), reply({ profiles: [{ _id: profile, externalId: 'project-one' }] }));
    expect(await new ZernioPublisher('key', request).ensureProfile('project-one', 'Acme', 'UTC')).toBe(profile);
    const options = request.mock.calls[1][1]!;
    expect(JSON.parse(String(options.body))).toEqual({ name: 'Acme', timezone: 'UTC', externalId: 'project-one' });
    expect(new Headers(options.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('maps X to twitter and URL-encodes the return URL', async () => {
    const request = fetchQueue(reply({ authUrl: 'https://twitter.com/oauth/authorize?state=abc' }));
    await new ZernioPublisher('key', request).connectUrl(profile, 'x', 'https://app.citevia.io/?connected=x#settings');
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/connect/twitter');
    expect(url.searchParams.get('redirect_url')).toBe('https://app.citevia.io/?connected=x#settings');
  });
});

describe('Zernio media storage', () => {
  it('puts media bytes without forwarding the API credential and rejects redirects', async () => {
    const request = fetchQueue(reply({ uploadUrl: 'https://bucket.r2.cloudflarestorage.com/image?signature=private', publicUrl: 'https://media.zernio.com/image.png' }), new Response(null, { status: 200 }));
    expect(await new ZernioPublisher('secret-key', request).uploadMedia('image.png', new Uint8Array([1, 2]), 'image/png')).toEqual({ url: 'https://media.zernio.com/image.png' });
    const upload = request.mock.calls[1][1]!;
    expect(new Headers(upload.headers).has('Authorization')).toBe(false);
    expect(new Headers(upload.headers).get('Content-Type')).toBe('image/png');
    expect(upload.redirect).toBe('error');
    expect(upload.body).toEqual(Buffer.from([1, 2]));
  });

  it.each(['https://127.0.0.1/file', 'https://[::1]/file', 'https://169.254.169.254/file', 'https://storage.internal/file', 'http://bucket.r2.cloudflarestorage.com/file', 'https://bucket.r2.cloudflarestorage.com.evil.example/file', 'https://user:pass@bucket.r2.cloudflarestorage.com/file'])('rejects unsafe upload URL %s', async (url) => {
    const request = fetchQueue(reply({ uploadUrl: url, publicUrl: 'https://media.zernio.com/file.png' }));
    await expect(new ZernioPublisher('key', request).uploadMedia('file.png', new Uint8Array([1]), 'image/png')).rejects.toMatchObject({ name: 'SocialPublisherError' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('Zernio publication outcomes', () => {
  it('uses the same supplied idempotency key and platform-specific media/copy payload', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply(postResponse()));
    const result = await new ZernioPublisher('key', request).publish(profile, destination, { ...payload, platformSpecificData: { isAiGenerated: true } }, 'stable-logical-delivery');
    expect(result).toEqual({ providerPostId: 'post-one', status: 'published', url: 'https://www.instagram.com/p/example/' });
    const options = request.mock.calls[1][1]!;
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('stable-logical-delivery');
    expect(JSON.parse(String(options.body))).toMatchObject({ publishNow: true, content: payload.text, platforms: [{ platform: 'instagram', accountId: destination.id, platformSpecificData: { isAiGenerated: true } }] });
  });

  it('maps HTTP 207 according to the requested destination, not the overall status', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply(postResponse('failed', { error: 'Invalid image ratio' }), 207));
    expect(await new ZernioPublisher('key', request).publish(profile, destination, payload, 'key-one')).toMatchObject({ status: 'failed', error: 'Invalid image ratio' });
  });

  it.each(['pending', 'processing', 'uploading'])('keeps %s outcomes pending until confirmed', async (status) => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply(postResponse(status), 207));
    expect(await new ZernioPublisher('key', request).publish(profile, destination, payload, 'key-one')).toMatchObject({ status: 'publishing' });
  });

  it('marks a lost publication response uncertain and does not retry the mutation', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), new Error('network timeout'));
    await expect(new ZernioPublisher('key', request).publish(profile, destination, payload, 'key-one')).rejects.toMatchObject({ outcomeUnknown: true, retryable: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves rate-limit timing while redacting secrets in provider errors', async () => {
    const request = fetchQueue(reply({ accounts: [account()] }), reply({ code: 'rate_limited', error: 'Rejected key super-secret' }, 429, { 'Retry-After': '45' }));
    await expect(new ZernioPublisher('super-secret', request).publish(profile, destination, payload, 'key-one')).rejects.toMatchObject({ code: 'rate_limited', message: 'Rejected key [redacted]', retryAfterSeconds: 45, outcomeUnknown: false });
  });

  it.each(['reddit', 'pinterest'] as const)('requires an explicit %s destination before publishing', async (channel) => {
    const request = fetchQueue(reply({ accounts: [account({ platform: channel })] }));
    await expect(new ZernioPublisher('key', request).publish(profile, { ...destination, channel }, payload, 'key-one')).rejects.toMatchObject({ code: channel === 'reddit' ? 'social_subreddit_required' : 'social_board_required' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('TikTok approval and music', () => {
  const tiktok = { ...destination, channel: 'tiktok' as const };
  const creator = { creator: { canPostMore: true }, privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE' }], postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: { enabled: true }, allow_duet: { enabled: false }, allow_stitch: { enabled: false } } } };
  const approval = { previewConfirmed: true as const, expressConsentGiven: true as const, privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false };

  it('does not infer consent from generic platform options', async () => {
    const request = fetchQueue(reply({ accounts: [account({ platform: 'tiktok' })] }));
    await expect(new ZernioPublisher('key', request).publish(profile, tiktok, { ...payload, platformSpecificData: { contentPreviewConfirmed: true, expressConsentGiven: true } }, 'key-one')).rejects.toMatchObject({ code: 'social_tiktok_approval_required' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses reviewed choices and overrides conflicting snake-case provider options', async () => {
    const request = fetchQueue(reply({ accounts: [account({ platform: 'tiktok' })] }), reply(creator), reply(postResponse()));
    await new ZernioPublisher('key', request).publish(profile, tiktok, { ...payload, tiktokApproval: approval, platformSpecificData: { allow_duet: true, privacy_level: 'SELF_ONLY' } }, 'key-one');
    const settings = JSON.parse(String(request.mock.calls[2][1]?.body)).platforms[0].platformSpecificData;
    expect(settings).toMatchObject({ privacyLevel: 'PUBLIC_TO_EVERYONE', contentPreviewConfirmed: true, expressConsentGiven: true, allowDuet: false });
    expect(settings).not.toHaveProperty('privacy_level');
    expect(settings).not.toHaveProperty('allow_duet');
  });

  it('rejects interactions unavailable to the creator', async () => {
    const request = fetchQueue(reply({ accounts: [account({ platform: 'tiktok' })] }), reply(creator));
    await expect(new ZernioPublisher('key', request).publish(profile, tiktok, { ...payload, tiktokApproval: { ...approval, allowDuet: true } }, 'key-one')).rejects.toMatchObject({ code: 'social_tiktok_interaction_invalid' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns the publishable clip ID instead of the commercial music ID', async () => {
    const request = fetchQueue(reply({ accounts: [account({ platform: 'tiktok' })] }), reply({ tracks: [{ id: 'full-track', commercialMusicId: 'never-publish-this', name: 'Uplifting', artist: 'Artist', clip: { id: 'publishable-clip', durationSec: 15, previewUrl: 'https://music.example.com/clip.mp3' } }] }));
    expect(await new ZernioPublisher('key', request).tiktokMusic(profile, destination.id, 'us')).toEqual([{ id: 'publishable-clip', name: 'Uplifting', artist: 'Artist', durationSec: 15, previewUrl: 'https://music.example.com/clip.mp3' }]);
    expect(String(request.mock.calls[1][0])).toContain('countryCode=US');
  });
});

describe('Zernio configuration', () => {
  it('reports missing credentials without issuing requests', async () => {
    vi.stubEnv('ZERNIO_API_KEY', '');
    vi.stubEnv('ZERNIO_SECRET_ARN', '');
    expect(socialPublisherConfigured()).toBe(false);
    await expect(createSocialPublisher()).rejects.toMatchObject({ code: 'social_publisher_not_configured' });
  });
});
