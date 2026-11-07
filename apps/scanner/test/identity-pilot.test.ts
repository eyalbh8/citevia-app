import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_PARSER_VERSION, PARSER_VERSION, type RunSnapshot, type ScanMessage } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { Scanner } from '../src/engine.js';
import { configureIdentityPilot, dispatchIdentityShadow, inspectIdentityShadow } from '../src/identity-pilot.js';
import { ProviderError } from '../src/provider.js';
import { analysis, captured, project } from './fixtures.js';

const start = new Date('2026-10-18T11:00:00Z');
type Shadow = Extract<ScanMessage, {kind:'identity-shadow'}>;

async function fixture() {
  const repository = new MemoryRepository(), queue = new MemoryQueue(), artifacts = new MemoryArtifacts();
  const account = { ...project, parserVersion: PARSER_VERSION, prompts: project.prompts.slice(0, 1) };
  await repository.saveProject(account, null);
  const runtime = { repository, artifacts, queue };
  const armed = await configureIdentityPilot(runtime, account.id, 'arm', true, start, account.version);
  const at = new Date(armed.scheduledAt!);
  const provider = { collect: vi.fn(async () => captured()), extract: vi.fn(async (answer: ReturnType<typeof captured>, snapshot: RunSnapshot) => ({
    ...analysis(answer), parserVersion: snapshot.parserVersion,
  })) };
  const scanner = new Scanner({ ...runtime, provider, now: () => at });
  const kickoff = { kind: 'kickoff', projectId: account.id, scheduledAt: at.toISOString() } as const;
  await scanner.handle(kickoff);
  const prompt = queue.messages.shift()!;
  await scanner.handle(prompt);
  const [run] = await repository.listRuns(account.id);
  const message = queue.messages.find((item): item is Shadow => item.kind === 'identity-shadow')!;
  return { ...runtime, account, run, provider, scanner, kickoff, message, at, armed };
}

describe('scoped identity comparison on a scheduled occurrence', () => {
  it('never sends shadow work to an analyzer changed after the pilot was approved', async () => {
    const env = await fixture();
    expect(env.armed.analyzer).toBe(env.run.snapshot.extractionModel);
    const current = (await env.repository.getProject(env.account.id))!;
    await env.repository.saveProject({...current, extractionModel: 'different-model', version: current.version + 1}, current.version);
    await env.scanner.handle(env.message);
    expect(env.provider.extract).toHaveBeenCalledTimes(1);
  });

  it('publishes the frozen baseline and scores the captured answer once across duplicate shadow deliveries', async () => {
    const env = await fixture();
    const before = await env.repository.listResults(env.run.projectId, env.run.id);
    expect(env.run).toMatchObject({status:'completed', snapshot:{parserVersion:PARSER_VERSION,identityPilotParserVersion:IDENTITY_PARSER_VERSION}});
    await Promise.all([env.scanner.handle(env.message), env.scanner.handle(env.message)]);
    await dispatchIdentityShadow(env, env.run, undefined, true);
    await env.scanner.handle(env.message);
    expect(env.provider.collect).toHaveBeenCalledTimes(1);
    expect(env.provider.extract).toHaveBeenCalledTimes(2);
    expect(env.provider.extract.mock.calls[1][1]).toMatchObject({parserVersion:IDENTITY_PARSER_VERSION,analysisPromptId:env.message.promptId});
    expect(await env.repository.listResults(env.run.projectId, env.run.id)).toEqual(before);
    expect((await inspectIdentityShadow(env, env.run.projectId, env.run.id)).items[0]).toMatchObject({status:'scored',changes:[]});
  });

  it('only retries pre-HTTP deferrals and records an uncertain failure without buying a replacement', async () => {
    const env = await fixture();
    env.provider.extract.mockRejectedValueOnce(new ProviderError('defer','Busy',true,null,{kind:'deferred',safeToRetry:true,retryAfterMs:35000}))
      .mockRejectedValueOnce(new Error('uncertain completion'));
    await env.scanner.handle(env.message);
    const retry = env.queue.messages.at(-1)!;
    expect(retry).toMatchObject({kind:'identity-shadow',attempt:1});
    expect(env.queue.delays.at(-1)).toBe(35);
    await env.scanner.handle(retry);
    await env.scanner.handle(retry);
    expect(env.provider.extract).toHaveBeenCalledTimes(3);
    expect((await inspectIdentityShadow(env, env.run.projectId, env.run.id)).items[0]).toMatchObject({status:'failed',errorCode:'identity_shadow_failed'});
    expect((await env.repository.getRun(env.run.projectId,env.run.id))?.status).toBe('completed');
  });

  it('ignores unarmed occurrences, supports disarming during queued work, and isolates account promotion', async () => {
    const env = await fixture();
    const manual = { ...env.kickoff, trigger: 'manual', requestId: 'other-occurrence' } as const;
    await env.scanner.handle(manual);
    const manualRun = (await env.repository.listRuns(env.account.id)).find(r=>r.trigger==='manual')!;
    expect(manualRun.snapshot.identityPilotParserVersion).toBeUndefined();
    const disarm = await configureIdentityPilot(env, env.account.id, 'disable', true, env.at);
    await env.scanner.handle(env.message);
    expect(env.provider.extract).toHaveBeenCalledTimes(1);
    expect(disarm.parserVersion).toBe(PARSER_VERSION);
    await expect(configureIdentityPilot(env, env.account.id, 'promote', true, env.at, disarm.version))
      .rejects.toThrow('Supply the reviewed digest');
  });

  it('only promotes a complete, reviewed cohort; rollback applies to the next scan', async () => {
    const env = await fixture();
    const promote = (digest: string) => configureIdentityPilot(env, env.account.id, 'promote', true, env.at, env.armed.version,
      { [env.run.id]:digest });
    await expect(promote('bad-digest')).rejects.toThrow('coverage or digest');
    await env.scanner.handle(env.message);
    await expect(promote('bad-digest')).rejects.toThrow('coverage or digest');
    const report = await inspectIdentityShadow(env, env.account.id, env.run.id);
    expect(report.reviewedDigest).toMatch(/^[a-f0-9]{64}$/);
    const next = await promote(report.reviewedDigest!);
    expect(next.parserVersion).toBe(IDENTITY_PARSER_VERSION);
    const restored = await configureIdentityPilot(env, env.account.id, 'rollback', true, env.at, next.version);
    expect(restored.parserVersion).toBe(PARSER_VERSION);
  });

  it('surfaces a lost claim or dead-lettered delivery for review with no further provider spend', async () => {
    const env = await fixture();
    const key = `projects/${env.account.id}/runs/${env.run.id}/identity-shadow/${IDENTITY_PARSER_VERSION}/${env.message.promptId}/generation-0`;
    await env.artifacts.put(`${key}/attempt-0.json`, { startedAt: env.at.toISOString() });
    await env.scanner.handle(env.message);
    const overdue = new Date(env.at.getTime() + 41 * 60_000);
    expect((await inspectIdentityShadow(env, env.account.id, env.run.id, overdue)).items[0])
      .toMatchObject({ status:'review_required', errorCode:'identity_shadow_outcome_uncertain' });
    await env.scanner.handleDeadLetter(env.message);
    expect((await inspectIdentityShadow(env, env.account.id, env.run.id, overdue)).items[0])
      .toMatchObject({ status:'review_required', errorCode:'identity_shadow_dead_letter' });
    expect(env.provider.extract).toHaveBeenCalledTimes(1);
  });
});
