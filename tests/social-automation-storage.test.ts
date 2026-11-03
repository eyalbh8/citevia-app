import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SOCIAL_CHANNELS, defaultSocialAutomationSettings, socialAutomationInputSchema, socialOccurrenceLocalDate, socialSlotCron,
  socialGenerationCron, socialGenerationOccurrences, socialApprovalSnapshot,
  type Project, type ReserveSocialOccurrenceInput, type SocialDestination, type SocialPublication,
} from '@citevia/core';
import { MemoryRepository, PostgresRepository, type Repository, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { newProject } from './fixtures/scanner.js';

const monday = '2026-11-02T09:00:00.000Z';
function account(overrides: Partial<Project> = {}): Project {
  const project = newProject({ id: randomUUID(), now: new Date('2026-10-01T00:00:00Z'), prompts: ['First useful question?', 'Second useful question?'] });
  return { ...project, socialProfileId: `profile-${project.id}`, socialAutomation: {
    ...defaultSocialAutomationSettings(), enabled: true, createBlogDrafts: false, revision: 1,
    effectiveFrom: '2026-10-01T00:00:00.000Z', slots: [{ id: 'monday', dayOfWeek: 1, time: '09:00' }],
  }, ...overrides };
}
function destination(project: Project, channel: SocialDestination['channel'] = 'facebook'): SocialDestination {
  return { id: `${project.id}-${channel}`, channel, username: `${channel}-brand`, profileId: project.socialProfileId!, active: true, requiresReconnect: false };
}
function input(project: Project, overrides: Partial<ReserveSocialOccurrenceInput> = {}): ReserveSocialOccurrenceInput {
  return { projectId: project.id, revision: project.socialAutomation!.revision, slotId: 'monday', scheduledAt: monday, now: monday,
    destinations: [destination(project)], ...overrides };
}

describe('social automation schedule validation', () => {
  it('defaults off, accepts only client-owned settings and rejects duplicate and invalid slots', () => {
    expect(defaultSocialAutomationSettings().enabled).toBe(false);
    const settings = { enabled: true, timezone: 'UTC', slots: [{ id: 'mon', dayOfWeek: 1, time: '09:00' }] };
    expect(socialAutomationInputSchema.parse(settings).createBlogDrafts).toBe(true);
    expect(socialAutomationInputSchema.parse(settings).imageSource).toBe('openai');
    expect(socialAutomationInputSchema.safeParse({ ...settings, imageSource: 'random' }).success).toBe(false);
    expect(socialAutomationInputSchema.parse(settings).shareFacebookInstagramContent).toBe(false);
    expect(defaultSocialAutomationSettings().shareFacebookInstagramContent).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, shareFacebookInstagramContent: 'true' }).success).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, socialProfileId: 'another-account' }).success).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, revision: 3 }).success).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, timezone: 'Not/AZone' }).success).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, slots: [...settings.slots, { ...settings.slots[0], id: 'other' }] }).success).toBe(false);
    expect(socialAutomationInputSchema.safeParse({ ...settings, slots: [] }).success).toBe(false);
    expect(socialSlotCron(settings.slots[0])).toBe('cron(0 9 ? * MON *)');
  });
  it('validates local day and date across midnight and skips nonexistent spring times', () => {
    const project = account();
    project.socialAutomation!.timezone = 'Pacific/Auckland';
    expect(socialOccurrenceLocalDate(project, input(project, { scheduledAt: '2026-11-01T20:00:00Z' }), '2026-11-01T20:00:00Z')).toBe('2026-11-02');
    project.socialAutomation!.timezone = 'America/New_York';
    project.socialAutomation!.effectiveFrom = '2026-01-01T00:00:00Z';
    project.socialAutomation!.slots = [{ id: 'sunday', dayOfWeek: 0, time: '02:30' }];
    for (const scheduledAt of ['2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z'])
      expect(socialOccurrenceLocalDate(project, input(project, { slotId: 'sunday', scheduledAt }), scheduledAt)).toBeNull();
  });
  it('rejects stale revisions, expired deliveries, future times and earlier configurations', () => {
    const project = account();
    expect(socialOccurrenceLocalDate(project, input(project, { revision: 2 }), monday)).toBeNull();
    expect(socialOccurrenceLocalDate(project, input(project), '2026-11-02T10:01:00Z')).toBeNull();
    expect(socialOccurrenceLocalDate(project, input(project), '2026-11-02T08:58:00Z')).toBeNull();
    project.socialAutomation!.effectiveFrom = '2026-11-02T09:00:01Z';
    expect(socialOccurrenceLocalDate(project, input(project), monday)).toBeNull();
  });
  it('prepares only remaining daily, calendar-week and calendar-month slots', () => {
    const project = account();
    project.socialAutomation!.slots = [{ id: 'mon', dayOfWeek: 1, time: '09:00' }, { id: 'fri', dayOfWeek: 5, time: '18:00' }];
    const message = { kind: 'social-generation' as const, projectId: project.id, revision: 1, scheduledAt: '2026-11-02T08:00:00Z' };
    expect(socialGenerationOccurrences(project, message, message.scheduledAt)?.map(slot => slot.scheduledAt)).toEqual(['2026-11-02T09:00:00.000Z']);
    project.socialAutomation!.generationCadence = 'weekly';
    expect(socialGenerationOccurrences(project, message, message.scheduledAt)?.map(slot => slot.scheduledAt)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-06T18:00:00.000Z']);
    const midweek = { ...message, trigger: 'manual' as const, scheduledAt: '2026-11-04T10:01:15Z' };
    expect(socialGenerationOccurrences(project, midweek, midweek.scheduledAt)?.map(slot => slot.slotId)).toEqual(['fri']);
    project.socialAutomation!.generationCadence = 'monthly';
    const monthly = socialGenerationOccurrences(project, midweek, midweek.scheduledAt)!;
    expect(monthly).toHaveLength(8);
    expect(monthly.at(-1)?.scheduledAt).toBe('2026-11-30T09:00:00.000Z');
    expect(monthly.every(slot => slot.scheduledAt.startsWith('2026-11-'))).toBe(true);
    expect(socialGenerationCron(project.socialAutomation!)).toBe('cron(0 8 1 * ? *)');
    expect(socialGenerationCron({ generationCadence: 'weekly', generationTime: '07:15' })).toBe('cron(15 7 ? * MON *)');
  });
  it('validates preparation trigger dates, revisions and delivery age', () => {
    const project = account(); project.socialAutomation!.generationCadence = 'monthly';
    const message = { kind: 'social-generation' as const, projectId: project.id, revision: 1, scheduledAt: '2026-11-01T08:00:00Z' };
    expect(socialGenerationOccurrences(project, message, message.scheduledAt)).not.toBeNull();
    expect(socialGenerationOccurrences(project, { ...message, revision: 2 }, message.scheduledAt)).toBeNull();
    expect(socialGenerationOccurrences(project, message, '2026-11-01T09:00:01Z')).toBeNull();
    const wrongDay = { ...message, scheduledAt: '2026-11-02T08:00:00Z' };
    expect(socialGenerationOccurrences(project, wrongDay, wrongDay.scheduledAt)).toBeNull();
    expect(socialGenerationOccurrences(project, { ...wrongDay, trigger: 'manual' }, wrongDay.scheduledAt)).not.toBeNull();
    project.socialAutomation!.effectiveFrom = '2026-11-02T08:00:20.000Z';
    expect(socialGenerationOccurrences(project, { ...wrongDay, trigger: 'manual' }, '2026-11-02T08:00:21Z')).toBeNull();
    expect(socialGenerationOccurrences(project, { ...wrongDay, trigger: 'manual', scheduledAt: project.socialAutomation!.effectiveFrom }, '2026-11-02T08:00:21Z')).not.toBeNull();
  });
  it('uses local month boundaries and includes leap days without drifting into the next month', () => {
    const project = account();
    Object.assign(project.socialAutomation!, { generationCadence: 'monthly', timezone: 'Pacific/Kiritimati', slots: [{ id: 'tue', dayOfWeek: 2, time: '12:00' }] });
    const message = { kind: 'social-generation' as const, projectId: project.id, revision: 1, trigger: 'manual' as const, scheduledAt: '2028-02-28T19:00:00Z' };
    expect(socialGenerationOccurrences(project, message, message.scheduledAt)?.map(slot => slot.scheduledAt)).toEqual(['2028-02-28T22:00:00.000Z']);
  });
  it('skips nonexistent publishing times and chooses only the first repeated local minute', () => {
    const project = account();
    Object.assign(project.socialAutomation!, { timezone: 'America/New_York', effectiveFrom: '2026-01-01T00:00:00Z', slots: [{ id: 'sun', dayOfWeek: 0, time: '02:30' }] });
    const message = { kind: 'social-generation' as const, projectId: project.id, revision: 1, trigger: 'manual' as const, scheduledAt: '2026-03-08T05:00:00Z' };
    expect(socialGenerationOccurrences(project, message, message.scheduledAt)).toEqual([]);
    project.socialAutomation!.slots[0].time = '01:30';
    const fall = { ...message, scheduledAt: '2026-11-01T04:00:00Z' };
    expect(socialGenerationOccurrences(project, fall, fall.scheduledAt)?.map(slot => slot.scheduledAt)).toEqual(['2026-11-01T05:30:00.000Z']);
    const afterFirst = { ...fall, scheduledAt: '2026-11-01T06:00:00Z' };
    expect(socialGenerationOccurrences(project, afterFirst, afterFirst.scheduledAt)).toEqual([]);
  });
  it('binds approval to content, ordered media, destination and time regardless of JSONB key ordering', () => {
    const a = { content: { title: 'Title', body: 'Body', hashtags: ['#tag'] }, media: [{ id: 'asset', type: 'image' as const, url: 'https://example.test/a.jpg', mimeType: 'image/jpeg' }], scheduledAt: monday, destination: destination(account()) };
    const b = { ...a, content: { hashtags: ['#tag'], body: 'Body', title: 'Title' }, media: [{ mimeType: 'image/jpeg', url: 'https://example.test/a.jpg', type: 'image' as const, id: 'asset' }] };
    expect(socialApprovalSnapshot(a)).toBe(socialApprovalSnapshot(b));
    expect(socialApprovalSnapshot({ ...a, scheduledAt: '2026-11-03T09:00:00Z' })).not.toBe(socialApprovalSnapshot(a));
    expect(socialApprovalSnapshot({ ...a, destination: { ...a.destination, id: 'different' } })).not.toBe(socialApprovalSnapshot(a));
  });
});

it('upgrades legacy schedules for repair without opting in or changing publishing slots', async () => {
  const db = await localPostgres();
  try {
    const repository = new PostgresRepository(db);
    const legacy = account();
    Object.assign(legacy.socialAutomation!, { enabled: false, generationCadence: undefined, generationTime: undefined });
    const untouched = account({ socialAutomation: undefined });
    const configured = account(); Object.assign(configured.socialAutomation!, { generationCadence: 'monthly', generationTime: '07:45' });
    for (const project of [legacy, untouched, configured]) await repository.saveProject(project, null);
    // Reapply only this upgrade's DDL/data transition to legacy-shaped rows; runner idempotency is covered separately.
    await db.exec(await readFile(new URL('../database/migrations/018_social_review_schedule.sql', import.meta.url), 'utf8'));
    const saved = await repository.getProject(legacy.id);
    expect(saved?.version).toBe(legacy.version + 1);
    expect(saved?.socialAutomation).toEqual({ ...legacy.socialAutomation, generationCadence: 'daily', generationTime: '08:00', scheduleStatus: 'pending' });
    expect((await repository.getProject(untouched.id))).toEqual(untouched);
    expect((await repository.getProject(configured.id))?.socialAutomation).toMatchObject({ generationCadence: 'monthly', generationTime: '07:45', scheduleStatus: 'pending' });
  } finally { await db.close(); }
});

describe.each(['memory', 'postgres'] as const)('social automation storage (%s)', backend => {
  let repository: Repository, db: SqlDatabase | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') { db = await localPostgres(); repository = new PostgresRepository(db); }
    else repository = new MemoryRepository();
  }, 30000);
  afterAll(async () => { await db?.close(); });
  async function save(project = account()) { expect(await repository.saveProject(project, null)).toBe(true); return project; }

  it('keeps existing accounts off and scan settings independent', async () => {
    const project = await save(account({ socialAutomation: undefined }));
    expect(await repository.reserveSocialOccurrence({ ...input(account()), projectId: project.id })).toEqual({ status: 'stale' });
    const enabled = await save(account({ enabled: false }));
    expect((await repository.reserveSocialOccurrence(input(enabled))).status).toBe('created');
  });
  it('freezes the image source at reservation and defaults legacy publications to OpenAI', async () => {
    const project = account(); project.socialAutomation!.imageSource = 'unsplash'; await save(project);
    const reserved = await repository.reserveSocialOccurrence(input(project));
    if (reserved.status !== 'created') throw new Error('Expected occurrence');
    expect(reserved.occurrence.context.imageSource).toBe('unsplash');
    const next = { ...project, version: project.version + 1, socialAutomation: { ...project.socialAutomation!, imageSource: 'openai' as const } };
    await repository.saveProject(next, project.version);
    expect((await repository.getSocialPublication(project.id, reserved.publications[0].id))?.context.imageSource).toBe('unsplash');
    const legacy = account(); delete legacy.socialAutomation!.imageSource; await save(legacy);
    const old = await repository.reserveSocialOccurrence(input(legacy));
    if (old.status !== 'created') throw new Error('Expected occurrence');
    expect(old.publications[0].context.imageSource).toBe('openai');
  });
  it('atomically reserves all channels plus one blog draft once under concurrent delivery', async () => {
    const project = account(); project.socialAutomation!.createBlogDrafts = true; await save(project);
    const request = input(project, { destinations: SOCIAL_CHANNELS.map(channel => destination(project, channel)) });
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.reserveSocialOccurrence(request)));
    expect(results.filter(result => result.status === 'created')).toHaveLength(1);
    expect(results.filter(result => result.status === 'existing')).toHaveLength(7);
    const page = await repository.listSocialPublications(project.id, 0, 100);
    expect(page.total).toBe(8);
    expect(new Set(page.items.map(publication => publication.prompt.id)).size).toBe(1);
    expect(page.items.filter(publication => publication.destination.channel === 'blog')).toHaveLength(1);
    const replay = await repository.reserveSocialOccurrence({ ...request, destinations: [] });
    expect(replay.status).toBe('existing');
    if (replay.status === 'existing') expect(replay.publications.map(p => p.id).sort()).toEqual(page.items.map(p => p.id).sort());
  });
  it('rotates active prompts across occurrences and freezes the reserved prompt', async () => {
    const project = await save();
    const first = await repository.reserveSocialOccurrence(input(project));
    const second = await repository.reserveSocialOccurrence(input(project, { scheduledAt: '2026-11-09T09:00:00Z', now: '2026-11-09T09:00:00Z' }));
    const third = await repository.reserveSocialOccurrence(input(project, { scheduledAt: '2026-11-16T09:00:00Z', now: '2026-11-16T09:00:00Z' }));
    if (first.status !== 'created' || second.status !== 'created' || third.status !== 'created') throw new Error('Expected occurrences');
    expect([first.occurrence.prompt.id, second.occurrence.prompt.id, third.occurrence.prompt.id]).toEqual(['p_01', 'p_02', 'p_01']);
    expect([first.occurrence.sequence, second.occurrence.sequence, third.occurrence.sequence]).toEqual([1, 2, 3]);
    project.prompts[0].text = 'Edited after reservation'; project.version++;
    await repository.saveProject(project, project.version - 1);
    expect((await repository.getSocialPublication(project.id, first.publications[0].id))?.prompt.text).toBe('First useful question?');
  });
  it('freezes one deterministic shared producer only when enabled, independently of destination order', async () => {
    const project = account(); project.socialAutomation!.shareFacebookInstagramContent = true; await save(project);
    const request = input(project, { destinations: ['instagram', 'facebook', 'x'].map(channel => destination(project, channel as 'instagram' | 'facebook' | 'x')) });
    const [first, replay] = await Promise.all([repository.reserveSocialOccurrence(request), repository.reserveSocialOccurrence({ ...request, destinations: [...request.destinations].reverse() })]);
    if (!('publications' in first) || !('publications' in replay)) throw new Error('Expected reserved publications');
    const facebook = first.publications.find(post => post.destination.channel === 'facebook')!;
    const instagram = first.publications.find(post => post.destination.channel === 'instagram')!;
    expect(facebook.sharedGeneration).toEqual(instagram.sharedGeneration);
    expect(facebook.sharedGeneration?.sourcePublicationId).toBe(facebook.id);
    expect(facebook.sharedGeneration?.memberPublicationIds).toHaveLength(2);
    expect(first.publications.find(post => post.destination.channel === 'x')?.sharedGeneration).toBeUndefined();
    expect(replay.publications.find(post => post.id === instagram.id)?.sharedGeneration).toEqual(instagram.sharedGeneration);
    const updated = { ...project, version: project.version + 1, socialAutomation: { ...project.socialAutomation!, shareFacebookInstagramContent: false } };
    await repository.saveProject(updated, project.version);
    expect((await repository.getSocialPublication(project.id, instagram.id))?.sharedGeneration).toEqual(instagram.sharedGeneration);
    const next = await repository.reserveSocialOccurrence({ ...request, scheduledAt: '2026-11-09T09:00:00Z', now: '2026-11-09T09:00:00Z' });
    if (!('publications' in next)) throw new Error('Expected next occurrence');
    expect(next.publications.every(post => !post.sharedGeneration)).toBe(true);
  });
  it('deduplicates the repeated fall hour using the local calendar occurrence', async () => {
    const project = account();
    project.socialAutomation!.timezone = 'America/New_York';
    project.socialAutomation!.slots = [{ id: 'sunday', dayOfWeek: 0, time: '01:30' }]; await save(project);
    const first = await repository.reserveSocialOccurrence(input(project, { slotId: 'sunday', scheduledAt: '2026-11-01T05:30:00Z', now: '2026-11-01T05:30:00Z' }));
    const second = await repository.reserveSocialOccurrence(input(project, { slotId: 'sunday', scheduledAt: '2026-11-01T06:30:00Z', now: '2026-11-01T06:30:00Z' }));
    expect(first.status).toBe('created'); expect(second.status).toBe('existing');
    expect((await repository.listSocialPublications(project.id, 0, 100)).total).toBe(1);
  });
  it('filters wrong-account, inactive and reconnect destinations and derives blog only from settings', async () => {
    const project = await save();
    const own = destination(project);
    const invalid = [ { ...own, id: 'foreign', profileId: 'other-account' }, { ...own, id: 'inactive', active: false },
      { ...own, id: 'expired', requiresReconnect: true }, { ...own, id: 'blog-draft', channel: 'blog' } ] as SocialDestination[];
    expect(await repository.reserveSocialOccurrence(input(project, { destinations: invalid }))).toEqual({ status: 'empty' });
    const result = await repository.reserveSocialOccurrence(input(project, { destinations: [own, own, ...invalid] }));
    if (result.status !== 'created') throw new Error('Expected occurrence');
    expect(result.publications).toHaveLength(1); expect(result.occurrence.sequence).toBe(1);
    expect(await repository.getSocialPublication('other-account', result.publications[0].id)).toBeNull();
    expect((await repository.listSocialPublications('other-account', 0, 100)).total).toBe(0);
  });
  it('creates blog drafts without social accounts and preserves their completed history when paused', async () => {
    const project = account({ socialProfileId: undefined }); project.socialAutomation!.createBlogDrafts = true; await save(project);
    const result = await repository.reserveSocialOccurrence(input(project, { destinations: [] }));
    if (result.status !== 'created') throw new Error('Expected blog occurrence');
    expect(result.publications.map(p => p.destination.channel)).toEqual(['blog']);
    const finished: SocialPublication = { ...result.publications[0], status: 'draft_created', draftPostId: 'saved-blog', version: 2 };
    expect(await repository.saveSocialPublication(finished, 1)).toBe(true);
    project.socialAutomation!.enabled = false; project.socialAutomation!.revision++; project.version++;
    expect(await repository.saveProject(project, project.version - 1)).toBe(true);
    expect(await repository.reserveSocialOccurrence(input(project))).toEqual({ status: 'stale' });
    expect((await repository.getSocialPublication(project.id, finished.id))?.draftPostId).toBe('saved-blog');
    expect((await repository.listActiveSocialPublications(1000)).some(p => p.id === finished.id)).toBe(false);
  });
  it('requires an active prompt and uses compare-and-swap for publication leases', async () => {
    const inactive = account(); inactive.prompts.forEach(prompt => { prompt.active = false; }); await save(inactive);
    expect(await repository.reserveSocialOccurrence(input(inactive))).toEqual({ status: 'empty' });
    const project = await save(); const result = await repository.reserveSocialOccurrence(input(project));
    if (result.status !== 'created') throw new Error('Expected occurrence');
    const next = { ...result.publications[0], status: 'generating' as const, version: 2, leaseUntil: '2026-11-02T09:04:00Z' };
    const claims = await Promise.all(['worker-a', 'worker-b'].map(leaseOwner => repository.saveSocialPublication({ ...next, leaseOwner }, 1)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await repository.saveSocialPublication({ ...next, version: 3, occurrenceId: 'other-occurrence' }, 2)).toBe(false);
    await expect(repository.saveSocialPublication({ ...next, version: 5 }, 2)).rejects.toThrow('version');
  });
  it('reserves future batch slots once and rejects slots outside the preparation period', async () => {
    const project = account();
    Object.assign(project.socialAutomation!, { generationCadence: 'weekly', slots: [{ id: 'friday', dayOfWeek: 5, time: '09:00' }] });
    await save(project);
    const request = input(project, { slotId: 'friday', scheduledAt: '2026-11-06T09:00:00Z', now: '2026-11-04T10:00:00Z',
      generationScheduledAt: '2026-11-04T10:00:00Z', generationTrigger: 'manual' });
    const first = await repository.reserveSocialOccurrence(request);
    expect(first.status).toBe('created');
    const second = await repository.reserveSocialOccurrence({ ...request, now: '2026-11-05T10:00:00Z', generationScheduledAt: '2026-11-05T10:00:00Z' });
    expect(second.status).toBe('existing');
    expect((await repository.listSocialPublications(project.id, 0, 100)).total).toBe(1);
    expect(await repository.reserveSocialOccurrence({ ...request, scheduledAt: '2026-11-13T09:00:00Z' })).toEqual({ status: 'stale' });
  });
  it('keeps far-future approved posts from starving due work at the active query limit', async () => {
    const project = await save();
    const reserved = await repository.reserveSocialOccurrence(input(project, { destinations: SOCIAL_CHANNELS.slice(0, 3).map(channel => destination(project, channel)) }));
    if (reserved.status !== 'created') throw new Error('Expected occurrence');
    for (const [index, post] of reserved.publications.entries()) await repository.saveSocialPublication({ ...post, version: 2, status: 'scheduled',
      updatedAt: index < 2 ? '2000-01-01T00:00:00Z' : '2001-01-01T00:00:00Z',
      nextAttemptAt: index < 2 ? '2026-12-01T09:00:00Z' : monday }, 1);
    const active = await repository.listActiveSocialPublications(1, monday);
    expect(active.map(post => post.id)).toEqual([reserved.publications[2].id]);
  });
});
