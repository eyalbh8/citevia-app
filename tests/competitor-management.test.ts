import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

async function setup(demo = false) {
  const repository = new MemoryRepository(), project = newProject();
  if (demo) {
    project.enabled = false;
    project.demo = { version: 1, source: 'igeo-nayax', sourceAccountId: 'fixture',
      sourceCopiedAt: '2026-10-25T00:00:00Z', anchorDate: '2026-10-25', startDate: '2026-04-25', endDate: '2027-04-25' };
  }
  await repository.saveProject(project, null);
  await repository.syncUser(testIdentity('viewer'));
  await repository.putMembership({ projectId: project.id, userId: 'viewer', role: 'viewer' });
  const syncSchedule = vi.fn();
  const api = createApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, { mode: 'live', syncSchedule });
  const patch = (body: unknown, user = 'viewer', route = 'competitors') => api(new Request(
    `https://test/v1/projects/${project.id}/${route}`, { method: 'PATCH', body: JSON.stringify(body) }), testIdentity(user));
  return { repository, project, patch, syncSchedule };
}
const competitor = { id: 'new-competitor', name: 'New competitor', aliases: ['Alternate name'], domains: ['https://www.competitor.com/path'] };

describe('account member competitor management', () => {
  it.each([false, true])('lets assigned viewers add and remove competitors, including demo=%s', async demo => {
    const { project, repository, patch, syncSchedule } = await setup(demo);
    const response = await patch({ version: project.version, competitors: [competitor] });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.competitors).toEqual([{ ...competitor, domains: ['competitor.com'] }]);
    expect(saved.role).toBe('viewer');
    expect(saved.enabled).toBe(project.enabled);
    expect(saved.scanSchedule).toEqual(project.scanSchedule);
    expect(saved.demo).toEqual(project.demo);
    expect(syncSchedule).not.toHaveBeenCalled();
    expect((await patch({ version: saved.version, competitors: [] })).status).toBe(200);
    expect((await repository.getProject(project.id))?.competitors).toEqual([]);
  });

  it('keeps other settings restricted and rejects extra fields, duplicate brands and stale versions', async () => {
    const { project, patch } = await setup();
    expect((await patch({ version: project.version, competitors: [] }, 'outsider')).status).toBe(404);
    expect((await patch({ version: project.version, enabled: false }, 'viewer', 'settings')).status).toBe(403);
    expect((await patch({ version: project.version, competitors: [], enabled: false })).status).toBe(400);
    expect((await patch({ version: project.version })).status).toBe(400);
    expect((await patch({ version: project.version, competitors: [{ ...competitor, name: project.brand.name }] })).status).toBe(400);
    expect((await patch({ version: project.version, competitors: Array(6).fill(competitor) })).status).toBe(400);
    expect((await patch({ version: project.version + 1, competitors: [] })).status).toBe(409);
  });
});
