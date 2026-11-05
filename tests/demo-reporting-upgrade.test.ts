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
