import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SOCIAL_CHANNELS, defaultSocialAutomationSettings, socialAutomationInputSchema, socialOccurrenceLocalDate, socialSlotCron,
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
});
