import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SharedSocialReview, SocialDestination, SocialPublication } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, type SocialPublisher, type SocialMediaUploadStore } from '@citevia/storage';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { AuthenticationError } from '../apps/api/src/descope.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const monday = '2026-11-02T10:00:00.000Z';
const future = '2026-11-06T12:00:00.000Z';
const consent = { previewConfirmed: true, expressConsentGiven: true };

async function setup(uploads?: SocialMediaUploadStore, branded = false) {
  const repository = new MemoryRepository(), queue = new MemoryQueue();
  const project = newProject({ id: 'shared-project', now: new Date(monday), prompts: ['Which beans should I choose?'] });
  project.socialProfileId = 'private-profile';
  project.socialAutomation = { enabled: true, createBlogDrafts: false, revision: 1, timezone: 'UTC',
    shareFacebookInstagramContent: true, generationTime: '08:00', generationCadence: 'weekly',
    effectiveFrom: '2026-11-01T00:00:00Z', scheduleStatus: 'synced', slots: [{ id: 'mon', dayOfWeek: 1, time: '10:00' }] };
  if (branded) project.socialAutomation.brands = [{ id: 'hot', name: 'Hot Coffee', description: 'Espresso beans',
    facebookDestinationId: 'account-facebook', instagramDestinationId: 'account-instagram',
    shareFacebookInstagramContent: true, slots: project.socialAutomation.slots }];
  await repository.saveProject(project, null);
  for (const role of ['viewer', 'owner'] as const) {
    await repository.syncUser(testIdentity(role));
    await repository.putMembership({ projectId: project.id, userId: role, role });
  }
  const accounts: SocialDestination[] = (['facebook', 'instagram', 'linkedin'] as const).map(channel => ({
    id: 'account-' + channel, username: 'Hot Coffee ' + channel, channel, profileId: 'private-profile', active: true, requiresReconnect: false,
  }));
  const reservation = await repository.reserveSocialOccurrence({ projectId: project.id, revision: 1, slotId: 'mon',
    scheduledAt: monday, now: monday, destinations: accounts, ...(branded ? { brandId: 'hot' } : {}) });
  if (reservation.status !== 'created') throw new Error('Missing reservation');
  const posts = await Promise.all(reservation.publications.map(async (item, i) => {
    const post: SocialPublication = { ...item, version: 2, status: 'review_required', stage: 'publish', scheduledAt: future,
      content: { title: 'Beans for espresso', body: 'Start with freshly roasted coffee beans.', hashtags: ['#Espresso'] },
      media: [{ type: 'image', id: 'media-' + i, url: 'https://media.example/' + i, mimeType: 'image/jpeg', contentDigest: '1'.repeat(64) }],
      checkpoints: { privateData: 'PRIVATE-GENERATION-STATE' } };
    await repository.saveSocialPublication(post, 1);
    return post;
  }));
  const social = posts.filter(post => post.destination.channel !== 'linkedin');
  const publisher = { accounts: vi.fn(async () => accounts), publish: vi.fn() };
  const clock = { now: new Date(monday) };
  const authenticate = vi.fn(async (request: Request) => {
    const user = request.headers.get('authorization')?.split(' ')[1];
    if (user !== 'owner' && user !== 'viewer') throw new AuthenticationError(401, 'INVALID_SESSION', 'Sign in.');
    return testIdentity(user);
  });
  const api = createAuthenticatedApi({ repository, queue, artifacts: new MemoryArtifacts() }, { authenticate, lookup: vi.fn() }, {
    mode: 'live', now: () => clock.now, mcp: { publicUrl: 'https://api.test', frontendUrl: 'https://app.test' },
    social: { publisher: async () => publisher as unknown as SocialPublisher, uploads: () => uploads, frontendOrigin: 'https://app.test' },
  });
  const call = (path: string, token: string, method = 'GET', body?: unknown) => api(new Request('https://api.test/v1/' + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const ownerPath = 'projects/shared-project/social/review-links', reviewPath = 'social-reviews/shared-project';
  const select = (items: SocialPublication[]) => ({ publications: items.map(({ id, version }) => ({ id, version })) });
  const issue = async (items = social) => {
    const response = await call(ownerPath, 'owner', 'POST', select(items));
    expect(response.status).toBe(201);
    const { url, id } = await response.json();
    expect(new URL(url).origin).toBe('https://app.test');
    const token = new URL(url).hash.split('/')[2];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    return { token, id };
  };
  const read = async (token: string): Promise<SharedSocialReview> => (await call(reviewPath, token)).json();
  const approve = (token: string, post: SocialPublication, extra = {}) => call(reviewPath + '/approve', token, 'POST',
    { id: post.id, version: post.version, ...consent, ...extra });
  return { repository, queue, posts, social, project, accounts, clock, authenticate, publisher, call, ownerPath, reviewPath, select, issue, read, approve };
}

describe('scoped client social review through the deployed HTTP handler', () => {
  it('keeps superseded brand drafts out of client approval when a recurring plan changes', async () => {
    const f = await setup(undefined, true);
    const { token } = await f.issue();
    await f.repository.saveProject({ ...f.project, version: f.project.version + 1,
      socialAutomation: { ...f.project.socialAutomation!, revision: 2 } }, f.project.version);
    const pending = await (await f.call('projects/shared-project/social/publications?clientReview=true', 'owner')).json();
    expect(pending.items).toHaveLength(2);
    expect(pending.items.every((p: { shareable: boolean; previousPlan: boolean }) => p.previousPlan && !p.shareable)).toBe(true);
    expect((await f.call(f.ownerPath, 'owner', 'POST', f.select(f.social))).status).toBe(409);
    expect((await f.approve(token, f.social[0])).status).toBe(409);
    expect((await f.read(token)).creatives.every(c => c.publications.every(p => p.status === 'changed'))).toBe(true);
    expect(f.queue.messages).toEqual([]);
  });
  it('restricts creation, metadata and revocation to owners and separates review credentials from account tokens', async () => {
    const f = await setup();
    expect((await f.call(f.ownerPath, 'viewer', 'POST', f.select(f.social))).status).toBe(403);
    expect((await f.call(f.ownerPath, 'viewer')).status).toBe(403);
    expect((await f.call(f.ownerPath, 'owner', 'POST', f.select(f.posts))).status).toBe(400);
    const link = await f.issue();
    expect((await f.call(f.ownerPath + '/' + link.id, 'viewer', 'DELETE')).status).toBe(403);
    const list = await (await f.call(f.ownerPath, 'owner')).json();
    expect(list.items).toHaveLength(1); expect(JSON.stringify(list)).not.toContain(link.token);
    expect(JSON.stringify(await f.repository.getSocialReviewLink(f.project.id, link.id, monday))).not.toContain(link.token);
    expect((await f.call(f.ownerPath, link.token)).status).toBe(401);
    expect((await f.call(f.reviewPath, link.id)).status).toBe(404);
    expect((await f.call(f.reviewPath, 'owner')).status).toBe(404);
    expect((await f.call('social-reviews/another-project', link.token)).status).toBe(404);
    expect((await f.approve(link.token, f.posts[2])).status).toBe(404);
    expect((await f.approve(link.token, f.social[0], { previewConfirmed: false })).status).toBe(400);
    expect(f.queue.messages).toEqual([]);
  });
  it('reviews matching private images once, preserves different publish times and independent failures, and supports safe retry', async () => {
    const f = await setup();
    const [facebook, oldInstagram] = f.social;
    const instagram = { ...oldInstagram, scheduledAt: '2026-11-07T15:00:00.000Z', version: oldInstagram.version + 1 };
    await f.repository.saveSocialPublication(instagram, oldInstagram.version);
    const { token } = await f.issue([facebook, instagram]);
    const preview = await f.read(token);
    expect(preview.creatives).toHaveLength(1);
    expect(preview.creatives[0].publications.map(p => p.scheduledAt)).toEqual([future, instagram.scheduledAt]);
    expect(JSON.stringify(preview)).not.toMatch(/private-profile|contentDigest|PRIVATE-GENERATION-STATE|account-facebook/);
    f.publisher.accounts.mockResolvedValue([f.accounts[0]]);
    expect((await f.approve(token, facebook)).status).toBe(202);
    expect((await f.approve(token, instagram)).status).toBe(409);
    expect((await f.approve(token, facebook)).status).toBe(200);
    expect(f.queue.messages).toHaveLength(1);
    expect((await f.read(token)).creatives[0].publications.map(p => p.status)).toEqual(['scheduled', 'review_required']);
    f.publisher.accounts.mockResolvedValue(f.accounts);
    expect((await f.approve(token, instagram)).status).toBe(202);
    expect((await f.repository.getSocialPublication(f.project.id, instagram.id))?.approval?.approvedBy).toMatch(/^client-review:/);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it.each(['caption', 'media', 'ungrouped'] as const)('separates two destinations when their %s differs', async difference => {
    const f = await setup(), [facebook, original] = f.social;
    const changed = { ...original, version: original.version + 1 };
    if (difference === 'caption') changed.content = { ...changed.content!, body: 'Serve the coffee chilled.' };
    if (difference === 'media') changed.media = [{ ...changed.media![0], contentDigest: '2'.repeat(64) }];
    if (difference === 'ungrouped') changed.sharedGeneration = undefined;
    await f.repository.saveSocialPublication(changed, original.version);
    const { token } = await f.issue([facebook, changed]);
    expect((await f.read(token)).creatives.map(c => c.publications.length)).toEqual([1, 1]);
  });
  it('groups independently edited images only while their server-verified version-pinned bytes match', async () => {
    const image = Buffer.alloc(2048, 1);
    const uploads: SocialMediaUploadStore = { start: vi.fn(async () => ({ url: 'https://files.test/upload', fields: {} })),
      complete: vi.fn(async (key, mimeType, size, id) => ({ id, key, versionId: 'immutable', mimeType, size, type: 'image' as const, url: 'https://files.test/' + id })),
      preview: vi.fn(async source => source.url), read: vi.fn(async () => image), put: vi.fn() };
    const f = await setup(uploads);
    async function replace(post: SocialPublication) {
      const base = 'projects/shared-project/social/publications/' + post.id + '/media/';
      const start = await f.call(base + 'start', 'owner', 'POST', { version: post.version, filename: 'roast.jpg',
        mimeType: 'image/jpeg', size: image.byteLength, replaceIndex: 0 });
      const { uploadId } = await start.json();
      expect((await f.call(base + 'complete', 'owner', 'POST', { version: post.version, uploadId })).status).toBe(200);
      expect(uploads.read).toHaveBeenCalledWith(expect.objectContaining({ id: uploadId, versionId: 'immutable' }));
      const stored = (await f.repository.getSocialPublication(f.project.id, post.id))!;
      expect(stored.media?.[0].contentDigest).toBe(createHash('sha256').update(image).digest('hex'));
      return stored;
    }
    const fb = await replace(f.social[0]), ig = await replace(f.social[1]);
    expect(fb.media![0].url).not.toBe(ig.media![0].url);
    expect((await f.read((await f.issue([fb, ig])).token)).creatives).toHaveLength(1);
    image[128]++;
    const different = await replace(ig);
    const forged = await f.call('projects/shared-project/social/publications/' + ig.id, 'owner', 'PATCH', {
      version: different.version, content: different.content, media: [{ ...different.media![0], contentDigest: fb.media![0].contentDigest }],
    });
    expect(forged.status).toBe(200);
    const saved = (await f.repository.getSocialPublication(f.project.id, ig.id))!;
    expect(saved.media![0].contentDigest).toBe(different.media![0].contentDigest);
    expect((await f.read((await f.issue([fb, saved])).token)).creatives).toHaveLength(2);
  });
  it('withholds edited content, rejects stale approvals and cannot authorize newer versions with the same link', async () => {
    const f = await setup(), { token } = await f.issue();
    const [changed, untouched] = f.social;
    const response = await f.call('projects/shared-project/social/publications/' + changed.id, 'owner', 'PATCH',
      { version: changed.version, content: { ...changed.content, body: 'Confidential wording for the next launch.' } });
    expect(response.status).toBe(200);
    const preview = await f.read(token);
    expect(JSON.stringify(preview)).not.toContain('Confidential');
    expect(preview.creatives.find(c => c.id === changed.id)?.publications[0].status).toBe('changed');
    expect((await f.approve(token, changed)).status).toBe(409);
    expect((await f.approve(token, { ...changed, version: changed.version + 1 })).status).toBe(404);
    expect((await f.approve(token, untouched)).status).toBe(202);
  });
  it('enforces expiration and revocation, including revocation during the connection check', async () => {
    const f = await setup(), { token, id } = await f.issue();
    f.publisher.accounts.mockImplementationOnce(async () => {
      expect((await f.call(f.ownerPath + '/' + id, 'owner', 'DELETE')).status).toBe(200);
      return f.accounts;
    });
    expect((await f.approve(token, f.social[0])).status).toBe(409);
    expect((await f.call(f.reviewPath, token)).status).toBe(404);
    const second = await f.issue();
    f.clock.now = new Date(Date.parse(monday) + 7 * 86400000);
    expect((await f.call(f.reviewPath, second.token)).status).toBe(404);
    expect((await f.approve(second.token, f.social[0])).status).toBe(404);
    expect(f.queue.messages).toEqual([]);
  });
});
