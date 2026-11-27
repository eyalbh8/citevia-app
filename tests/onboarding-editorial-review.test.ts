import { expect, it, vi } from 'vitest';
import { editorialReviewRequest, verifyEditorialReview } from '../apps/scanner/src/onboarding-editorial-review.js';
import { OpenAIOnboardingProvider, previousPortfolioDraft } from '../apps/scanner/src/onboarding-provider.js';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { testIdentity } from './fixtures/users.js';
import { policyJob } from './fixtures/onboarding-job.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';

it('requires one ordered assessment per question and a valid supporting offering', () => {
  const valid = { offering: 0, verdict: 'use', issue: '' };
  expect(() => verifyEditorialReview({rows: {row_0: valid}}, [0], 1)).not.toThrow();
  for (const rows of [{}, {row_0: {...valid, offering: 2}}, {row_0:valid, row_1:valid}]) {
    expect(() => verifyEditorialReview({rows}, [0], 1)).toThrow();
  }
  expect(() => verifyEditorialReview({rows: {row_0: {...valid, offering: -1}}}, [0], 1)).toThrowError(
    expect.objectContaining({rowIndices: [0], code: 'onboarding_editorial_revision'}));
});

it.each(['standard', 'prospect'] as const)('passes the full %s set and saves the failed rows for correction', async accountType => {
  const job = policyJob();
  job.input.accountType = accountType;
  const fixture = new FixtureOnboardingProvider();
  const { brandbook } = await fixture.brandbook(job);
  const { prompts } = await fixture.prompts(job, brandbook);
  const req = editorialReviewRequest('editor', job, brandbook, [], prompts);
  expect(req.input).toMatchObject({market: job.input.country, offerings: [brandbook.about, ...brandbook.keyFeatures]});
  const reviews = Object.fromEntries(prompts.map((_, row) => ['row_' + row, {
    offering: 0, verdict: row === 1 || row === 3 ? 'rewrite' : 'use', issue: row === 1 ? 'Unrelated service' : row === 3 ? 'Unsupported guarantee' : '',
  }]));
  const extract = vi.fn().mockResolvedValue({response: { status: 'completed', output: [{
    type: 'message', content: [{type: 'output_text', text: JSON.stringify({rows:reviews})}],
  }]}, requestId: 'review', receivedAt: new Date().toISOString()});
  const provider = new OpenAIOnboardingProvider({ answer: vi.fn(), extract });
  const error = await provider.review(job, brandbook, [], prompts).catch(err => err);
  expect(extract.mock.calls[0][0].model).toBe(accountType === 'standard'
    ? (process.env.OPENAI_STANDARD_PORTFOLIO_MODEL || 'gpt-6-astra')
    : (process.env.OPENAI_ONBOARDING_MODEL || 'gpt-4.1-2025-04-14'));
  expect(error.code).toBe('onboarding_editorial_revision');
  const draft = previousPortfolioDraft(error.receipt);
  expect(draft.filter(row => row.rewrite).map(row => row.text)).toEqual([prompts[1].text, prompts[3].text]);
  expect(draft.filter(row => row.rewrite === false)).toHaveLength(prompts.length - 2);
  const acceptedRows = Object.fromEntries([1, 3].map(row => ['row_' + row, {offering: 0, verdict: 'use', issue: ''}]));
  extract.mockResolvedValue({ response: { status: 'completed', output: [{ type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({rows: acceptedRows}) }] }] }, requestId: 'repaired' });
  await provider.review(job, brandbook, [], prompts, error.receipt);
  expect(extract).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({assess: [1, 3]}) }));

});

it('reuses the accepted review after an activation write conflict', async () => {
  const runtime = { repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
  await runtime.repository.syncUser(testIdentity('owner'));
  const { items: [item] } = await createAccounts(runtime, 'owner', 'editorial-test',
    { accounts: [{name: 'Acme', website: 'https://acme.com', region: 'US', language: 'en'}] }, new Date(), 3);
  const provider = new FixtureOnboardingProvider();
  const review = vi.spyOn(provider, 'review');
  const engine = new OnboardingEngine(runtime, provider, async () => {});
  const work = () => engine.handle(item.project.id, item.job.id);
  await work(); await work(); await work();
  vi.spyOn(runtime.repository, 'saveProject').mockResolvedValueOnce(false);
  await expect(work()).rejects.toMatchObject({code: 'project_conflict'});
  const pending = await runtime.repository.getOnboarding(item.project.id, item.job.id);
  expect(pending).toMatchObject({status: 'queued', step: 'activate'});
  expect(pending?.paidCall).toBeUndefined();
  await work();
  expect(review).toHaveBeenCalledTimes(1);
  expect(await runtime.repository.getOnboarding(item.project.id, item.job.id)).toMatchObject({step: 'completed'});
});
