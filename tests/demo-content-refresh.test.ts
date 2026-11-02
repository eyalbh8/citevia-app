import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '@citevia/storage';
import { refreshDemoContent } from '../scripts/refresh-demo-content.js';
import { newProject } from './fixtures/scanner.js';

describe('official demo catalog refresh', () => {
  it('previews and prunes only the catalog, preserving official enrollment dates and scenario measurements', async () => {
    const repository = new MemoryRepository(), project = newProject({ domain: 'brand.com' });
    const article = { url: 'https://brand.com/blog/real', title: 'Official article', publishedAt: '2026-05-01T08:00:00Z' };
    project.enabled = false;
    project.demo = { version: 1, source: 'website-demo', sourceAccountId: 'website:brand.com', sourceCopiedAt: '2026-10-25T00:00:00Z',
      anchorDate: '2026-10-25', startDate: '2026-04-25', endDate: '2027-04-25',
      trackedUrls: [article, { ...article, url: 'https://app.citevia.io/demo-content/draft', demoPost: true },
        { ...article, url: 'https://brand.com/blog/broken' }, { ...article, url: 'https://brand.com.evil.com/forged' }] };
    await repository.saveProject(project, null);
    const urls = [article.url, 'https://brand.com.evil.com/forged'];
    expect(await refreshDemoContent(repository, project.id, urls)).toMatchObject({ status: 'preview', previousUrls: 4, trackedUrls: 1 });
    expect(await repository.getProject(project.id)).toEqual(project);
    expect(await refreshDemoContent(repository, project.id, urls, true)).toMatchObject({ status: 'updated' });
    const saved = (await repository.getProject(project.id))!;
    expect(saved.demo?.trackedUrls).toEqual([article]);
    expect({ ...saved, version: project.version, updatedAt: project.updatedAt, demo: project.demo }).toEqual(project);
    expect(await refreshDemoContent(repository, project.id, urls, true)).toMatchObject({ status: 'unchanged' });
    await expect(refreshDemoContent(repository, project.id, [], true)).rejects.toThrow('No verified official articles');
    await expect(refreshDemoContent({ getProject: async () => saved, saveProject: async () => false }, project.id, [article.url], true))
      .resolves.toMatchObject({ status: 'unchanged' });
  });

  it('refuses to change live accounts', async () => {
    const repository = new MemoryRepository(), project = newProject();
    await repository.saveProject(project, null);
    await expect(refreshDemoContent(repository, project.id, [], true)).rejects.toThrow('Only disabled demo');
  });
});
