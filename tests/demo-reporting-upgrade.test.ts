import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MemoryRepository } from '@citevia/storage';
import { buildServiceDemo, syncServiceDemoReporting } from '../scripts/create-service-demo.js';

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
