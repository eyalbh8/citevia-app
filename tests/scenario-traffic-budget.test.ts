import { describe, expect, it, vi } from 'vitest';
import { publicReportId } from '@citevia/core';
import { MemoryRepository } from '@citevia/storage';
import { configureScenarioTraffic, runConfigureScenarioTrafficCli } from '../scripts/configure-scenario-traffic.js';
import budgets from '../scripts/scenario-traffic-budgets.json';
import { newProject } from './fixtures/scanner.js';

const now = new Date('2026-11-06T08:00:00.000Z');
function scenario() {
  const project = newProject({ id: 'account_windows_demo_v1', name: 'WindowWorks', domain: 'mywindowworks.com' });
  project.enabled = false;
  project.demo = { version: 1, source: 'website-demo', sourceAccountId: 'website:mywindowworks.com',
    sourceCopiedAt: '2026-10-25T00:00:00Z', startDate: '2026-05-05', anchorDate: '2026-11-05', endDate: '2027-05-05',
    profile: { trafficScale: .86, monthlyGrowth: .104, visibilityAdjustment: .01 },
    samples: [{ answerText: 'Preserved original answer.' }],
    trackedUrls: [{ url: 'https://www.mywindowworks.com/windows/', title: 'Windows', publishedAt: '2026-10-05T10:00:00Z' }],
    traffic: { countries: ['US'], pages: ['/', '/windows/'], devices: ['mobile', 'desktop'] } };
  return project;
}

describe('scoped scenario traffic configuration', () => {
  it('previews without writing, changes only two traffic settings and makes retries idempotent', async () => {
    const repository = new MemoryRepository(), project = scenario();
    await repository.saveProject(project, null);
    const saved = structuredClone(await repository.getProject(project.id));
    const save = vi.spyOn(repository, 'saveProject');
    const preview = await configureScenarioTraffic(repository, publicReportId(project.id), 550, .008, false, now);
    expect(preview.status).toBe('preview');
    expect(save).not.toHaveBeenCalled();
    expect(await repository.getProject(project.id)).toEqual(saved);
    const applied = await configureScenarioTraffic(repository, project.id, 550, .008, true, now);
    expect(applied.status).toBe('updated');
    const updated = await repository.getProject(project.id);
    expect(updated).toEqual({ ...saved, version: saved!.version + 1, updatedAt: now.toISOString(),
      demo: { ...saved!.demo!, traffic: { ...saved!.demo!.traffic, monthlyVisits: 550, monthlyGrowth: .008 } } });
    expect(save).toHaveBeenCalledWith(updated, saved!.version);
    const retry = await configureScenarioTraffic(repository, project.id, 550, .008, true, new Date(now.getTime() + 1000));
    expect(retry.status).toBe('unchanged');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await repository.getProject(project.id)).toEqual(updated);
  });

  it.each([[0, .01], [-1, .01], [1.5, .01], [100001, .01], [NaN, .01], [Infinity, .01],
    [500, -.01], [500, .251], [500, NaN], [500, Infinity]])('rejects invalid traffic budgets %s / %s before reading or writing', async (visits, growth) => {
    const repository = { getProject: vi.fn(), saveProject: vi.fn() };
    await expect(configureScenarioTraffic(repository, 'account', visits, growth, true)).rejects.toThrow('Choose integer');
    expect(repository.getProject).not.toHaveBeenCalled();
    expect(repository.saveProject).not.toHaveBeenCalled();
  });

  it('refuses missing, measured, enabled and reporting-only accounts', async () => {
    const selected = scenario();
    for (const project of [null, { ...selected, demo: undefined }, { ...selected, enabled: true },
      { ...selected, demo: { ...selected.demo!, presentation: { label: 'Visibility only', targetRank: 1, mentionCount: 50, reportingOnly: true as const } } }]) {
      const repository = { getProject: vi.fn().mockResolvedValue(project), saveProject: vi.fn() };
      await expect(configureScenarioTraffic(repository, selected.id, 550, .008, true)).rejects.toThrow('disabled scenario');
      expect(repository.saveProject).not.toHaveBeenCalled();
    }
  });

  it('reports a compare-and-swap conflict without silently overwriting a newer account', async () => {
    const project = scenario(), snapshot = structuredClone(project);
    const repository = { getProject: vi.fn().mockResolvedValue(project), saveProject: vi.fn().mockResolvedValue(false) };
    await expect(configureScenarioTraffic(repository, project.id, 550, .008, true, now)).rejects.toThrow('changed concurrently');
    expect(repository.saveProject).toHaveBeenCalledTimes(1);
    expect(repository.saveProject.mock.calls[0][1]).toBe(project.version);
    expect(project).toEqual(snapshot);
  });

  it('keeps the budget catalog unique and scopes CLI selection before opening a database', async () => {
    expect(new Set(budgets.map(row => row.id)).size).toBe(budgets.length);
    expect(budgets.every(row => Number.isSafeInteger(row.monthlyVisits) && row.monthlyVisits >= 1 && row.monthlyVisits <= 100000 && row.monthlyGrowth >= 0 && row.monthlyGrowth <= .25)).toBe(true);
    const open = vi.fn();
    await expect(runConfigureScenarioTrafficCli(['--project', 'not-a-listed-account', '--apply'], open)).rejects.toThrow('no configured traffic budget');
    expect(await runConfigureScenarioTrafficCli(['--help'], open)).toContain('Read-only preview');
    expect(open).not.toHaveBeenCalled();
  });
});
