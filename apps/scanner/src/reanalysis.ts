import { createHash } from 'node:crypto';
import {
  isTerminal,
  PARSER_VERSION,
  RETENTION_DAYS,
  type CapturedAnswer,
  type Analysis,
  type PromptResult,
  type ScanRun,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { captureKeyFor } from './engine.js';

/** IAM-only maintenance: new report, original answers/time/provenance preserved; collection is forbidden. */
export async function reanalyzeCapturedRun(
  runtime: Runtime,
  projectId: string,
  sourceRunId: string,
  requestId: string,
  now = new Date(),
) {
  const { repository, artifacts, queue } = runtime;
  const source = await repository.getRun(projectId, sourceRunId);
  const project = await repository.getProject(projectId);
  if (!source || !project) throw new Error('Account or source run not found');
  const id = `run_${createHash('sha256').update(`${projectId}:${sourceRunId}:${requestId}:${PARSER_VERSION}`).digest('hex').slice(0, 24)}`;
  let run = await repository.getRun(projectId, id);
  const original = await repository.listResults(projectId, sourceRunId);
  if (!run) {
    const at = now.toISOString(),
      expiresAt = Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 86400;
    const results: PromptResult[] = [];
    for (const result of original) {
      const captureKey = result.captureKey || captureKeyFor(result);
      const answer = await artifacts.get<CapturedAnswer>(captureKey);
      const valid = answer?.status === 'completed' && !!answer.text.trim();
      const validatedKey = `${captureKey}.scored-v2.json`;
      const validated = valid
        ? await artifacts.get<Analysis>(validatedKey)
        : null;
      const useValidated =
        validated?.parserVersion === PARSER_VERSION &&
        validated.model === source.snapshot.extractionModel &&
        validated.brands.length === 1 + source.snapshot.competitors.length &&
        [source.snapshot.brand, ...source.snapshot.competitors].every((brand) =>
          validated.brands.some((row) => row.brandId === brand.id),
        );
      results.push({
        projectId,
        runId: id,
        promptId: result.promptId,
        responseId: `${id}~${result.promptId}`,
        prompt: result.prompt,
        status: valid ? 'captured' : 'failed_collection',
        version: 1,
        attempts: 0,
        ...(valid
          ? {
              captureKey,
              ...(useValidated ? { analysisKey: validatedKey } : {}),
              capturedAt: answer.createdAt,
              model: answer.model,
              usage: answer.usage,
            }
          : {
              completedAt: at,
              error: {
                code: 'saved_answer_missing',
                message:
                  'No completed answer was saved in the original scan. No replacement call was made.',
                retryable: false,
              },
            }),
        citationCount: valid ? answer.citations.length : 0,
        sourceCount: valid ? answer.sources.length : 0,
        expiresAt,
      });
    }
    if (!results.length || !results.some((result) => result.captureKey))
      throw new Error('No saved completed answers to reanalyze');
    run = {
      ...source,
      id,
      reanalysisOf: sourceRunId,
      groupId: `rescore_${createHash('sha256').update(`${projectId}:${requestId}`).digest('hex').slice(0, 24)}`,
      snapshot: { ...source.snapshot, parserVersion: PARSER_VERSION },
      createdAt: at,
      scheduledAt: at,
      status: 'queued',
      trigger: 'manual',
      resultVersion: 1,
      succeededCount: 0,
      capturedCount: results.filter((result) => result.captureKey).length,
      terminalCount: results.filter((result) => isTerminal(result.status))
        .length,
      deadlineAt: new Date(now.getTime() + 24 * 3600000).toISOString(),
      expiresAt,
    };
    for (const field of [
      'startedAt',
      'completedAt',
      'summaryKey',
      'summaryVersion',
    ] as const)
      delete run[field];
    await repository.createRun(run, results);
  }
  // The old failed parser must not continue buying retries after its replacement report exists.
  for (const result of original) {
    if (isTerminal(result.status)) continue;
    const next: PromptResult = {
      ...result,
      version: result.version + 1,
      status: result.captureKey ? 'failed_extraction' : 'failed_collection',
      completedAt: now.toISOString(),
      error: {
        code: 'analysis_superseded',
        message:
          'Remaining work stopped; saved answers are being rescored in a separate report.',
        retryable: false,
      },
    };
    delete next.leaseOwner;
    delete next.leaseExpiresAt;
    await repository.commitResult(next, result);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await repository.getProject(projectId);
    if (!latest || latest.parserVersion === PARSER_VERSION) break;
    if (
      await repository.saveProject(
        {
          ...latest,
          parserVersion: PARSER_VERSION,
          version: latest.version + 1,
          updatedAt: now.toISOString(),
        },
        latest.version,
      )
    )
      break;
  }
  const pending = (await repository.listResults(projectId, id)).filter(
    (result) => !isTerminal(result.status),
  );
  await queue.send(
    pending.map((result) => ({
      kind: 'prompt' as const,
      projectId,
      runId: id,
      promptId: result.promptId,
    })),
  );
  // Terminal delivery finalizes the original report without another model request.
  if (original[0])
    await queue.send([
      {
        kind: 'prompt',
        projectId,
        runId: sourceRunId,
        promptId: original[0].promptId,
      },
    ]);
  return {
    runId: id,
    sourceRunId,
    capturedAnswers: run.capturedCount,
    newCollectionCalls: 0,
  };
}
