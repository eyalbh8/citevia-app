import { describe, expect, it, vi } from 'vitest';
import type { DemoConfig } from '@citevia/core';
import { MemoryRepository } from '@citevia/storage';
import { buildNayaxDemo } from '../scripts/create-nayax-demo.js';
import { buildServiceDemo, type ServiceDemoSource } from '../scripts/create-service-demo.js';
import { refreshNayaxContent, runRefreshNayaxContentCli } from '../scripts/refresh-nayax-content.js';

const now = () => new Date('2026-10-28T12:00:00.000Z');
const source = (): ServiceDemoSource => ({
  id: 'account_nayax_demo_v1', name: 'Nayax', website: 'https://www.nayax.com/', country: 'US',
  anchorDate: '2026-10-23', industry: 'Cashless payments', serviceArea: 'global unattended retail',
  description: 'Nayax provides cashless payments and operational management for unattended retail.',
  services: ['Cashless payments', 'Vending management', 'Telemetry', 'Consumer engagement', 'Payment processing'],
  audience: ['Unattended retail operators'], criteria: ['Payment acceptance', 'Remote management', 'Integration coverage'],
  competitors: ['cantaloupe', 'cranepi', 'ingenico', 'payrange', '365retailmarkets'].map(name => ({ name, website: `https://${name}.com/` })),
  sources: [
    { url: 'https://www.nayax.com/', kind: 'official' },
    { url: 'https://www.nasdaq.com/market-activity/stocks/nyax', kind: 'independent' },
  ],
  blogs: [
    { url: 'https://www.nayax.com/blog/payment-system-for-vending-business/', title: 'Choosing a Payment System', sourcePublishedAt: '2025-01-01' },
    { url: 'https://www.nayax.com/blog/vending-machine-inventory-management/', title: 'Vending Machine Inventory Management' },
  ],
});

function account() {
  const value = source();
  const project = buildNayaxDemo({
    brand: { name: 'Nayax', aliases: ['Nayax Ltd.'], domains: ['nayax.com'] },
    competitors: value.competitors.map(brand => ({ name: brand.name, aliases: [], domains: [new URL(brand.website).hostname] })),
    prompts: Array.from({ length: 50 }, (_, index) => ({ text: `Which payment platform fits unattended retail use case ${index + 1}?` })),
    brandbook: { about: value.description, companyCountry: 'US', language: 'en' },
  }, '2026-10-23', '2026-10-23T12:00:00.000Z');
  return {
    ...project, version: 3, name: 'Nayax', extractionModel: 'gemini-3.8-flash',
    generationModel: 'saved-generation-model', prompts: project.prompts.map(prompt => ({ ...prompt, tags: ['Priority'] })),
    scanProviders: [{ provider: 'openai' as const, model: 'saved-openai-model' }],
  };
}

describe('scoped Nayax publication refresh', () => {
  it('previews the complete saved-year catalog without modifying account data', async () => {
    const repository = new MemoryRepository(), existing = account();
    await repository.saveProject(existing, null);
    const save = vi.spyOn(repository, 'saveProject');
    const report = await refreshNayaxContent(repository, source(), false, now());
    expect(report).toMatchObject({ status: 'preview', expectedVersion: 3, nextVersion: 4, trackedUrls: 157,
      officialArticles: 2, demoArticles: 155, startDate: '2026-04-23', endDate: '2027-04-23', paidCalls: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(await repository.getProject(existing.id)).toEqual(existing);
  });

  it('updates only the catalog and version metadata, then performs no write when repeated', async () => {
    const repository = new MemoryRepository(), existing = account();
    await repository.saveProject(existing, null);
    const unrelated = { ...existing, id: 'another-account' };
    await repository.saveProject(unrelated, null);
    const save = vi.spyOn(repository, 'saveProject'), createRun = vi.spyOn(repository, 'createRun');
    const report = await refreshNayaxContent(repository, source(), true, now());
    const trackedUrls: NonNullable<DemoConfig['trackedUrls']> = JSON.parse(JSON.stringify(buildServiceDemo(source(), now().toISOString()).demo!.trackedUrls!));
    const expected = { ...existing, version: 4, updatedAt: now().toISOString(), demo: { ...existing.demo!, trackedUrls } };
    expect(report.status).toBe('updated');
    expect(save).toHaveBeenCalledExactlyOnceWith(expected, 3);
    expect(await repository.getProject(existing.id)).toEqual(expected);
    expect(await repository.getProject(unrelated.id)).toEqual(unrelated);
    expect(trackedUrls[0].publishedAt).toBe('2026-04-24T08:00:00.000Z');
    expect(trackedUrls.at(-1)!.publishedAt).toBe('2027-04-23T08:00:00.000Z');
    expect(trackedUrls.every(article => [1, 3, 5].includes(new Date(article.publishedAt).getUTCDay()))).toBe(true);
    expect(trackedUrls.filter(article => article.demoPost).every(article =>
      article.url.startsWith(`https://app.citevia.io/demo-content/${existing.id}/`) && article.provenance?.kind === 'demo-draft')).toBe(true);
    save.mockClear();
    expect(await refreshNayaxContent(repository, source(), true, new Date('2026-10-29T12:00:00.000Z'))).toMatchObject({ status: 'unchanged', expectedVersion: 4, nextVersion: 4 });
    expect(save).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(await repository.listRuns(existing.id)).toEqual([]);
    expect(await repository.listTrackedUrls(existing.id)).toEqual([]);
    expect(await repository.listTrackingMatches(existing.id)).toEqual([]);
  });

  it.each([
    ['real account', { demo: undefined }],
    ['other source', { demo: { ...account().demo!, source: 'website-demo' as const } }],
    ['other source identity', { demo: { ...account().demo!, sourceAccountId: 'other' } }],
    ['enabled scenario', { enabled: true }],
    ['another brand', { brand: { ...account().brand, name: 'Other' } }],
  ])('rejects an unexpected existing identity: %s', async (_, change) => {
    const repository = new MemoryRepository(), existing = { ...account(), ...change };
    await repository.saveProject(existing, null);
    const save = vi.spyOn(repository, 'saveProject');
    await expect(refreshNayaxContent(repository, source(), true, now())).rejects.toThrow('expected disabled Nayax scenario identity');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a missing account and source or timeline mismatches without writes', async () => {
    const repository = new MemoryRepository(), existing = account();
    await expect(refreshNayaxContent(repository, source())).rejects.toThrow('expected disabled Nayax scenario identity');
    await repository.saveProject(existing, null);
    const save = vi.spyOn(repository, 'saveProject');
    for (const invalid of [null, [source()], { ...source(), id: 'account_other_demo_v1' },
      { ...source(), anchorDate: undefined }, { ...source(), anchorDate: '2026-10-28' }])
      await expect(refreshNayaxContent(repository, invalid, true, now())).rejects.toThrow('existing account ID and explicit saved anchorDate');
    await expect(refreshNayaxContent(repository, { ...source(), name: 'Other' }, true, now())).rejects.toThrow('use nayax.com');
    await expect(refreshNayaxContent(repository, { ...source(), website: 'https://other.com/', blogs: [{ url: 'https://other.com/blog/post/', title: 'Post' }] }, true, now())).rejects.toThrow('use nayax.com');
    await repository.saveProject({ ...existing, demo: { ...existing.demo!, endDate: '2027-04-22' }, version: 4 }, 3);
    save.mockClear();
    await expect(refreshNayaxContent(repository, source(), true, now())).rejects.toThrow('preserve the saved scenario timeline');
    expect(save).not.toHaveBeenCalled();
  });

  it('enforces compact storage and rejects concurrent account changes', async () => {
    const repository = new MemoryRepository(), existing = account();
    await repository.saveProject({ ...existing, brandbook: { ...existing.brandbook!, about: 'a'.repeat(250000) } }, null);
    const save = vi.spyOn(repository, 'saveProject');
    await expect(refreshNayaxContent(repository, source(), true, now())).rejects.toThrow('exceeds 250 KB');
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
    const otherRepository = new MemoryRepository();
    await otherRepository.saveProject(existing, null);
    const conflict = vi.spyOn(otherRepository, 'saveProject').mockResolvedValue(false);
    await expect(refreshNayaxContent(otherRepository, source(), true, now())).rejects.toThrow('changed concurrently');
    expect(conflict).toHaveBeenCalledOnce();
    expect(await otherRepository.getProject(existing.id)).toEqual(existing);
  });

  it('documents a read-only CLI default and validates arguments before opening a database', async () => {
    const open = vi.fn();
    expect(await runRefreshNayaxContentCli(['--help'], open)).toContain('Defaults to a read-only preview');
    await expect(runRefreshNayaxContentCli([], open)).rejects.toThrow('Supply --source');
    await expect(runRefreshNayaxContentCli(['--source', '/unused', '--mode', 'other'], open)).rejects.toThrow('choose --mode local|aws');
    expect(open).not.toHaveBeenCalled();
  });
});
