import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MemoryRepository } from '@citevia/storage';
import { newProject } from './fixtures/scanner.js';
import { buildServiceDemo, expandServiceDemoTracking, restoreServiceReporting, syncBrooklinenReporting, syncEquinoxeReporting,
  syncAllAmericanGutterReporting, syncFreedomPowerReporting, syncWindowWorksReporting,
  syncAcmeLocksmithReporting, syncSerhantReporting, syncTendDentalReporting, syncEsteperaReporting, syncFourSeasonsReporting, syncKanTorReporting, syncPacificFertilityReporting, syncServiceDemoReporting, type ServiceDemoSource } from '../scripts/create-service-demo.js';

const source = JSON.parse(readFileSync(new URL('../scripts/demo-sources/etoro.json', import.meta.url), 'utf8'));

it('upgrades only the matching demo and preserves enrollments across retries', async () => {
  const project = buildServiceDemo({ ...source, reportingProfile: undefined });
  const repository = new MemoryRepository();
  await repository.saveProject(project, null);
  const saved = (await repository.getProject(source.id))!;
  const enrollments = saved.demo!.trackedUrls!.map(row => [row.url, row.createdAt, row.sourcePublishedAt]);
  expect((await syncServiceDemoReporting(repository, source)).status).toBe('preview');
  expect(await repository.getProject(source.id)).toEqual(saved);
  expect(await syncServiceDemoReporting(repository, source, true)).toMatchObject({ status: 'updated', trackedUrls: 72 });
  const upgraded = (await repository.getProject(source.id))!;
  expect(upgraded.demo!.trackedUrls!.map(row => [row.url, row.createdAt, row.sourcePublishedAt])).toEqual(enrollments);
  expect(upgraded.demo!.reportingProfile).toBe('uk_investing');
  expect((await syncServiceDemoReporting(repository, source, true)).status).toBe('unchanged');
  expect(await repository.getProject(source.id)).toEqual(upgraded);
  await expect(syncServiceDemoReporting(repository, { ...source, anchorDate: '2026-11-06' }, true)).rejects.toThrow('matching');
  await expect(syncServiceDemoReporting({ getProject: async () => ({ ...saved, demo: undefined }), saveProject: async () => true }, source, true)).rejects.toThrow('matching');
  await expect(syncServiceDemoReporting({ getProject: async () => saved, saveProject: async () => false }, source, true)).rejects.toThrow('concurrently');
});

it('upgrades the existing merchant reporting year once and keeps the saved account and every enrolled page', async () => {
  const payments = JSON.parse(readFileSync(new URL('../scripts/demo-sources/payabl.json', import.meta.url), 'utf8'));
  const old = buildServiceDemo({ ...payments, anchorDate: '2026-10-28', reportingProfile: undefined,
    publicationAlignment: undefined, blogs: payments.blogs.slice(0, 15), socialLinks: [] });
  old.prompts[0].topic = 'Saved merchant topic';
  const repo = new MemoryRepository();
  await repo.saveProject(old, null);
  expect((await syncServiceDemoReporting(repo, payments)).status).toBe('preview');
  expect((await repo.getProject(old.id))?.version).toBe(old.version);
  await expect(syncServiceDemoReporting(repo, { ...payments, blogs: payments.blogs.slice(1) }, true))
    .rejects.toThrow('previously enrolled');
  expect((await syncServiceDemoReporting(repo, payments, true)).status).toBe('updated');
  const saved = (await repo.getProject(old.id))!;
  expect(saved.prompts).toEqual(old.prompts);
  expect(saved.brandbook).toEqual(old.brandbook);
  expect(saved.demo).toMatchObject({ reportingProfile: 'merchant_payments', anchorDate: payments.anchorDate, publicationAlignment: 'scans',
    profile: payments.profile, traffic: payments.traffic });
  expect(saved.demo!.trackedUrls!.map(row => row.url)).toEqual(expect.arrayContaining(old.demo!.trackedUrls!.map(row => row.url)));
  expect(saved.demo!.trackedUrls!.length).toBe(payments.blogs.length + payments.socialLinks.length);
  expect((await syncServiceDemoReporting(repo, payments, true)).status).toBe('unchanged');
  expect((await repo.getProject(old.id))?.version).toBe(saved.version);
});

const selected = [
  { slug: 'serhant', source: 'business', id: 'account_serhant_demo_v1', profile: 'luxury_real_estate', sync: syncSerhantReporting },
  { slug: 'tend-dental', source: 'medical', id: 'account_tend_nyc_demo_v1', profile: 'dental_care', sync: syncTendDentalReporting },
  { slug: 'four-seasons', source: 'luxury', id: 'account_four_seasons_firenze_demo_v1', profile: 'luxury_hospitality', sync: syncFourSeasonsReporting },
  { slug: 'kan-tor', source: 'business', id: 'account_kan_tor_acco_demo_v1', profile: 'immigration_law', sync: syncKanTorReporting },
  { slug: 'pacific-fertility', source: 'medical', id: 'account_pfcla_la_demo_v1', profile: 'fertility_care', sync: syncPacificFertilityReporting },
  { slug: 'brooklinen', source: 'business', id: 'account_brooklinen_demo_v1', profile: 'home_bedding', sync: syncBrooklinenReporting },
  { slug: 'equinoxe', source: 'luxury', id: 'account_equinoxe_yachts_demo_v1', profile: 'yacht_chartering', sync: syncEquinoxeReporting },
  { slug: 'estepera', source: 'medical', id: 'account_estepera_demo_v1', profile: 'hair_restoration', sync: syncEsteperaReporting },
] as const;

it.each(selected)('preserves and can restore the selected $slug import with optimistic concurrency', async target => {
  const sources: ServiceDemoSource[] = JSON.parse(readFileSync(new URL(`../scripts/demo-sources/${target.source}.json`, import.meta.url), 'utf8'));
  const source = sources.find(item => item.id === target.id)!;
  const previous = buildServiceDemo(source);
  const repo = new MemoryRepository();
  const anchor = '2026-11-05', now = new Date(`${anchor}T19:00:00Z`);
  const catalog = {
    blogs: [{ url: new URL('/new-article', source.website).href, title: 'Additional article', sourcePublishedAt: '2026-11-04T15:15:15Z' },
      { url: previous.demo!.trackedUrls![0].url, title: 'Verified existing article', sourcePublishedAt: '2027-01-01T09:00:00Z' }],
    socialLinks: [{ url: 'https://www.youtube.com/watch?v=aBcdEfgHiJ1', title: 'New video' }], sources: source.sources,
  };
  await repo.saveProject(previous, null);
  const before = (await repo.getProject(previous.id))!;
  expect((await target.sync(repo, catalog, false, now, anchor)).status).toBe('preview');
  expect(await repo.getProject(previous.id)).toEqual(before);
  expect((await target.sync(repo, catalog, true, now, anchor)).status).toBe('updated');
  const after = (await repo.getProject(previous.id))!;
  expect(after.demo).toMatchObject({ reportingProfile: target.profile, startDate: '2026-05-05', endDate: '2027-05-05' });
  expect({ ...after, version: before.version, updatedAt: before.updatedAt, demo: before.demo }).toEqual(before);
  const config = after.demo!, original = before.demo!;
  const { trackedUrls, referenceSources, reportingProfile, publicationAlignment, sourcePublicationDates, ...savedFields } = config;
  expect(sourcePublicationDates).toEqual({ [original.trackedUrls![0].url]: '2027-01-01T09:00:00.000Z' });
  expect(referenceSources?.length).toBeGreaterThan(0);
  expect(reportingProfile).toBe(target.profile);
  expect(publicationAlignment).toBe('scans');
  expect({ ...savedFields, startDate: original.startDate, endDate: original.endDate,
    anchorDate: original.anchorDate, trackedUrls: original.trackedUrls }).toEqual(original);
  expect(trackedUrls!.slice(0, original.trackedUrls!.length)).toEqual(original.trackedUrls);
  const added = trackedUrls!.find(row => row.url === catalog.blogs[0].url)!;
  expect(added.publishedAt >= added.sourcePublishedAt!).toBe(true);
  expect(added.createdAt! >= added.sourcePublishedAt!).toBe(true);
  expect((await target.sync(repo, catalog, true, new Date('2027-01-01'))).status).toBe('unchanged');
  await expect(expandServiceDemoTracking(repo, source, true)).rejects.toThrow('selected account');
  const neverWrite = async () => { throw new Error('Unexpected write'); };
  for (const foreign of [{ ...before, id: 'account_other' }, { ...before, enabled: true },
    { ...before, brand: { ...before.brand, domains: ['foreign.org'] } }, { ...before, brand: { ...before.brand, name: 'Other' } },
    { ...before, demo: { ...original, reportingProfile: 'merchant_payments' as const } }])
    await expect(target.sync({ getProject: async () => foreign, saveProject: neverWrite }, catalog, true)).rejects.toThrow('matching disabled');
  await expect(target.sync({ getProject: async () => before, saveProject: async () => false }, catalog, true)).rejects.toThrow('concurrently');

  expect((await restoreServiceReporting(repo, target.slug, catalog, before)).status).toBe('preview');
  expect(await repo.getProject(previous.id)).toEqual(after);
  await expect(restoreServiceReporting(repo, target.slug, { ...catalog, socialLinks: [] }, before, true)).rejects.toThrow('reproduce');
  await expect(restoreServiceReporting({ getProject: async () => ({ ...after, version: after.version + 1 }), saveProject: neverWrite },
    target.slug, catalog, before, true)).rejects.toThrow('latest');
  await expect(restoreServiceReporting({ getProject: async () => after, saveProject: async () => false }, target.slug, catalog, before, true))
    .rejects.toThrow('concurrently');
  expect((await restoreServiceReporting(repo, target.slug, catalog, before, true, now)).status).toBe('restored');
  expect(await repo.getProject(previous.id)).toEqual({ ...before, updatedAt: now.toISOString(), version: before.version + 2 });
  expect((await restoreServiceReporting(repo, target.slug, catalog, before, true)).status).toBe('unchanged');
});

it.each([
  { slug: 'acme-locksmith', id: 'account_acme_locksmith_demo_v1', name: 'ACME Locksmith', domain: 'acmelocksmith.com', count: 65, upgrade: syncAcmeLocksmithReporting },
  { slug: 'all-american-gutter', id: 'account_all_american_gutter_demo_v1', name: 'All American Gutter Protection', domain: 'allamericangutterprotection.com', count: 43, upgrade: syncAllAmericanGutterReporting },
  { slug: 'freedom-power', id: 'account_freedom_power_demo_v1', name: 'Freedom Power', domain: 'gofreedompower.com', count: 35, upgrade: syncFreedomPowerReporting },
  { slug: 'window-works', id: 'account_windowworks_demo_v1', name: 'WindowWorks', domain: 'mywindowworks.com', count: 128, upgrade: syncWindowWorksReporting },
] as const)('merges the $name catalog into existing article history and restores the previous version', async ({ slug, id, name, domain, count, upgrade }) => {
  const repo = new MemoryRepository();
  const content = JSON.parse(readFileSync(new URL(`../scripts/${slug}-content.json`, import.meta.url), 'utf8'));
  const now = new Date('2026-11-05T12:00:00Z');
  const original = newProject({ id, name, brand: name, domain, prompts: [`What services does ${name} offer?`] });
  const originalArticles = content.blogs.slice(0, count);
  original.enabled = false;
  original.demo = { version: 1, source: 'website-demo', sourceAccountId: `website:${domain}`, sourceCopiedAt: now.toISOString(),
    startDate: '2026-04-25', endDate: '2027-04-25', anchorDate: '2026-10-25',
    trackedUrls: originalArticles.map(({ url, title }: { url: string; title: string }) => ({ url, title, publishedAt: '2026-04-27T08:00:00.000Z' })) };
  expect(originalArticles).toHaveLength(count);
  await repo.saveProject(original, null);
  const saved = (await repo.getProject(original.id))!;
  expect((await upgrade(repo, content, false, now)).status).toBe('preview');
  const updated = await upgrade(repo, content, true, now);
  expect(updated.status).toBe('updated');
  expect((await repo.getProject(original.id))?.demo?.trackedUrls?.slice(0, originalArticles.length)).toEqual(saved.demo?.trackedUrls);
  expect((await upgrade(repo, content, true, now)).status).toBe('unchanged');
  expect((await restoreServiceReporting(repo, slug, content, saved, true, now)).status).toBe('restored');
  expect(await repo.getProject(original.id)).toEqual({ ...saved, version: saved.version + 2, updatedAt: now.toISOString() });
});
