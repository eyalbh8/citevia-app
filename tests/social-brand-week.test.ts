import { expect, it, vi } from 'vitest';
import type { SocialAutomationBrand, SocialDestination, SharedSocialReview } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, PostgresRepository, type SocialPublisher, type SocialMediaUploadStore } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { SocialAutomationEngine } from '../apps/scanner/src/social-automation.js';
import type { SocialMediaGenerator } from '../apps/scanner/src/social-media.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

function brand(id: string, name: string, description: string, volume: number): SocialAutomationBrand {
  return { id, name, description, facebookDestinationId: id + '-fb', instagramDestinationId: id + '-ig',
    shareFacebookInstagramContent: true,
    // The two brands intentionally use the same first slot IDs and times.
    slots: Array.from({ length: volume }, (_, i) => ({
      id: `slot-${i}`, dayOfWeek: Math.floor(i / 2) + 1, time: i % 2 ? '16:00' : '10:00',
    })),
  };
}

it('prepares a 10 + 2 brand week, reviews 12 creatives and publishes 24 independently timed destinations', async () => {
  const db = await localPostgres();
  try {
    let clock = new Date('2026-11-08T15:00:00Z');
    const now = () => clock;
    const repository = new PostgresRepository(db), queue = new MemoryQueue(), artifacts = new MemoryArtifacts();
    const runtime = { repository, queue, artifacts };
    const project = newProject({ id: 'coffee', brand: 'Coffee Roasters', domain: 'coffee.example', now: clock,
      prompts: ['How should I prepare this coffee at home?'] });
    project.socialProfileId = 'coffee-profile';
    await repository.saveProject(project, null);
    const owner = testIdentity('coffee-owner');
    await repository.syncUser(owner);
    await repository.putMembership({ projectId: project.id, userId: owner.subject, role: 'owner' });
    const brands = [brand('hot', 'Hot Coffee', 'Espresso and whole coffee beans', 10), brand('iced', 'Iced Coffee', 'Iced coffee drinks and cold brew', 2)];
    const destinations: SocialDestination[] = brands.flatMap(b => (['facebook', 'instagram'] as const).map(channel =>
      ({ id: channel === 'facebook' ? b.facebookDestinationId : b.instagramDestinationId,
        username: `@${b.id}-${channel}`, channel, profileId: project.socialProfileId!, active: true, requiresReconnect: false })));
    destinations.push({ ...destinations[0], id: 'unassigned-page' }, { ...destinations[1], profileId: 'other-project-profile', id: 'foreign' });
    const publisher = {
      accounts: vi.fn(async () => destinations), recentPosts: vi.fn(async () => []),
      publish: vi.fn<SocialPublisher['publish']>(async (_profile, _destination, _payload, key) => ({ status: 'published', providerPostId: key })),
      uploadMedia: vi.fn(async (name: string) => ({ url: `https://media.example/${name}` })),
      ensureProfile: vi.fn(), connectUrl: vi.fn(), getPost: vi.fn(), pinterestBoards: vi.fn(), tiktokMusic: vi.fn(), tiktokCreatorInfo: vi.fn(),
    } satisfies SocialPublisher;
    const privateBytes = new Map<string, Uint8Array>();
    const uploads: SocialMediaUploadStore = {
      start: vi.fn(), complete: vi.fn(),
      put: async (key, bytes, mimeType, id) => {
        privateBytes.set(key, bytes);
        return { key, id, size: bytes.length, mimeType, type: 'image', versionId: 'first', url: `https://media.example/${key}?versionId=first` };
      },
      read: async asset => privateBytes.get(asset.key)!,
      preview: async asset => asset.url + '&signature=preview',
    };
    const generator = {
      analyzeStyle: vi.fn<SocialMediaGenerator['analyzeStyle']>().mockResolvedValue({ summary: 'Coffee', voice: 'Helpful', palette: [], typography: '',
        composition: '', referenceImageUrls: [], evidence: [], source: 'brandbook', capturedAt: clock.toISOString(), requestId: null }),
      generateCopy: vi.fn<SocialMediaGenerator['generateCopy']>(async (frozen, _prompt, dest) => {
        const { socialBrand, weeklyCreative } = frozen;
        expect(dest.contentFormat).toBe('facebook-instagram');
        expect(socialBrand?.description).toBe(brands.find(b => b.facebookDestinationId === dest.id)!.description);
        const title = `${socialBrand!.description}, post ${weeklyCreative!.number}`;
        return { title, body: `Try this week's idea for ${title}.`, hashtags: ['#Coffee'], format: 'image',
          slides: [{ heading: title, body: 'Coffee', imagePrompt: 'Coffee close-up' }] };
      }),
      generateImage: vi.fn<SocialMediaGenerator['generateImage']>(async (_project, _prompt, copy) =>
        ({ bytes: Buffer.from(copy.title), width: 1024, height: 1024, mime: 'image/jpeg', requestId: null })),
      checkImage: vi.fn(), videoReady: vi.fn(), renderVideo: vi.fn(),
    } satisfies SocialMediaGenerator;
    const services = { publisher: async () => publisher, uploads: () => uploads, frontendOrigin: 'https://app.citevia.io',
      generationAvailable: true, blogAvailable: true, sync: async () => {} };
    const api = createAuthenticatedApi(runtime, { lookup: vi.fn(), authenticate: async request => {
      if (request.headers.get('Authorization') !== 'Bearer owner-token') throw new Error('Owner token required');
      return owner;
    } }, { mode: 'live', now, social: services });
    const call = (path: string, method = 'GET', input?: unknown, bearer = 'owner-token') => api(new Request('https://api.citevia.io/v1/' + path, {
      method, headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
    const base = 'projects/coffee/social';
    const save = await call(base + '/settings', 'PATCH', { version: 1, settings: {
      enabled: true, timezone: 'UTC', generationTime: '08:00', generationCadence: 'weekly', slots: [], brands,
    } });
    expect(save.status, await save.clone().text()).toBe(200);
    const worker = new SocialAutomationEngine(runtime, services.publisher, async () => generator, now, undefined, services.uploads);
    const manual = queue.messages.shift();
    if (manual?.kind !== 'social-generation') throw new Error('Settings save did not request preparation');
    await worker.handleGeneration(manual);
    expect((await repository.listSocialPublications(project.id, 0, 100)).total).toBe(0);
    clock = new Date('2026-11-09T08:00:00Z');
    const monday = { ...manual, trigger: 'scheduled' as const, scheduledAt: clock.toISOString() };
    for (let replay = 0; replay < 2; replay++) await worker.handleGeneration(monday);

    // Deliver the queued stages, including followers that wake after their producer finishes.
    for (let tick = 0; tick < 18; tick++) {
      const jobs = queue.messages.splice(0);
      for (const job of jobs) if (job.kind === 'social-publication') await worker.handlePublication(job.projectId, job.publicationId);
      clock = new Date(clock.getTime() + 30000);
    }
    const prepared = (await repository.listSocialPublications(project.id, 0, 100)).items;
    expect(prepared).toHaveLength(24);
    expect(prepared.every(p => p.status === 'review_required')).toBe(true);
    for (const b of brands) {
      const posts = prepared.filter(p => p.context.socialBrand?.id === b.id);
      expect(new Set(posts.map(p => p.content!.body)).size).toBe(b.slots.length);
      for (const id of [b.facebookDestinationId, b.instagramDestinationId])
        expect(posts.filter(p => p.destination.id === id)).toHaveLength(b.slots.length);
    }
    expect(generator.generateCopy).toHaveBeenCalledTimes(12);
    expect(generator.generateImage).toHaveBeenCalledTimes(12);
    expect(generator.checkImage).toHaveBeenCalledTimes(12);
    expect(privateBytes.size).toBe(24);
    expect(new Set([...privateBytes.values()].map(bytes => Buffer.from(bytes).toString('hex'))).size).toBe(12);
    expect(publisher.publish).not.toHaveBeenCalled();

    // Reschedule only one sibling, retaining its exact reviewed content.
    const moved = prepared.find(p => p.context.socialBrand?.id === 'iced' && p.destination.channel === 'instagram')!;
    const later = '2026-11-15T16:30:00.000Z';
    expect((await call(base + '/publications/' + moved.id, 'PATCH', {
      version: moved.version, content: moved.content, scheduledAt: later,
    })).status).toBe(200);
    const candidates = await (await call(base + '/publications?clientReview=true')).json();
    expect(candidates.total).toBe(24);
    const publications = candidates.items.map(({ id, version }: { id: string; version: number }) => ({ id, version }));
    const issue = await call(base + '/review-links', 'POST', { publications });
    expect(issue.status, await issue.clone().text()).toBe(201);
    const token = new URL((await issue.json()).url).hash.split('/').at(-1)!;
    const publicRoute = 'social-reviews/' + project.id;
    const preview = await call(publicRoute, 'GET', undefined, token);
    expect(preview.status, await preview.clone().text()).toBe(200);
    const { creatives }: SharedSocialReview = await preview.json();
    expect(creatives).toHaveLength(12);
    for (const creative of creatives) {
      expect(creative.publications).toHaveLength(2);
      expect(new Set(creative.publications.map(p => p.channel))).toEqual(new Set(['instagram', 'facebook']));
      for (const { id, version } of creative.publications) {
        const approval = await call(publicRoute + '/approve', 'POST', { id, version, previewConfirmed: true, expressConsentGiven: true }, token);
        expect(approval.ok, await approval.clone().text()).toBe(true);
      }
    }
    expect(publisher.publish).not.toHaveBeenCalled();
    const scheduled = (await repository.listSocialPublications(project.id, 0, 100)).items;
    expect(scheduled.every(p => p.status === 'scheduled')).toBe(true);
    for (const time of [...new Set(scheduled.map(p => p.scheduledAt))].sort()) {
      clock = new Date(time);
      const before = publisher.publish.mock.calls.length;
      for (const p of await repository.listActiveSocialPublications(100, time)) await worker.handlePublication(project.id, p.id);
      expect(publisher.publish.mock.calls.length - before).toBe(scheduled.filter(p => p.scheduledAt === time).length);
    }
    expect(publisher.publish).toHaveBeenCalledTimes(24);
    expect(new Set(publisher.publish.mock.calls.map(args => args[3])).size).toBe(24);
    for (const [profile, dest, payload] of publisher.publish.mock.calls) {
      expect(profile).toBe(project.socialProfileId);
      const b = brands.find(b => b.facebookDestinationId === dest.id || b.instagramDestinationId === dest.id)!;
      expect(payload.text).toContain(b.description);
      expect(payload.media).toHaveLength(1);
    }
    expect((await repository.listSocialPublications(project.id, 0, 100)).items.every(p => p.status === 'published')).toBe(true);
  } finally { await db.close(); }
}, 60000);
