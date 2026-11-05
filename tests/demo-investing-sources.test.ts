import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Page, PromptResult, ResponseDetail, SourceRow } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';
import { testIdentity } from './fixtures/users.js';

it('paginates the investing catalog and traces a searched publication to the source in its answer', async () => {
  const now = () => new Date('2026-11-05T12:00:00Z');
  const source = JSON.parse(readFileSync(new URL('../scripts/demo-sources/etoro.json', import.meta.url), 'utf8'));
  const project = buildServiceDemo(source, now().toISOString());
  const repository = new MemoryRepository();
  const api = createApi({ repository, queue: new MemoryQueue(), artifacts: new MemoryArtifacts() }, { mode: 'live', now });
  const identity = testIdentity('demo-source-owner');
  await repository.saveProject(project, null);
  await repository.syncUser(identity);
  await repository.putMembership({ projectId: project.id, userId: identity.subject, role: 'owner' });
  const get = async <T,>(path: string): Promise<T> => {
    const response = await api(new Request(`https://test/v1/projects/${project.id}/${path}`), identity);
    expect(response.status).toBe(200);
    return response.json();
  };
  const first = await get<Page<SourceRow>>('sources?limit=10&page=0');
  expect(first.total).toBeGreaterThan(1152);
  expect(first.items).toHaveLength(10);
  const numbered = await get<Page<SourceRow>>('sources?limit=10&page=1');
  expect(numbered).toEqual(await get<Page<SourceRow>>(`sources?limit=10&cursor=${first.nextCursor}`));
  expect(numbered.items.some(row => first.items.some(item => row.id === item.id))).toBe(false);
  const last = await get<Page<SourceRow>>(`sources?limit=10&page=${Math.ceil(first.total / 10) - 1}`);
  expect(last.nextCursor).toBeNull();
  expect(last.items.length).toBe((first.total - 1) % 10 + 1);

  const domain = 'edinburgh-etf-weekly.example';
  for (const kind of ['cited', 'consulted']) {
    const search = await get<Page<SourceRow>>(`sources?kind=${kind}&q=${domain}&owned=false`);
    expect(search.items.map(row => row.domain)).toEqual([domain]);
    const pages = await get<Page<SourceRow>>(`sources?kind=${kind}&groupBy=url&domain=${domain}`);
    const page = pages.items[0];
    expect(page.title).toContain('Edinburgh ETF Weekly');
    const answers = await get<Page<PromptResult>>(`sources/${page.id}/responses`);
    expect(answers.items.map(row => row.responseId)).toEqual(page.responseIds);
    const detail = await get<ResponseDetail>(`responses/${encodeURIComponent(answers.items[0].responseId)}`);
    const evidence = kind === 'cited' ? detail.answer?.citations : detail.answer?.sources;
    expect(evidence?.some(row => row.url === page.url && row.title === page.title)).toBe(true);
    expect(detail.result.citationCount).toBe(detail.answer?.citations.length);
  }
  const owned = await get<Page<SourceRow>>('sources?owned=true');
  expect(owned.items.map(row => row.domain)).toEqual(['etoro.com']);
});
