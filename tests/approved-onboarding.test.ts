import { expect, it, vi } from 'vitest';
import type { OnboardingInput } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { recoverApprovedOnboarding, startApprovedRecoveryScan } from '../apps/scanner/src/approved-recovery.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { testIdentity } from './fixtures/users.js';

it('recovers a failed standard account with 70 reviewed prompts and leaves scans paused', async () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const repository = new MemoryRepository();
  const queue = new MemoryQueue();
  const runtime = { repository, queue, artifacts: new MemoryArtifacts() };
  await repository.syncUser(testIdentity('owner'));
  const { items: [{ project, job }] } = await createAccounts(runtime, 'owner', 'account-creation', {
    accounts: [{ name: 'Acme GB', website: 'https://acme.com', region: 'GB', language: 'en' }],
  }, now, 10);
  await repository.saveOnboarding({
    ...job,
    status: 'failed',
    error: { code: 'onboarding_official_research_missing', message: 'The submitted name could not be verified.' },
    version: job.version + 1,
  }, job.version);
  queue.messages.length = 0;
  const scanRequest = { projectId: project.id, requestId: 'scan-approved-70' };
  await expect(startApprovedRecoveryScan(runtime, scanRequest, now)).rejects.toThrow();
  expect(queue.messages).toEqual([]);

  const prompts: OnboardingInput['manualPrompts'] = Array.from({ length: 70 }, (_, index) => index === 0
    ? { text: 'Is Acme a good option for UK buyers?', stage: 'prefer' }
    : { text: `Where can I buy product ${index} in the UK?`, stage: 'convert' });
  const request = { projectId: project.id, requestId: 'recover-approved-70', officialName: 'Acme', prompts };
  const provider = new FixtureOnboardingProvider();
  const research = vi.spyOn(provider, 'research');
  const brandbook = vi.spyOn(provider, 'brandbook');
  const generate = vi.spyOn(provider, 'prompts');
  const syncSchedule = vi.fn(async () => {});
  const engine = new OnboardingEngine(runtime, provider, syncSchedule, () => now);
  const drain = async () => {
    for (let count = 0; queue.messages.length; count++) {
      if (count >= 10) throw new Error('Onboarding queue did not drain');
      const message = queue.messages.shift();
      if (message?.kind !== 'onboard') throw new Error('Recovery queued work outside onboarding');
      await engine.handle(message.projectId, message.jobId);
    }
  };

  await recoverApprovedOnboarding(runtime, request, now);
  await drain();
  const recovered = await repository.getProject(project.id);
  expect(recovered).toMatchObject({
    name: 'Acme GB',
    brand: { name: 'Acme', domains: ['acme.com'] },
    country: 'GB',
    enabled: false,
    onboardingAppliedJobId: job.id,
    brandbook: { companyCountry: 'GB' },
  });
  expect(recovered?.prompts.map(({ text, stage }) => ({ text, stage }))).toEqual(prompts);
  expect(recovered?.prompts.every(prompt => prompt.active)).toBe(true);
  expect(recovered?.prompts.filter(prompt => prompt.branded).map(prompt => prompt.text)).toEqual([prompts[0].text]);
  const completed = await repository.getOnboarding(project.id, job.id);
  expect(completed).toMatchObject({ status: 'completed', step: 'completed', inputHash: job.inputHash });
  expect(completed?.firstRunId).toBeUndefined();

  await expect(recoverApprovedOnboarding(runtime, {
    ...request,
    prompts: [{ text: 'Which providers serve UK buyers?', stage: 'prefer' }, ...prompts.slice(1)],
  }, now)).rejects.toThrow();
  await recoverApprovedOnboarding(runtime, request, now);
  await drain();
  expect(await repository.getProject(project.id)).toEqual(recovered);
  expect(await repository.getOnboarding(project.id, job.id)).toEqual(completed);
  expect(research).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: expect.objectContaining({ name: 'Acme' }) }));
  expect(brandbook).toHaveBeenCalledTimes(1);
  expect(generate).not.toHaveBeenCalled();
  expect(syncSchedule).not.toHaveBeenCalled();
  expect(await repository.listRuns(project.id)).toEqual([]);

  if (!recovered) throw new Error('Recovered account is missing');
  const [firstPrompt, ...remainingPrompts] = recovered.prompts;
  const edited = {
    ...recovered,
    prompts: [{ ...firstPrompt, text: 'Which investment apps serve the UK?' }, ...remainingPrompts],
    version: recovered.version + 1,
  };
  expect(await repository.saveProject(edited, recovered.version)).toBe(true);
  await expect(startApprovedRecoveryScan(runtime, scanRequest, now)).rejects.toThrow('active prompts no longer match');
  expect(queue.messages).toEqual([]);
  expect(await repository.saveProject({ ...recovered, version: edited.version + 1 }, edited.version)).toBe(true);

  const admitted = await startApprovedRecoveryScan(runtime, scanRequest, now);
  expect(queue.messages).toEqual([expect.objectContaining({
    kind: 'kickoff', projectId: project.id, requestId: scanRequest.requestId, trigger: 'manual',
  })]);
  const withAdmittedScan = await repository.getProject(project.id);
  expect(withAdmittedScan?.enabled).toBe(false);
  expect(await startApprovedRecoveryScan(runtime, scanRequest, now)).toEqual(admitted);
  expect(await repository.getProject(project.id)).toEqual(withAdmittedScan);
  await expect(startApprovedRecoveryScan(runtime, { ...scanRequest, requestId: 'another-scan' }, now))
    .rejects.toThrow('already been authorized');
});
