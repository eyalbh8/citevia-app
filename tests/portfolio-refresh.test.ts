import { describe, expect, it, vi } from 'vitest';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { newProject } from './fixtures/scanner.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { policyJob } from './fixtures/onboarding-job.js';
import { refreshPortfolio } from '../apps/scanner/src/portfolio-refresh.js';

async function setup() {
  const runtime = {
    repository: new MemoryRepository(),
    artifacts: new MemoryArtifacts(),
    queue: new MemoryQueue(),
  };
  const fixture = new FixtureOnboardingProvider(),
    project = newProject({
      id: 'policy-account',
      brand: 'Acme',
      domain: 'acme.com',
    });
  project.brandbook = (await fixture.brandbook(policyJob())).brandbook;
  await runtime.repository.saveProject(project, null);
  return { ...runtime, runtime, project, fixture };
}
describe('saved-brandbook portfolio refresh', () => {
  it('replaces only prompt versions on the same account, preserves frozen reports and never scans', async () => {
    const f = await setup(),
      original = structuredClone(f.project);
    const prompts = vi.fn(f.fixture.prompts.bind(f.fixture));
    await refreshPortfolio(
      f.runtime,
      { prompts },
      f.project.id,
      'refresh-request',
    );
    const updated = (await f.repository.getProject(f.project.id))!;
    expect(updated.id).toBe(original.id);
    expect(updated.brandbook).toEqual(original.brandbook);
    expect(updated.enabled).toBe(original.enabled);
    expect(updated.prompts.filter((p) => p.active)).toHaveLength(50);
    expect(updated.prompts[0]).toMatchObject({
      id: original.prompts[0].id,
      version: 2,
    });
    expect(original.prompts[0].version).toBe(1);
    expect(f.queue.messages).toHaveLength(0);
    expect(await f.repository.listRuns(f.project.id)).toHaveLength(0);
    await refreshPortfolio(
      f.runtime,
      { prompts },
      f.project.id,
      'refresh-request',
    );
    expect(prompts).toHaveBeenCalledOnce();
  });
  it('stops on generation failure and never repeats a paid call for the same request', async () => {
    const f = await setup(),
      prompts = vi.fn(async () => {
        throw new Error('Provider failed');
      });
    await expect(
      refreshPortfolio(f.runtime, { prompts }, f.project.id, 'failed-request'),
    ).rejects.toThrow('Provider failed');
    expect((await f.repository.getProject(f.project.id))?.prompts).toEqual(
      f.project.prompts,
    );
    await expect(
      refreshPortfolio(f.runtime, { prompts }, f.project.id, 'failed-request'),
    ).rejects.toThrow('duplicate charges');
    expect(prompts).toHaveBeenCalledOnce();
  });
  it('reuses a saved generation after applying it loses a conditional-write race', async () => {
    const f = await setup(),
      prompts = vi.fn(f.fixture.prompts.bind(f.fixture));
    const save = f.repository.saveProject.bind(f.repository);
    let conflict = true;
    vi.spyOn(f.repository, 'saveProject').mockImplementation(
      async (project, version) => {
        if (conflict && project.portfolioRefresh?.status === 'completed') {
          conflict = false;
          return false;
        }
        return save(project, version);
      },
    );
    await expect(
      refreshPortfolio(
        f.runtime,
        { prompts },
        f.project.id,
        'checkpoint-request',
      ),
    ).rejects.toThrow('retry the same request ID');
    await refreshPortfolio(
      f.runtime,
      { prompts },
      f.project.id,
      'checkpoint-request',
    );
    expect(prompts).toHaveBeenCalledOnce();
    expect(
      (await f.repository.getProject(f.project.id))?.portfolioRefresh?.status,
    ).toBe('completed');
  });
  it('fences concurrent requests and refuses stale generation after a prompt edit', async () => {
    const f = await setup();
    let finish!: (
      value: Awaited<ReturnType<FixtureOnboardingProvider['prompts']>>,
    ) => void;
    const generated = await f.fixture.prompts(
      policyJob(),
      f.project.brandbook!,
    );
    const prompts = vi.fn(
      () =>
        new Promise<typeof generated>((resolve) => {
          finish = resolve;
        }),
    );
    const inFlight = refreshPortfolio(
      f.runtime,
      { prompts },
      f.project.id,
      'concurrent-request',
    );
    await vi.waitFor(() => expect(prompts).toHaveBeenCalledOnce());
    await expect(
      refreshPortfolio(
        f.runtime,
        { prompts },
        f.project.id,
        'concurrent-request',
      ),
    ).rejects.toThrow('duplicate charges');
    const latest = (await f.repository.getProject(f.project.id))!;
    latest.prompts[0].text = 'A manual edit during generation?';
    await f.repository.saveProject(
      { ...latest, version: latest.version + 1 },
      latest.version,
    );
    finish(generated);
    await expect(inFlight).rejects.toThrow('changed during generation');
    expect((await f.repository.getProject(f.project.id))?.prompts[0].text).toBe(
      'A manual edit during generation?',
    );
    expect(prompts).toHaveBeenCalledOnce();
  });
});
