import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, SocialPublisherError, type SocialPublisher } from '@citevia/storage';
import { defaultSocialAutomationSettings, type SocialAutomationBrand, type SocialDestination, type SocialPublication } from '@citevia/core';
import { createApi } from '../apps/api/src/app.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const now = '2026-11-02T10:00:00.000Z';
const account: SocialDestination = { id: 'page-one', profileId: 'profile-one', username: 'Business page', channel: 'facebook', active: true, requiresReconnect: false };
const settings = { enabled: true, createBlogDrafts: false, timezone: 'Europe/London', slots: [{ id: 'monday', dayOfWeek: 1, time: '10:30' }] };
async function fixture(withProfile = true) {
  const repository = new MemoryRepository(), queue = new MemoryQueue(), artifacts = new MemoryArtifacts();
  for (const name of ['social-owner', 'social-viewer', 'social-outsider']) await repository.syncUser(testIdentity(name));
  const project = newProject({ id: 'social-project', prompts: ['How do teams measure visibility?'] });
  if (withProfile) project.socialProfileId = account.profileId;
  await repository.saveProject(project, null);
  for (const [userId, role] of [['social-owner', 'owner'], ['social-viewer', 'viewer']] as const)
    await repository.putMembership({ projectId: project.id, userId, role });
  const publisher = {
    accounts: vi.fn(async () => [account]), ensureProfile: vi.fn(async () => 'profile-one'),
    connectUrl: vi.fn(async () => 'https://zernio.com/connect/test'), pinterestBoards: vi.fn(async () => [{ id: 'board-one', name: 'Guides' }]),
    publish: vi.fn(), getPost: vi.fn(), recentPosts: vi.fn(), uploadMedia: vi.fn(), tiktokCreatorInfo: vi.fn(), tiktokMusic: vi.fn(),
  } satisfies SocialPublisher;
  const sync = vi.fn(async () => {});
  const options = { mode: 'live' as const, now: () => new Date(now), social: {
    publisher: vi.fn(async () => publisher), sync, generationAvailable: true, blogAvailable: true, unsplashAvailable: true, frontendOrigin: 'https://app.citevia.io',
  } };
  const api = createApi({ repository, queue, artifacts }, options);
  const call = (suffix = '', method = 'GET', data?: unknown, user = 'social-owner') => api(new Request(`https://api.citevia.io/v1/projects/${project.id}/social${suffix}`, {
    method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }),
  }), testIdentity(user));
  return { repository, queue, project, publisher, sync, options, call };
}

describe('social automation API', () => {
  it('starts disabled and exposes connected metadata without vendor profile IDs', async () => {
    const f = await fixture();
    const data = await (await f.call()).json();
    expect(data.settings).toMatchObject({ enabled: false, createBlogDrafts: true, imageSource: 'openai', shareFacebookInstagramContent: false, slots: [] });
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).not.toHaveProperty('profileId');
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('persists image sources, preserves older client omissions, and validates changes', async () => {
    const f = await fixture();
    const saved = await (await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, imageSource: 'unsplash' } })).json();
    expect(saved.settings.imageSource).toBe('unsplash');
    const get = await (await f.call()).json();
    expect(get.settings.imageSource).toBe('unsplash');
    expect(get.unsplashAvailable).toBe(true);
    const legacy = await (await f.call('/settings', 'PATCH', { version: saved.version, settings })).json();
    expect(legacy.settings.imageSource).toBe('unsplash');
    for (const imageSource of ['random', null, false])
      expect((await f.call('/settings', 'PATCH', { version: legacy.version, settings: { ...settings, imageSource } })).status).toBe(400);
    const changed = await (await f.call('/settings', 'PATCH', { version: legacy.version, settings: { ...settings, imageSource: 'openai' } })).json();
    expect(changed.settings.imageSource).toBe('openai');
  });
  it('requires Unsplash configuration for social generation but allows saving a paused choice', async () => {
    const f = await fixture();
    f.options.social.unsplashAvailable = false;
    const input = { ...settings, imageSource: 'unsplash' };
    expect((await f.call('/settings', 'PATCH', { version: 1, settings: input })).status).toBe(503);
    const paused = await (await f.call('/settings', 'PATCH', { version: 1, settings: { ...input, enabled: false } })).json();
    expect(paused.settings.imageSource).toBe('unsplash');
    f.options.social.unsplashAvailable = true;
    const enabled = await (await f.call('/settings', 'PATCH', { version: paused.version, settings: input })).json();
    f.options.social.unsplashAvailable = false;
    expect((await f.call('/generate', 'POST', { version: enabled.version })).status).toBe(503);
  });
  it('enforces project membership and owner-only changes', async () => {
    const f = await fixture();
    expect((await f.call('', 'GET', undefined, 'social-viewer')).status).toBe(200);
    expect((await f.call('/connect', 'POST', { channel: 'facebook' }, 'social-viewer')).status).toBe(403);
    expect((await f.call('/settings', 'PATCH', { version: 1, settings }, 'social-outsider')).status).toBe(404);
  });
  it('saves brand calendars and rejects wrong-channel, foreign, disconnected and reused accounts', async () => {
    const f = await fixture(), ig = { ...account, channel: 'instagram' as const, id: 'ig' };
    const brand = { id: 'hot', name: 'Hot Coffee', description: 'Espresso and coffee beans', facebookDestinationId: account.id,
      instagramDestinationId: ig.id, shareFacebookInstagramContent: true, slots: settings.slots };
    const input = { ...settings, slots: [], brands: [brand], createBlogDrafts: true };
    f.options.social.blogAvailable = false;
    for (const invalid of [{ ...ig, channel: 'facebook' as const }, { ...ig, profileId: 'foreign' }, { ...ig, active: false }, { ...ig, requiresReconnect: true }]) {
      f.publisher.accounts.mockResolvedValue([account, invalid]);
      expect((await f.call('/settings', 'PATCH', { version: 1, settings: input })).status).toBe(400);
    }
    f.publisher.accounts.mockResolvedValue([account, ig]);
    for (const invalid of [{ ...input, brands: [brand, { ...brand, id: 'iced', name: 'Iced Coffee' }] },
      { ...input, brands: [{ ...brand, slots: [] }] }, { ...input, generationTime: '10:30' }])
      expect((await f.call('/settings', 'PATCH', { version: 1, settings: invalid })).status).toBe(400);
    const saved = await (await f.call('/settings', 'PATCH', { version: 1, settings: input })).json();
    expect(saved.settings.brands).toEqual([brand]);
    expect(saved.settings.slots).toEqual([]);
    const { brands: _brands, ...olderInput } = input;
    const unchanged = await (await f.call('/settings', 'PATCH', { version: saved.version, settings: olderInput })).json();
    expect(unchanged).toEqual(saved);
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.queue.messages).toHaveLength(1);
    f.sync.mockRejectedValueOnce(new Error('scheduler unavailable'));
    const moved = { ...input, generationTime: '07:00' };
    expect((await f.call('/settings', 'PATCH', { version: saved.version, settings: moved })).status).toBe(503);
    const pending = (await f.repository.getProject(f.project.id))!;
    expect(pending.socialAutomation?.scheduleStatus).toBe('error');
    const repaired = await (await f.call('/settings', 'PATCH', { version: pending.version, settings: moved })).json();
    expect(repaired.settings).toMatchObject({ revision: pending.socialAutomation?.revision, scheduleStatus: 'synced' });
    expect(f.queue.messages).toHaveLength(2);
    f.publisher.accounts.mockRejectedValue(new Error('provider unavailable'));
    const legacyPause = await (await f.call('/settings', 'PATCH', { version: repaired.version, settings: { ...settings, enabled: false } })).json();
    expect(legacyPause.settings.brands).toEqual([brand]);
    expect(legacyPause.settings.enabled).toBe(false);
    expect((await f.call('/settings', 'PATCH', { version: legacyPause.version, settings: { ...settings, enabled: false, brands: [] } })).status).toBe(200);
  });
  it('preserves original brief text by brand ID when an owner resubmits the public settings form', async () => {
    const f = await fixture();
    const brands: SocialAutomationBrand[] = ['Hot', 'Iced'].map(name => ({
      id: `demo-${name}`, name: `${name} Demo Coffee`, description: `${name} coffee demos`, slots: settings.slots,
      shareFacebookInstagramContent: true, facebookDestinationId: `fb-${name}`, instagramDestinationId: `ig-${name}`,
    }));
    await f.repository.saveProject({ ...f.project, version: 2, socialAutomation: { ...defaultSocialAutomationSettings(), brands } }, 1);
    const api = createAuthenticatedApi({ repository: f.repository, artifacts: new MemoryArtifacts(), queue: f.queue },
      { authenticate: async () => testIdentity('social-owner'), lookup: vi.fn() }, f.options);
    const endpoint = `https://api.citevia.io/v1/projects/${f.project.id}/social`;
    const read = await api(new Request(endpoint));
    expect(read.status).toBe(200);
    const view = await read.json();
    const [hot, iced] = view.settings.brands as SocialAutomationBrand[];
    expect(hot.id).not.toBe(brands[0].id);
    expect(hot.name).toBe('Hot […] Coffee');
    expect(hot.description).toBe('Hot coffee […]');
    const replacement = 'Cold coffee over ice';
    const slots = [{ ...hot.slots[0], time: '13:00' }];
    const save = await api(new Request(endpoint + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: view.version, settings: { ...settings, enabled: false, brands: [
        { ...iced, description: replacement }, { ...hot, slots },
      ] } }),
    }));
    expect(save.status).toBe(200);
    expect((await f.repository.getProject(f.project.id))?.socialAutomation?.brands).toEqual([
      { ...brands[1], description: replacement }, { ...brands[0], slots },
    ]);
    expect(f.queue.messages).toHaveLength(0);
  });
  it('never turns expired social credentials into a Descope session error', async () => {
    const f = await fixture();
    f.publisher.accounts.mockRejectedValue(new SocialPublisherError('social_reconnect_required', 'Reconnect the social account.', false, false, 401));
    const response = await f.call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'social_reconnect_required', message: 'Reconnect the social account.' } });
  });
  it('validates slots, timezone, active prompts and connected accounts before enabling', async () => {
    const f = await fixture();
    expect((await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, slots: [] } })).status).toBe(400);
    expect((await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, timezone: 'Invalid/Place' } })).status).toBe(400);
    f.publisher.accounts.mockResolvedValue([]);
    expect((await f.call('/settings', 'PATCH', { version: 1, settings })).status).toBe(400);
    f.project.prompts.forEach(prompt => { prompt.active = false; });
    await f.repository.saveProject({ ...f.project, version: 2 }, 1);
    expect((await f.call('/settings', 'PATCH', { version: 2, settings: { ...settings, createBlogDrafts: true } })).status).toBe(400);
  });
  it('saves blog-only automation without connecting or publishing anything', async () => {
    const f = await fixture(false);
    const response = await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, createBlogDrafts: true } });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.settings).toMatchObject({ enabled: true, createBlogDrafts: true, revision: 1, effectiveFrom: now, scheduleStatus: 'synced' });
    expect(f.options.social.publisher).not.toHaveBeenCalled();
    expect(f.queue.messages).toEqual([{ kind: 'social-generation', projectId: f.project.id, revision: 1, scheduledAt: now, trigger: 'manual' }]);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('pauses without deleting drafts and keeps scans independent', async () => {
    const f = await fixture();
    const enabled = await (await f.call('/settings', 'PATCH', { version: 1, settings })).json();
    f.options.social.generationAvailable = false;
    expect((await f.call('/settings', 'PATCH', { version: enabled.version, settings: { ...settings, enabled: false } })).status).toBe(200);
    const stored = await f.repository.getProject(f.project.id);
    expect(stored?.enabled).toBe(f.project.enabled);
    expect(stored?.socialAutomation).toMatchObject({ enabled: false, revision: 2 });
    expect(stored?.prompts).toEqual(f.project.prompts);
  });
  it('saves explicit sharing changes with new revisions and preserves an older client omission', async () => {
    const f = await fixture();
    const enabled = await (await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, shareFacebookInstagramContent: true } })).json();
    expect(enabled.settings).toMatchObject({ shareFacebookInstagramContent: true, revision: 1 });
    expect((await (await f.call()).json()).settings.shareFacebookInstagramContent).toBe(true);
    const legacy = await (await f.call('/settings', 'PATCH', { version: enabled.version, settings })).json();
    expect(legacy.settings).toMatchObject({ shareFacebookInstagramContent: true, revision: 2 });
    expect((await f.call('/settings', 'PATCH', { version: legacy.version, settings: { ...settings, shareFacebookInstagramContent: null } })).status).toBe(400);
    const disabled = await (await f.call('/settings', 'PATCH', { version: legacy.version, settings: { ...settings, shareFacebookInstagramContent: false } })).json();
    expect(disabled.settings).toMatchObject({ shareFacebookInstagramContent: false, revision: 3 });
  });
  it('records schedule repair failures while the saved pause remains effective', async () => {
    const f = await fixture();
    f.sync.mockRejectedValue(new Error('scheduler unavailable'));
    expect((await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, enabled: false } })).status).toBe(503);
    expect((await f.repository.getProject(f.project.id))?.socialAutomation).toMatchObject({ enabled: false, scheduleStatus: 'error' });
  });
  it('does not accept private profile IDs, blog publishing or caller-chosen redirects', async () => {
    const f = await fixture(false);
    expect((await f.call('/connect', 'POST', { channel: 'blog' })).status).toBe(400);
    expect((await f.call('/connect', 'POST', { channel: 'facebook', redirectUrl: 'https://evil.example' })).status).toBe(400);
    expect((await f.call('/settings', 'PATCH', { version: 1, settings: { ...settings, socialProfileId: 'other' } })).status).toBe(400);
    expect((await f.call('/connect', 'POST', { channel: 'facebook' })).status).toBe(200);
    expect(f.publisher.connectUrl).toHaveBeenCalledWith('profile-one', 'facebook', 'https://app.citevia.io/#integrations');
    expect((await f.repository.getProject(f.project.id))?.socialProfileId).toBe('profile-one');
  });
  it('checks destination ownership and validates Pinterest boards', async () => {
    const f = await fixture();
    f.publisher.accounts.mockResolvedValue([{ ...account, channel: 'pinterest' }]);
    expect((await f.call('/destinations', 'PATCH', { version: 1, destinationId: 'other-page', boardId: 'board-one' })).status).toBe(404);
    expect((await f.call('/destinations', 'PATCH', { version: 1, destinationId: account.id, boardId: 'other-board' })).status).toBe(400);
    expect((await f.call('/destinations', 'PATCH', { version: 1, destinationId: account.id, boardId: 'board-one' })).status).toBe(200);
    expect((await f.repository.getProject(f.project.id))?.socialDestinationOptions?.[account.id]).toEqual({ boardId: 'board-one' });
  });
  it('requires consent for the current TikTok preview and exposes no private checkpoint data', async () => {
    const f = await fixture();
    f.publisher.accounts.mockResolvedValue([{ ...account, channel: 'tiktok' }]);
    f.publisher.tiktokCreatorInfo.mockResolvedValue({ privacyLevels: ['PUBLIC_TO_EVERYONE'], canPostMore: true, interactions: { allowComment: true, allowDuet: false, allowStitch: false } });
    f.publisher.tiktokMusic.mockResolvedValue([{ id: 'track-one', name: 'Track', artist: 'Artist' }]);
    const project = { ...f.project, version: 2, socialAutomation: { ...settings, revision: 1, effectiveFrom: '2026-11-01T00:00:00Z', scheduleStatus: 'synced' as const, slots: [{ id: 'monday', dayOfWeek: 1, time: '10:00' }] } };
    await f.repository.saveProject(project, 1);
    const reserved = await f.repository.reserveSocialOccurrence({ projectId: project.id, revision: 1, slotId: 'monday', scheduledAt: now, now, destinations: [{ ...account, channel: 'tiktok' }] });
    if (reserved.status !== 'created') throw new Error('missing occurrence');
    const post: SocialPublication = { ...reserved.publications[0], version: 2, status: 'review_required', stage: 'publish', scheduledAt: '2026-11-02T11:00:00Z', content: { title: 'Visibility', body: 'Measure visibility across channels.', hashtags: [] }, checkpoints: { internal: 'private' }, media: [{ type: 'video', url: 'https://media.zernio.com/test.mp4', mimeType: 'video/mp4' }] };
    await f.repository.saveSocialPublication(post, 1);
    const preview = await (await f.call(`/publications/${post.id}`)).json();
    expect(preview).not.toHaveProperty('checkpoints');
    expect(preview).not.toHaveProperty('context');
    const approval = { version: 2, previewConfirmed: true, expressConsentGiven: true, privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'track-one' };
    expect((await f.call(`/publications/${post.id}/approve`, 'POST', { ...approval, expressConsentGiven: false })).status).toBe(400);
    expect((await f.call(`/publications/${post.id}/approve`, 'POST', { ...approval, version: 1 })).status).toBe(409);
    expect((await f.call(`/publications/${post.id}/approve`, 'POST', approval)).status).toBe(202);
    expect((await f.call(`/publications/${post.id}/approve`, 'POST', approval)).status).toBe(409);
    expect(f.queue.messages).toEqual([{ kind: 'social-publication', projectId: project.id, publicationId: post.id }]);
    expect((await f.repository.getSocialPublication(project.id, post.id))?.status).toBe('scheduled');
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
});
