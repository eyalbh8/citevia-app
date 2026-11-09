import { describe, it, expect, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { OnboardingOutputError } from '../apps/scanner/src/onboarding-provider.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { verifiedBrandNames } from '../apps/scanner/src/onboarding-evidence.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { testIdentity } from './fixtures/users.js';

function rejected() {
  const draft = { understand: { unbranded: [{text: 'Which providers serve small teams?', intent: 'discovery'}] } };
  return new OnboardingOutputError(new ProviderError('onboarding_duplicate_prompts', 'Questions repeat.', false),
    { response: { status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(draft)}]}] },
      requestId: 'test-response', receivedAt: new Date().toISOString() });
}

async function atPrompts() {
  const runtime = { repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
  await runtime.repository.syncUser(testIdentity('owner'));
  const { items: [item] } = await createAccounts(runtime, 'owner', 'recover-portfolio',
    { accounts: [{ name: 'Acme', website: 'https://acme.com', region: 'US', language: 'en', promptFocus: 'Consulting' }] }, new Date(), 10);
  const provider = new FixtureOnboardingProvider();
  const engine = new OnboardingEngine(runtime, provider, async () => {});
  const work = () => engine.handle(item.project.id, item.job.id);
  const saved = () => runtime.repository.getOnboarding(item.project.id, item.job.id);
  await work();
  await work();
  return { runtime, provider, item, saved, work };
}

describe('onboarding portfolio corrections', () => {
  it('preserves focus and research, then runs a new revision after a completed quality rejection', async () => {
    const { provider, saved, work, item } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValueOnce(rejected());
    expect(item.project.promptFocus).toBe('Consulting');
    const first = await saved();
    await work();
    expect(await saved()).toMatchObject({ status: 'queued', step: 'prompts', portfolioRevision: 1, portfolioFeedback: { code: 'onboarding_duplicate_prompts' } });
    await Promise.all([work(), work()]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({portfolioRevision: 1}),
      expect.anything(), expect.anything(),
      [{stage: 'understand', group: 'unbranded', text: 'Which providers serve small teams?', intent: 'discovery'}]);
    expect(generate.mock.calls[1][0].input.promptFocus).toBe('Consulting');
    expect(await saved()).toMatchObject({ step: 'activate', brandbookKey: first?.brandbookKey, researchKey: first?.researchKey });
    expect((await saved())?.promptsKey).toMatch(/prompts-revision-1\.json$/);
  });

  it('bounds paid revisions and keeps the account paused if every complete response fails', async () => {
    const { provider, saved, work, item, runtime } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValue(rejected());
    for (let i = 0; i < 5; i++) await work();
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await saved()).toMatchObject({ status: 'failed', step: 'prompts', automaticPortfolioCorrections: 2 });
    expect((await runtime.repository.getProject(item.project.id))?.enabled).toBe(false);
  });

  it('does not spend again if the rejected response could not be saved', async () => {
    const { provider, saved, work, runtime } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValue(rejected());
    vi.spyOn(runtime.artifacts, 'put').mockRejectedValueOnce(new Error('Storage unavailable'));
    await work();
    await work();
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await saved())?.status).toBe('failed');
  });

  it('only adds alternative names supported by name evidence from the supplied business website', () => {
    const names = verifiedBrandNames('Acme Group', 'https://www.acme.com', {
      names: ['Acme Studio', 'Acme Service', 'E2 Visa', 'Fake Limited'],
      evidence: [
        { field: 'names', quote: 'Our former name was Acme Studio.', url: 'https://acme.com/about' },
        { field: 'keyFeatures', quote: 'An E2 Visa and Acme Service are available.', url: 'https://acme.com/services' },
        { field: 'names', quote: 'Trading as Fake Limited.', url: 'https://acme.com.other.org' },
      ],
    });
    expect(names).toEqual(['Acme Group', 'Acme Studio']);
  });
});
