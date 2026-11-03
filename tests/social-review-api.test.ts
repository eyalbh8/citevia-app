import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SOCIAL_CHANNELS, socialApprovalSnapshot, type SocialChannel, type SocialDestination, type SocialPublication } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, type SocialMediaUploadStore, type SocialPublisher, type SocialUploadedMedia } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = '2026-11-02T10:00:00.000Z';
const scheduledAt = '2026-11-30T15:00:00.000Z';
const consent = { version: 2, previewConfirmed: true, expressConsentGiven: true };
const tiktokChoices = { privacyLevel: 'PUBLIC_TO_EVERYONE', musicSoundId: 'music-one', allowComment: true, allowDuet: false, allowStitch: false };

async function fixture(channel: SocialChannel = 'facebook', override: Partial<SocialPublication> = {}) {
  const repository = new MemoryRepository(), queue = new MemoryQueue(), artifacts = new MemoryArtifacts();
  for (const id of ['review-owner', 'review-viewer', 'review-outsider']) await repository.syncUser(testIdentity(id));
  const project = newProject({ id: 'review-project', prompts: ['How can a small business measure useful results?'], now: new Date(now) });
  project.socialProfileId = 'private-profile';
  project.socialAutomation = { enabled: true, createBlogDrafts: false, revision: 1, timezone: 'UTC', generationCadence: 'monthly', generationTime: '08:00',
    effectiveFrom: '2026-11-01T00:00:00.000Z', scheduleStatus: 'synced', slots: [{ id: 'monday', dayOfWeek: 1, time: '10:00' }] };
  await repository.saveProject(project, null);
  for (const [userId, role] of [['review-owner', 'owner'], ['review-viewer', 'viewer']] as const)
    await repository.putMembership({ projectId: project.id, userId, role });
  const otherProject = newProject({ id: 'other-review-project', now: new Date(now) });
  await repository.saveProject(otherProject, null);
  await repository.putMembership({ projectId: otherProject.id, userId: 'review-owner', role: 'owner' });
  const destination: SocialDestination = { id: 'connected-account', profileId: project.socialProfileId, channel, username: 'Business account', active: true, requiresReconnect: false };
  const source: SocialUploadedMedia = { id: 'asset-one', key: `projects/${project.id}/social/private/image`, versionId: 'immutable-version',
    type: channel === 'tiktok' ? 'video' : 'image', mimeType: channel === 'tiktok' ? 'video/mp4' : 'image/jpeg', size: 2048,
    url: 'https://private-bucket.example/canonical?versionId=immutable-version' };
  const reserved = await repository.reserveSocialOccurrence({ projectId: project.id, revision: 1, slotId: 'monday', scheduledAt: now, now, destinations: [destination] });
  if (reserved.status !== 'created') throw new Error('Missing review fixture occurrence');
  const post: SocialPublication = { ...reserved.publications[0], status: 'review_required', stage: 'publish', version: 2, scheduledAt,
    content: { title: 'Measure useful results', body: 'Start with one question and compare results against a clear baseline.', hashtags: ['#UsefulResults'] },
    media: [{ id: source.id, type: source.type, url: source.url, mimeType: source.mimeType }],
    checkpoints: { privateGenerationState: 'must-not-leak', mediaSources: { [source.id]: source } }, ...override };
  await repository.saveSocialPublication(post, 1);
  const publisher = {
    accounts: vi.fn(async () => [destination]), ensureProfile: vi.fn(), connectUrl: vi.fn(), pinterestBoards: vi.fn(),
    publish: vi.fn(), getPost: vi.fn(), recentPosts: vi.fn(), uploadMedia: vi.fn(),
    tiktokCreatorInfo: vi.fn(async () => ({ privacyLevels: ['PUBLIC_TO_EVERYONE'], canPostMore: true,
      interactions: { allowComment: true, allowDuet: false, allowStitch: true } })),
    tiktokMusic: vi.fn(async () => [{ id: 'music-one', name: 'Business music', artist: 'Composer' }]),
  } satisfies SocialPublisher;
  const uploads = {
    start: vi.fn(async () => ({ url: 'https://private-bucket.example/', fields: { policy: 'signed-upload-policy', key: 'scoped-upload-key' } })),
    complete: vi.fn(async (key: string, mimeType: string, size: number, id: string): Promise<SocialUploadedMedia> => ({
      id, key, mimeType, size, type: mimeType === 'video/mp4' ? 'video' : 'image', versionId: 'new-immutable-version',
      url: `https://private-bucket.example/${key}?versionId=new-immutable-version`,
    })),
    preview: vi.fn(async (value: SocialUploadedMedia) => `https://private-bucket.example/preview/${value.id}?signature=refreshed`),
    read: vi.fn(), put: vi.fn(),
  } satisfies SocialMediaUploadStore;
  const api = createApi({ repository, queue, artifacts }, { mode: 'live', now: () => new Date(now), social: {
    publisher: async () => publisher, uploads: () => uploads, generationAvailable: true, blogAvailable: true,
    frontendOrigin: 'https://app.citevia.io', sync: async () => {},
  } });
  const call = (suffix = '', method = 'GET', input?: unknown, user = 'review-owner', projectId = project.id) => api(new Request(
    `https://api.citevia.io/v1/projects/${projectId}/social/publications/${post.id}${suffix}`, {
      method, ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }),
    }), testIdentity(user));
  const current = () => repository.getSocialPublication(project.id, post.id);
  return { project, otherProject, post, source, destination, repository, queue, artifacts, publisher, uploads, call, current };
}

describe('social publication approval and editing API', () => {
  it('retains canonical Unsplash attribution when owners edit the post', async () => {
    const photo = { url: 'https://images.unsplash.com/photo-test?ixid=retained', alt: 'A team reviewing results', photoId: 'photo-test',
      photographer: 'Photo Author', photographerUrl: 'https://unsplash.com/@author', photoUrl: 'https://unsplash.com/photos/photo-test', downloadLocation: 'https://api.unsplash.com/photos/photo-test/download' };
    const media = [{ type: 'image' as const, url: photo.url, mimeType: 'image/jpeg', attribution: [photo] }];
    const f = await fixture('facebook', { media });
    expect((await (await f.call()).json()).media).toEqual(media);
    const response = await f.call('', 'PATCH', { version: 2, content: { ...f.post.content, body: 'Compare results to a useful baseline.' },
      media: [{ ...media[0], attribution: [{ ...photo, photographer: 'Forged credit' }] }] });
    expect(response.status).toBe(200);
    expect((await response.json()).media).toEqual(media);
    expect((await f.current())?.media).toEqual(media);
  });
  it.each(SOCIAL_CHANNELS)('schedules approved %s content without publishing ahead of time', async channel => {
    const f = await fixture(channel);
    const response = await f.call('/approve', 'POST', { ...consent, ...(channel === 'tiktok' ? tiktokChoices : {}) });
    expect(response.status).toBe(202);
    const preview = await response.json(), stored = await f.current();
    expect(preview).toMatchObject({ status: 'scheduled', scheduledAt, version: 3, editable: true });
    expect(stored).toMatchObject({ status: 'scheduled', nextAttemptAt: scheduledAt, stage: 'publish', approval: {
      approvedBy: 'review-owner', approvedAt: now, previewConfirmed: true, expressConsentGiven: true,
      contentHash: createHash('sha256').update(socialApprovalSnapshot(f.post)).digest('hex'),
    } });
    expect(f.queue.messages).toEqual([{ kind: 'social-publication', projectId: f.project.id, publicationId: f.post.id }]);
    expect(f.queue.delays).toEqual([900]);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('allows viewers to preview, but protects every mutation and tenant lookup', async () => {
    const f = await fixture();
    expect(await (await f.call('', 'GET', undefined, 'review-viewer')).json()).toMatchObject({ editable: false });
    const mutations = [
      ['', 'PATCH', { version: 2, content: f.post.content }],
      ['/approve', 'POST', consent],
      ['/media/start', 'POST', { version: 2, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 2048 }],
      ['/media/complete', 'POST', { version: 2, uploadId: randomUUID() }],
    ] as const;
    for (const [suffix, method, input] of mutations) expect((await f.call(suffix, method, input, 'review-viewer')).status).toBe(403);
    expect((await f.call('', 'GET', undefined, 'review-outsider')).status).toBe(404);
    expect((await f.call('', 'GET', undefined, 'review-owner', f.otherProject.id)).status).toBe(404);
    expect(f.queue.messages).toEqual([]); expect(f.uploads.start).not.toHaveBeenCalled();
  });
  it('removes approval and due-work scheduling after an approved post is edited', async () => {
    const f = await fixture(); await f.call('/approve', 'POST', consent);
    const revisedContent = { ...f.post.content!, body: 'A reviewed revision that answers the customer’s question.', hashtags: ['#Reviewed'] };
    const changedTime = '2026-12-01T11:00:00.000Z';
    const response = await f.call('', 'PATCH', { version: 3, content: revisedContent, scheduledAt: changedTime });
    expect(response.status).toBe(200);
    const stored = await f.current();
    expect(stored).toMatchObject({ content: revisedContent, scheduledAt: changedTime, status: 'review_required', version: 4 });
    expect(stored?.approval).toBeUndefined(); expect(stored?.nextAttemptAt).toBeUndefined();
    expect((await f.call('/approve', 'POST', { ...consent, version: 3 })).status).toBe(409);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it.each([
    { leaseUntil: '2026-11-02T10:05:00.000Z', leaseOwner: 'worker' },
    { publishAttemptAt: '2026-11-02T09:59:00.000Z' },
    { providerPostId: 'upstream-post' },
  ])('rejects editing, uploading and approval while publication is in flight: %j', async override => {
    const f = await fixture('facebook', override);
    expect((await f.call('', 'PATCH', { version: 2, content: f.post.content })).status).toBe(409);
    expect((await f.call('/approve', 'POST', consent)).status).toBe(409);
    expect((await f.call('/media/start', 'POST', { version: 2, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 2048 })).status).toBe(409);
    expect(f.uploads.start).not.toHaveBeenCalled(); expect(f.queue.messages).toEqual([]);
  });
  it('denies stale versions without changing saved content or sending work', async () => {
    const f = await fixture();
    expect((await f.call('', 'PATCH', { version: 1, content: f.post.content })).status).toBe(409);
    expect((await f.call('/approve', 'POST', { ...consent, version: 1 })).status).toBe(409);
    expect((await f.current())?.version).toBe(2); expect(f.queue.messages).toEqual([]);
  });
  it('requires explicit consent, future timing, a connection and valid channel choices', async () => {
    const f = await fixture('tiktok');
    expect((await f.call('/approve', 'POST', { ...consent, expressConsentGiven: false, ...tiktokChoices })).status).toBe(400);
    expect((await f.call('/approve', 'POST', consent)).status).toBe(400);
    expect((await f.call('/approve', 'POST', { ...consent, ...tiktokChoices, allowDuet: true })).status).toBe(400);
    f.publisher.accounts.mockResolvedValue([]);
    expect((await f.call('/approve', 'POST', { ...consent, ...tiktokChoices })).status).toBe(409);
    const expired = await fixture('facebook', { scheduledAt: now });
    expect((await expired.call('/approve', 'POST', consent)).status).toBe(400);
    expect(expired.queue.messages).toEqual([]); expect(f.queue.messages).toEqual([]);
  });
  it('accepts refreshed preview URLs by owned asset ID while retaining immutable canonical media', async () => {
    const f = await fixture();
    const publicPost = await (await f.call()).json();
    expect(publicPost.media[0].url).toContain('signature=refreshed');
    expect((await f.call('', 'PATCH', { version: 2, content: f.post.content, media: publicPost.media })).status).toBe(200);
    expect((await f.current())?.media).toEqual(f.post.media);
    const forged = await fixture();
    expect((await forged.call('', 'PATCH', { version: 2, content: forged.post.content, media: [{ ...forged.post.media![0], id: 'another-project-asset', url: 'https://evil.example/image.jpg' }] })).status).toBe(400);
    expect((await forged.call('', 'PATCH', { version: 2, content: forged.post.content, media: [{ type: 'image', url: 'https://evil.example/image.jpg', mimeType: 'image/jpeg' }] })).status).toBe(400);
  });
  it('exposes refreshed previews without internal sources, approvals or checkpoints', async () => {
    const f = await fixture();
    const data = await (await f.call()).json();
    expect(data).toMatchObject({ editable: true, media: [{ id: 'asset-one', url: 'https://private-bucket.example/preview/asset-one?signature=refreshed' }] });
    for (const key of ['checkpoints', 'approval', 'context', 'receiptKeys', 'destination']) expect(data).not.toHaveProperty(key === 'destination' ? 'destination.profileId' : key);
    expect(JSON.stringify(data)).not.toContain('must-not-leak'); expect(JSON.stringify(data)).not.toContain('immutable-version');
    expect(f.uploads.preview).toHaveBeenCalledWith(f.source);
  });
});

describe('private social media upload API', () => {
  it.each([
    ['facebook', 'image/jpeg', 10 * 1024 ** 2],
    ['instagram', 'image/png', 1024],
    ['linkedin', 'image/webp', 2048],
    ['tiktok', 'video/mp4', 100 * 1024 ** 2],
  ] as const)('accepts bounded %s uploads and replaces only the requested post media', async (channel, mimeType, size) => {
    const f = await fixture(channel);
    const start = await f.call('/media/start', 'POST', { version: 2, filename: 'business-content', mimeType, size, replaceIndex: 0 });
    expect(start.status).toBe(200);
    const started = await start.json(); expect(started).toMatchObject({ uploadId: expect.any(String), url: 'https://private-bucket.example/' });
    const key = `projects/${f.project.id}/social/${f.post.id}/uploads/${started.uploadId}`;
    expect(f.uploads.start).toHaveBeenCalledWith(key, mimeType, size);
    expect(await f.artifacts.get(key + '.json')).toMatchObject({ projectId: f.project.id, publicationId: f.post.id, version: 2, key, mimeType, size, replaceIndex: 0 });
    const completed = await f.call('/media/complete', 'POST', { version: 2, uploadId: started.uploadId });
    expect(completed.status).toBe(200);
    const stored = await f.current();
    expect(stored).toMatchObject({ status: 'review_required', version: 3, media: [{ id: started.uploadId, mimeType }] });
    expect(stored?.media).toHaveLength(1); expect(stored?.approval).toBeUndefined();
    expect(stored?.checkpoints?.mediaSources).toHaveProperty(started.uploadId);
    expect(JSON.stringify(await completed.json())).not.toContain('new-immutable-version');
    expect(f.publisher.uploadMedia).not.toHaveBeenCalled(); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it.each([
    ['image/svg+xml', 1024], ['image/jpeg', 10 * 1024 ** 2 + 1], ['video/mp4', 100 * 1024 ** 2 + 1], ['image/png', 11],
  ])('rejects invalid MIME or size %s / %s before creating an upload', async (mimeType, size) => {
    const f = await fixture(mimeType === 'video/mp4' ? 'tiktok' : 'facebook');
    const response = await f.call('/media/start', 'POST', { version: 2, filename: 'upload', mimeType, size });
    expect(response.status).toBe(400);
    expect(f.uploads.start).not.toHaveBeenCalled(); expect(f.artifacts.values.size).toBe(0);
  });
  it('rejects the wrong media type, invalid carousel positions, and stale upload versions', async () => {
    const f = await fixture();
    const input = { version: 2, filename: 'upload', mimeType: 'image/jpeg', size: 1024 };
    expect((await f.call('/media/start', 'POST', { ...input, mimeType: 'video/mp4' })).status).toBe(400);
    expect((await f.call('/media/start', 'POST', { ...input, replaceIndex: 4 })).status).toBe(400);
    expect((await f.call('/media/start', 'POST', { ...input, version: 1 })).status).toBe(409);
    expect(f.uploads.start).not.toHaveBeenCalled();
  });
  it.each(['wrong-project', 'wrong-publication', 'wrong-version', 'expired', 'missing'] as const)('rejects %s upload intents without reading uploaded objects', async reason => {
    const f = await fixture(); const uploadId = randomUUID();
    const key = `projects/${f.project.id}/social/${f.post.id}/uploads/${uploadId}`;
    if (reason !== 'missing') await f.artifacts.put(key + '.json', {
      id: uploadId, key, projectId: reason === 'wrong-project' ? f.otherProject.id : f.project.id,
      publicationId: reason === 'wrong-publication' ? 'other-publication' : f.post.id,
      version: reason === 'wrong-version' ? 1 : 2, mimeType: 'image/jpeg', size: 1024,
      expiresAt: reason === 'expired' ? now : '2026-11-02T11:00:00Z',
    });
    expect((await f.call('/media/complete', 'POST', { version: 2, uploadId })).status).toBe(409);
    expect(f.uploads.complete).not.toHaveBeenCalled(); expect((await f.current())?.version).toBe(2);
  });
  it('invalidates an outstanding upload when the post is edited and prevents replay after completion', async () => {
    const f = await fixture();
    const started = await (await f.call('/media/start', 'POST', { version: 2, filename: 'image.jpg', mimeType: 'image/jpeg', size: 1024 })).json();
    await f.call('', 'PATCH', { version: 2, content: { ...f.post.content!, body: 'Changed while the upload was in progress.' } });
    expect((await f.call('/media/complete', 'POST', { version: 3, uploadId: started.uploadId })).status).toBe(409);
    expect(f.uploads.complete).not.toHaveBeenCalled();
    const g = await fixture();
    const upload = await (await g.call('/media/start', 'POST', { version: 2, filename: 'image.jpg', mimeType: 'image/jpeg', size: 1024 })).json();
    expect((await g.call('/media/complete', 'POST', { version: 2, uploadId: upload.uploadId })).status).toBe(200);
    expect((await g.call('/media/complete', 'POST', { version: 3, uploadId: upload.uploadId })).status).toBe(409);
    expect(g.uploads.complete).toHaveBeenCalledOnce();
  });
});
