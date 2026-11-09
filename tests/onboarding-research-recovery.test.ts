import { expect, it, vi } from 'vitest';
import type { CapturedAnswer } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { OnboardingOutputError } from '../apps/scanner/src/onboarding-provider.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { testIdentity } from './fixtures/users.js';

async function setup() {
  const runtime = {repository: new MemoryRepository(), queue: new MemoryQueue(), artifacts: new MemoryArtifacts()};
  await runtime.repository.syncUser(testIdentity('owner'));
  const {items: [item]} = await createAccounts(runtime, 'owner', 'research-check',
    {accounts: [{name: 'Acme', website: 'https://acme.com', region: 'IL', language: 'he'}]}, new Date(), 10);
  const provider = new FixtureOnboardingProvider();
  const worker = new OnboardingEngine(runtime, provider, async () => {});
  const work = () => worker.handle(item.project.id, item.job.id);
  const current = () => runtime.repository.getOnboarding(item.project.id, item.job.id);
  return {provider, work, current, runtime, item};
}

function invalid(code: string) {
  return new OnboardingOutputError(new ProviderError(code, 'Official evidence is missing.', false),
    {response: {status: 'completed'}, receivedAt: new Date().toISOString(), requestId: 'test'});
}

it('searches once more for competitors and retains the original evidence and localized buyer query', async () => {
  const {provider, work, current, runtime, item} = await setup();
  const template = await provider.brandbook(item.job);
  const book = vi.spyOn(provider, 'brandbook').mockResolvedValue({...template, competitors: [], competitorSearchQuery: 'שירותי הדרכה לעסקים'} as typeof template);
  const research = vi.spyOn(provider, 'research');
  await work();
  await work();
  const retry = await current();
  expect(retry).toMatchObject({step:'research', researchRevision:1, competitorSearchTerm:'שירותי הדרכה לעסקים'});
  await Promise.all([work(), work()]);
  await work();
  const ready = await current();
  expect(ready).toMatchObject({step:'prompts'});
  expect(research).toHaveBeenCalledTimes(2);
  expect(book).toHaveBeenCalledTimes(2);
  const combined = vi.mocked(book).mock.calls[1] as unknown as [unknown, CapturedAnswer];
  expect(combined[1].blocks.map(block => block.id)).toEqual(['block_0', 'competitors-block_0']);
  expect(await runtime.artifacts.get(retry!.verifiedBrandbookKey!)).toBeTruthy();
});

it('uses the validated first brandbook if the supplemental search supplies no usable evidence', async () => {
  const {provider, work, current, item} = await setup();
  const template = await provider.brandbook(item.job);
  vi.spyOn(provider, 'brandbook').mockResolvedValue({...template, competitors: []} as typeof template);
  await work();
  await work();
  const saved = await current();
  vi.spyOn(provider, 'research').mockRejectedValueOnce(invalid('competitor_research_evidence_missing'));
  await work();
  expect(await current()).toMatchObject({step:'prompts', status:'queued', brandbookKey:saved!.verifiedBrandbookKey});
});

it('stops before prompts and the first scan when both company searches fail to establish identity', async () => {
  const {provider, work, current, runtime, item} = await setup();
  const search = vi.spyOn(provider, 'research').mockRejectedValue(invalid('onboarding_official_research_missing'));
  for (let i = 0; i < 4; i++) await work();
  expect(search).toHaveBeenCalledTimes(2);
  expect(await current()).toMatchObject({step:'research',status:'failed'});
  expect((await runtime.repository.getProject(item.project.id))?.enabled).toBe(false);
  expect(await runtime.repository.listRuns(item.project.id)).toEqual([]);
});

it('adds independently verified rivals from both passes to the first portfolio and exposes their source evidence', async () => {
  const {provider, work, current, runtime, item} = await setup();
  const profile = await provider.brandbook(item.job);
  const candidate = (name: string, domain: string) => {
    const own = {quote: 'Acme offers retail training.', url: 'https://acme.com/training'};
    const rival = {quote: name + ' offers retail training to Israeli merchants.', url: 'https://' + domain + '/training'};
    return {name, domain, evidence: [rival], relevance: {country:'IL', sharedNeed:'retail training',
      targetOffering:own, competingOffering:rival, market:rival}};
  };
  const one = candidate('Retail Tutors', 'retailtutors.com');
  const two = candidate('Merchant School', 'merchantschool.com');
  vi.spyOn(provider, 'brandbook')
    .mockResolvedValueOnce({...profile, competitors:[one]} as typeof profile)
    .mockResolvedValueOnce({...profile, competitors:[two]} as typeof profile);
  for (let i = 0; i < 6; i++) await work();
  expect((await current())?.step).toBe('completed');
  const account = await runtime.repository.getProject(item.project.id);
  expect(account?.competitors.map(peer => peer.domains[0])).toEqual([one.domain, two.domain]);
  expect(account?.competitorResearch?.map(peer => peer.relevance?.competingOffering.url)).toEqual([
    one.relevance.competingOffering.url, two.relevance.competingOffering.url,
  ]);
});
