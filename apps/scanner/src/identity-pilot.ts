import { createHash } from 'node:crypto';
import {
  IDENTITY_PARSER_VERSION, isTerminal, nextProjectScan,
  type Analysis, type BrandAnalysis, type CapturedAnswer, type PromptResult, type ScanMessage, type ScanRun,
} from '@citevia/core';
import type { AnswerProvider, Runtime } from '@citevia/storage';
import { ProviderError } from './provider.js';
import { SCORED_PARSER_VERSION } from './scoring-extraction.js';

type ShadowMessage = Extract<ScanMessage, { kind: 'identity-shadow' }>;
type PilotRuntime = Pick<Runtime, 'repository' | 'artifacts' | 'queue'>;
type Decision = Pick<BrandAnalysis, 'brandId' | 'mentioned' | 'appearanceRank' | 'explicitRank' | 'sentiment'>;
const MAX_DEFERRALS = 32;
const PILOT_WINDOW = 48 * 60 * 60_000;
const eligible = (run: ScanRun): boolean =>
  !run.cancelledAt && !run.reanalysisOf && run.trigger === 'scheduled' &&
  run.snapshot.parserVersion !== IDENTITY_PARSER_VERSION &&
  run.snapshot.identityPilotParserVersion === IDENTITY_PARSER_VERSION &&
  Date.parse(run.snapshot.identityPilotScheduledAt || '') === Date.parse(run.scheduledAt);
const prefix = (run: ScanRun) =>
  `projects/${run.projectId}/runs/${run.id}/identity-shadow/${IDENTITY_PARSER_VERSION}`;
const resultKey = (run: ScanRun, result: PromptResult) =>
  `${prefix(run)}/${result.promptId}/generation-${result.captureGeneration ?? 0}`;
const decisions = (brands: BrandAnalysis[] | undefined): Decision[] | null => brands?.map(
  ({ brandId, mentioned, appearanceRank, explicitRank, sentiment }) => ({brandId, mentioned, appearanceRank, explicitRank, sentiment}),
) ?? null;

interface ReviewRecord {
  status: 'scored' | 'failed';
  responseId: string;
  captureKey: string;
  publishedAnalysisKey?: string;
  published: Decision[] | null;
  candidate?: Analysis;
  errorCode?: string;
}
function measurable(result: PromptResult) {
  return Boolean(result.captureKey && (result.status === 'succeeded' || result.status === 'failed_extraction'));
}

/** Retryable SQS fan-out. A marker is written only after every send is acknowledged. */
export async function dispatchIdentityShadow(runtime: PilotRuntime, run: ScanRun, results?: PromptResult[], resume = false) {
  if (!eligible(run)) return;
  const marker = `${prefix(run)}/dispatched.json`;
  if (!resume && await runtime.artifacts.get(marker)) return;
  const rows = results ?? await runtime.repository.listResults(run.projectId, run.id);
  if (rows.length !== run.totalCount || !rows.every(row => isTerminal(row.status))) return;
  const jobs = rows.filter(measurable).map((row): ShadowMessage =>
    ({ kind: 'identity-shadow', projectId: run.projectId, runId: run.id, promptId: row.promptId }));
  // Stagger groups of five to leave room for regular scan traffic. All sends and retries
  // use the same stable prompt keys; duplicate messages cannot buy additional analyses.
  for (let at = 0; at < jobs.length; at += 5) {
    await runtime.queue.send(jobs.slice(at, at + 5), Math.min(900, at * 15));
  }
  await runtime.artifacts.put(marker, { enqueued: jobs.length });
}

/** A durable claim fences crashes after an uncertain provider call. Only an explicit
 * pre-HTTP admission deferral permits another attempt, with a distinct claim. */
export async function scoreIdentityShadow(runtime: PilotRuntime, provider: AnswerProvider, message: ShadowMessage, now = new Date()) {
  const { projectId, runId, promptId } = message;
  const [run, project, result] = await Promise.all([
    runtime.repository.getRun(projectId, runId), runtime.repository.getProject(projectId),
    runtime.repository.getResult(projectId, runId, promptId),
  ]);
  if (!run || !eligible(run) || !project?.enabled || project.demo || !result?.captureKey || !measurable(result) ||
    project.identityPilotScheduledAt !== run.snapshot.identityPilotScheduledAt ||
    now.getTime() - Date.parse(run.scheduledAt) > PILOT_WINDOW) return;
  const { artifacts } = runtime;
  if (!artifacts.putIfAbsent) throw Error('Identity pilot requires conditional evidence storage');
  const path = resultKey(run, result);
  const final = `${path}/review.json`;
  if (await artifacts.get(final)) return;
  const attempt = message.attempt ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > MAX_DEFERRALS) return;
  if (attempt && !await artifacts.get(`${path}/defer-${attempt - 1}.json`)) return;
  const answer = await artifacts.get<CapturedAnswer>(result.captureKey);
  const base = { responseId: result.responseId, captureKey: result.captureKey,
    publishedAnalysisKey: result.analysisKey, published: decisions(result.brands) };
  if (!answer || answer.status !== 'completed' || !answer.text.trim()) {
    await artifacts.putIfAbsent(final, { ...base, status: 'failed', errorCode: 'saved_answer_missing' } satisfies ReviewRecord);
    return;
  }
  const deferredKey = `${path}/defer-${attempt}.json`;
  const sendNext = async (delay: number) => runtime.queue.send([{ ...message, attempt: attempt + 1 }], delay);
  if (!await artifacts.putIfAbsent(`${path}/attempt-${attempt}.json`, { startedAt: now.toISOString() })) {
    const deferred = await artifacts.get<{ delay: number }>(deferredKey);
    if (deferred) await sendNext(deferred.delay);
    return;
  }
  await artifacts.put(`${path}/progress.json`, { attempt, startedAt: now.toISOString() });
  let record: ReviewRecord;
  try {
    const candidate = await provider.extract(answer, { ...run.snapshot, projectId,
      analysisPromptId: promptId, execution: { runId, promptId, attempt: attempt + 1, stage: 'identity-shadow' },
      parserVersion: IDENTITY_PARSER_VERSION, extractionFallbackModel: undefined });
    if (candidate.parserVersion !== IDENTITY_PARSER_VERSION) throw Error('Unexpected pilot policy');
    record = { ...base, status: 'scored', candidate };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'deferred' && error.safeToRetry && attempt < MAX_DEFERRALS) {
      const delay = Math.min(900, Math.max(30, Math.ceil((error.retryAfterMs ?? 30_000) / 1000)));
      await artifacts.put(deferredKey, { delay });
      await sendNext(delay);
      return;
    }
    record = { ...base, status: 'failed', errorCode: error instanceof ProviderError ? error.code : 'identity_shadow_failed' };
  }
  await artifacts.putIfAbsent(final, record);
}

export async function recordShadowDeadLetter(runtime: PilotRuntime, msg: ShadowMessage) {
  const [run, result] = await Promise.all([
    runtime.repository.getRun(msg.projectId, msg.runId), runtime.repository.getResult(msg.projectId, msg.runId, msg.promptId),
  ]);
  if (run && result && eligible(run))
    await runtime.artifacts.put(`${resultKey(run, result)}/delivery-failed.json`, {attempt: msg.attempt ?? 0});
}

async function pendingShadowStatus(runtime: Pick<PilotRuntime, 'artifacts'>, path: string, run: ScanRun, now: Date) {
  const [progress, deliveryFailure] = await Promise.all([
    runtime.artifacts.get<{attempt:number;startedAt:string}>(`${path}/progress.json`),
    runtime.artifacts.get(`${path}/delivery-failed.json`),
  ]);
  if (deliveryFailure) return { status:'review_required', errorCode:'identity_shadow_dead_letter' };
  if (now.getTime() - Date.parse(run.scheduledAt) > PILOT_WINDOW)
    return { status:'review_required', errorCode:'identity_shadow_window_expired' };
  const claim = progress ?? await runtime.artifacts.get<{startedAt:string}>(`${path}/attempt-0.json`);
  if (!claim) return { status:'pending' };
  if (now.getTime() - Date.parse(claim.startedAt) > 40 * 60_000) {
    const deferred = await runtime.artifacts.get(`${path}/defer-${progress?.attempt ?? 0}.json`);
    return { status:'review_required', errorCode: deferred ? 'identity_shadow_deferred' : 'identity_shadow_outcome_uncertain' };
  }
  return { status:'awaiting_outcome' };
}

export async function inspectIdentityShadow(runtime: Pick<PilotRuntime, 'artifacts' | 'repository'>, projectId: string, runId: string, now = new Date()) {
  const run = await runtime.repository.getRun(projectId, runId);
  if (!run || !eligible(run)) throw Error('Run has no scheduled identity pilot');
  const results = await runtime.repository.listResults(projectId, runId);
  const digest = createHash('sha256').update(JSON.stringify([projectId, runId, run.scheduledAt, IDENTITY_PARSER_VERSION]));
  const items = [];
  for (const result of results.slice().sort((a, b) => a.promptId.localeCompare(b.promptId))) {
    if (!measurable(result)) {
      digest.update(JSON.stringify([result.responseId, result.status, result.version]));
      items.push({ responseId: result.responseId, status: result.status });
      continue;
    }
    const path = resultKey(run, result);
    const reviewKey = `${path}/review.json`;
    const review = await runtime.artifacts.get<ReviewRecord>(reviewKey);
    if (!review) {
      items.push({responseId: result.responseId, ...await pendingShadowStatus(runtime, path, run, now)});
      continue;
    }
    digest.update(JSON.stringify([reviewKey, review, result.analysisKey, decisions(result.brands)]));
    const published = decisions(result.brands);
    const changes = review.candidate?.brands.filter(brand => {
      const old = published?.find(row => row.brandId === brand.brandId);
      return !old || old.mentioned !== brand.mentioned || old.appearanceRank !== brand.appearanceRank ||
        old.explicitRank !== brand.explicitRank || old.sentiment !== brand.sentiment;
    }).map(brand => ({ candidate: decisions([brand])![0], published: published?.find(row => row.brandId === brand.brandId),
      reason: brand.identity?.reason }));
    const unresolved = review.candidate?.brands.filter(brand => brand.identity?.status === 'unresolved')
      .map(brand => ({ brandId: brand.brandId, reason: brand.identity?.reason,
        evidence: brand.identity?.evidence.map(({blockId,start,end})=>({blockId,start,end})), citationIds: brand.identity?.citationIds }));
    items.push({ responseId: result.responseId, status: review.status, reviewKey, changes, unresolved, errorCode: review.errorCode });
  }
  // A refusal or failed collection has no complete answer to rescore. Keep it visible
  // in the review and require a scored decision for every available capture.
  const complete = ['completed', 'partial'].includes(run.status) && items.length === run.totalCount &&
    items.some(item => item.status === 'scored') &&
    items.every(item => ['scored', 'refused', 'incomplete', 'failed_collection'].includes(item.status));
  return { projectId, runId, scheduledAt: run.scheduledAt, publishedPolicy: run.snapshot.parserVersion,
    candidatePolicy: IDENTITY_PARSER_VERSION, reviewedDigest: complete ? digest.digest('hex') : null, items };
}

type ConfigureMode = 'arm' | 'disable' | 'promote' | 'rollback';
type ReviewedDigests = Record<string, string>;
async function verifyReviewedGroup(runtime: PilotRuntime, projectId: string, armedAt: string | undefined, digests: ReviewedDigests = {}) {
  const runIds = Object.keys(digests);
  if (!armedAt || runIds.length < 1 || runIds.length > 3) throw Error('Supply the reviewed digest for each run in the armed pilot');
  const runs = await Promise.all(runIds.map(runId => runtime.repository.getRun(projectId, runId)));
  const first = runs[0];
  if (!first?.groupId || !first.snapshot.scanProviders?.length ||
    runs.some(run => !run || !eligible(run) || run.snapshot.identityPilotScheduledAt !== armedAt || run.groupId !== first.groupId))
    throw Error('Reviewed runs must belong to the current armed pilot group');
  const expected = first.snapshot.scanProviders.map(p => p.provider).sort();
  const actual = runs.map(run => run!.snapshot.provider ?? 'openai').sort();
  if (expected.join() !== actual.join()) throw Error('Review all providers before promoting the pilot');
  for (const runId of runIds) {
    const report = await inspectIdentityShadow(runtime, projectId, runId);
    if (!report.reviewedDigest || digests[runId] !== report.reviewedDigest)
      throw Error('Pilot coverage or digest changed. Inspect each completed run before promotion.');
  }
}

export async function configureIdentityPilot(runtime: PilotRuntime,
  projectId: string, mode: ConfigureMode, apply: boolean, now = new Date(), expectedVersion?: number, reviewedDigests?: ReviewedDigests) {
  const { repository } = runtime;
  const project = await repository.getProject(projectId);
  if (!project || project.demo) throw Error('Live account required');
  if (![SCORED_PARSER_VERSION, IDENTITY_PARSER_VERSION].includes(project.parserVersion)) throw Error('Unsupported account policy');
  if (expectedVersion !== undefined && expectedVersion !== project.version) throw Error('Account changed; refresh the preview');
  const next = { ...project };
  if (mode === 'arm') {
    if (project.parserVersion === IDENTITY_PARSER_VERSION) throw Error('Candidate policy already published');
    const nextOccurrence = nextProjectScan(project, now);
    if (!nextOccurrence) throw Error('Account requires an active scan schedule');
    next.identityPilotScheduledAt = nextOccurrence;
  } else {
    delete next.identityPilotScheduledAt;
    if (mode === 'promote') {
      if (apply && next.parserVersion !== IDENTITY_PARSER_VERSION)
        await verifyReviewedGroup(runtime, projectId, project.identityPilotScheduledAt, reviewedDigests);
      next.parserVersion = IDENTITY_PARSER_VERSION;
    }
    if (mode === 'rollback') next.parserVersion = SCORED_PARSER_VERSION;
  }
  const changed = next.parserVersion !== project.parserVersion || next.identityPilotScheduledAt !== project.identityPilotScheduledAt;
  if (apply && changed) {
    next.version++;
    next.updatedAt = now.toISOString();
    if (!await repository.saveProject(next, project.version)) throw Error('Account changed; refresh the preview');
  }
  return { projectId, mode, applied: apply && changed, version: project.version + Number(changed && apply),
    scheduledAt: next.identityPilotScheduledAt ?? null, parserVersion: next.parserVersion };
}
