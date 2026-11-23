import { z } from 'zod';
import {
  identifier,
  isBrandedPrompt,
  journeyStageSchema,
  MAX_BRANDED_PROMPTS,
  projectProviders,
  promptFingerprint,
  promptTextSchema,
  type ScanMessage,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { oneTimeScanDigest, providerRunIdFor, runIdFor } from './engine.js';

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const approvedRecoverySchema = z.object({
  kind: z.literal('onboarding:recover-approved'),
  projectId: identifier,
  requestId,
  officialName: z.string().trim().min(1).max(120),
  prompts: z.array(z.object({ text: promptTextSchema, stage: journeyStageSchema }).strict()).min(1),
}).strict();
export const approvedScanSchema = z.object({
  kind: z.literal('scan:approved-recovery'),
  projectId: identifier,
  requestId,
}).strict();

type RecoveryInput = Omit<z.infer<typeof approvedRecoverySchema>, 'kind'>;
type ScanInput = Omit<z.infer<typeof approvedScanSchema>, 'kind'>;
const HOUR_MS = 60 * 60_000;

async function standardSetup(runtime: Runtime, projectId: string) {
  const project = await runtime.repository.getProject(projectId);
  if (!project?.onboardingJobId || project.demo || project.accountType === 'prospect')
    throw new Error('A standard account with an onboarding job is required.');
  const job = await runtime.repository.getOnboarding(projectId, project.onboardingJobId);
  if (!job) throw new Error('Account setup could not be found.');
  return { project, job };
}

export async function recoverApprovedOnboarding(runtime: Runtime, input: RecoveryInput, now = new Date()) {
  const { repository, queue } = runtime;
  const { project, job } = await standardSetup(runtime, input.projectId);
  const message = { kind: 'onboard', projectId: project.id, jobId: job.id } as const;
  const approved = job.approvedPortfolio;
  if (approved?.requestId === input.requestId) {
    if (job.input.name !== input.officialName || JSON.stringify(approved.prompts) !== JSON.stringify(input.prompts))
      throw new Error('The setup request ID is already assigned to different approved prompts or a different brand name.');
    if (job.status === 'queued' || job.status === 'running') await queue.send([message]);
    return { jobId: job.id, status: job.status, step: job.step, promptCount: approved.prompts.length };
  }
  if (project.enabled || project.onboardingAppliedJobId || project.prompts.length || job.firstRunId ||
      (job.status !== 'failed' && job.status !== 'stopped'))
    throw new Error('Approved recovery needs a paused, empty account with unapplied failed or stopped setup.');
  if (job.retryRequestIds.includes(input.requestId) || job.retryRequestIds.length >= 8)
    throw new Error('Account setup has reached its retry limit or this request ID was already used.');
  if (!input.prompts.length || new Set(input.prompts.map(p => promptFingerprint(p.text))).size !== input.prompts.length)
    throw new Error('Provide distinct approved prompts.');
  const brand = { ...project.brand, name: input.officialName };
  if (input.prompts.filter(prompt => isBrandedPrompt(prompt.text, brand)).length > MAX_BRANDED_PROMPTS)
    throw new Error(`At most ${MAX_BRANDED_PROMPTS} approved prompts may name the brand.`);
  const originalUrl = new URL(job.input.website);
  const domain = project.brand.domains[0];
  if (!domain) throw new Error('An official website is required.');
  const website = originalUrl.hostname.toLowerCase() === domain.toLowerCase() ? originalUrl.href : `https://${domain}`;
  const next = {
    ...job,
    input: { ...job.input, name: input.officialName, website, country: project.country,
      language: project.language, timezone: project.timezone, promptFocus: project.promptFocus },
    approvedPortfolio: { requestId: input.requestId, baseBrandName: project.brand.name, prompts: input.prompts },
    status: 'queued' as const,
    step: 'research' as const,
    attempts: 0,
    version: job.version + 1,
    updatedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
    retryRequestIds: [...job.retryRequestIds, input.requestId],
    researchRevision: (job.researchRevision ?? 0) + 1,
    researchFeedback: 'Verify the exact trading name supplied by the operator on the official website. The workspace name can include its market.',
    researchKey: undefined,
    brandbookKey: undefined,
    promptsKey: undefined,
    verifiedBrandbookKey: undefined,
    verifiedResearchKey: undefined,
    competitorSearchTerm: undefined,
    competitorSearchDomains: undefined,
    rejectedPortfolioKey: undefined,
    portfolioFeedback: undefined,
    automaticPortfolioCorrections: 0,
    error: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    paidCall: undefined,
  };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 300_000)
    throw new Error('The approved setup data is too large.');
  if (!(await repository.saveOnboarding(next, job.version)))
    throw new Error('The account setup changed. Read its current status and retry.');
  await queue.send([message]);
  return { jobId: job.id, status: next.status, step: next.step, promptCount: input.prompts.length };
}

export async function startApprovedRecoveryScan(runtime: Runtime, input: ScanInput, now = new Date()) {
  const { repository, queue } = runtime;
  const { project, job } = await standardSetup(runtime, input.projectId);
  const approved = job.approvedPortfolio;
  if (project.enabled || job.status !== 'completed' || project.onboardingAppliedJobId !== job.id || !approved)
    throw new Error('Finish approved setup and keep recurring scans paused before starting this scan.');

  const previous = project.lastManualRequest;
  const permit = previous?.whilePaused;
  const sameRequest = previous?.requestId === input.requestId;
  if (permit && !sameRequest) throw new Error('A one-time scan has already been authorized for this recovery.');
  const at = sameRequest && permit ? previous.requestedAt : now.toISOString();
  const message: Extract<ScanMessage, { kind: 'kickoff' }> = {
    kind: 'kickoff', projectId: project.id, scheduledAt: at, trigger: 'manual', requestId: input.requestId,
  };
  const runId = runIdFor(message);
  if (sameRequest && permit) {
    const runs = await Promise.all(permit.runIds.map(id => repository.getRun(project.id, id)));
    if (runs.some(run => !run) && !runs[0]?.cancelledAt) {
      if (Date.parse(permit.expiresAt) <= now.getTime() || (!runs[0] && permit.promptDigest !== oneTimeScanDigest(project)))
        throw new Error('The one-time scan authorization expired or its inputs changed.');
      await queue.send([message]);
    }
    return { runId, runIds: permit.runIds, promptCount: approved.prompts.length };
  }
  if (sameRequest) throw new Error('This request ID was already used for a different scan.');
  const prompts = project.prompts.filter(prompt => prompt.active);
  if (prompts.length !== approved.prompts.length || prompts.some((prompt, index) =>
    prompt.text !== approved.prompts[index].text || prompt.stage !== approved.prompts[index].stage))
    throw new Error('The active prompts no longer match the approved portfolio.');
  if ((await repository.listRuns(project.id)).some(run => run.status === 'queued' || run.status === 'running'))
    throw new Error('A scan is already queued or running for this account.');
  const configs = projectProviders(project);
  const runIds = configs.map(({ provider }) => providerRunIdFor(runId, provider, configs[0].provider));
  const next = {
    ...project,
    version: project.version + 1,
    updatedAt: at,
    lastManualRequest: { runId, requestId: input.requestId, requestedAt: at, whilePaused: {
      runIds,
      expiresAt: new Date(now.getTime() + 25 * HOUR_MS).toISOString(),
      promptDigest: oneTimeScanDigest(project),
    } },
  };
  if (!(await repository.saveProject(next, project.version)))
    throw new Error('The account changed before the one-time scan could be authorized.');
  await queue.send([message]);
  return { runId, runIds, promptCount: prompts.length };
}
