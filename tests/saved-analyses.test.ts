import { describe, expect, it } from 'vitest';
import type { Analysis, Project, PromptResult, ScanRun } from '@citevia/core';
import {
  MemoryRepository,
  PostgresRepository,
  uuidFor,
  type Repository,
  type SavedAnalysisRef,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import {
  analysis,
  captured,
  instant,
  project as fixture,
  snapshot,
} from '../apps/scanner/test/fixtures.js';

function measurement(project: Project, id: string) {
  const run: ScanRun = {
    id,
    projectId: project.id,
    scheduledAt: instant,
    createdAt: instant,
    status: 'completed',
    trigger: 'manual',
    snapshot: { ...snapshot, prompts: project.prompts },
    totalCount: 1,
    terminalCount: 1,
    succeededCount: 1,
    capturedCount: 1,
    resultVersion: 1,
    deadlineAt: instant,
    expiresAt: 2000000000,
  };
  const answer = captured(),
    saved = analysis(answer);
  const result: PromptResult = {
    projectId: project.id,
    runId: id,
    promptId: project.prompts[0].id,
    responseId: `${id}~${project.prompts[0].id}`,
    prompt: project.prompts[0],
    status: 'succeeded',
    version: 1,
    attempts: 1,
    captureKey: `projects/${project.id}/captures/${id}`,
    analysisKey: `projects/${project.id}/analyses/${id}`,
    capturedAt: instant,
    completedAt: instant,
    target: saved.brands[0],
    brands: saved.brands,
    citationCount: answer.citations.length,
    sourceCount: answer.sources.length,
    expiresAt: 2000000000,
  };
  const ref: SavedAnalysisRef = {
    responseId: result.responseId,
    captureKey: result.captureKey!,
    analysisKey: result.analysisKey,
  };
  return { run, result, answer, saved, ref };
}

describe.each(['memory', 'postgres'] as const)(
  'indexed saved analyses (%s)',
  (backend) => {
    const indexedAnalysis = (value: Analysis): Analysis => {
      if (backend !== 'postgres') return value;
      const { raw: _raw, ...projection } = value;
      return projection;
    };
    it('uses project and receipt identity, returns authoritative null, and omits missing/stale records', async () => {
      const db = backend === 'postgres' ? await localPostgres() : undefined;
      const repository: Repository = db
        ? new PostgresRepository(db)
        : new MemoryRepository();
      try {
        const project = structuredClone(fixture),
          other = { ...structuredClone(fixture), id: 'private-project' };
        await repository.saveProject(project, null);
        await repository.saveProject(other, null);
        const first = measurement(project, 'indexed'),
          empty = measurement(project, 'empty'),
          legacy = measurement(project, 'legacy'),
          foreign = measurement(other, 'indexed');
        for (const item of [first, empty, legacy, foreign])
          await repository.createRun(item.run, [item.result]);
        await repository.saveMeasurement(
          first.result,
          first.run,
          first.answer,
          first.saved,
        );
        await repository.saveMeasurement(
          empty.result,
          empty.run,
          empty.answer,
          null,
        );
        await repository.saveMeasurement(
          foreign.result,
          foreign.run,
          foreign.answer,
          { ...foreign.saved, brands: [], raw: { private: true } },
        );
        const rows = await repository.listSavedAnalyses(project.id, [
          ...Array.from({ length: 501 }, (_, index) => ({
            responseId: `missing-${index}`,
            captureKey: 'absent',
            analysisKey: 'absent',
          })),
          first.ref,
          empty.ref,
          legacy.ref,
          first.ref,
          foreign.ref,
        ]);
        expect(rows).toHaveLength(2);
        expect(
          rows.find((row) => row.responseId === first.ref.responseId)?.analysis,
        ).toEqual(indexedAnalysis(first.saved));
        expect(
          rows.find((row) => row.responseId === empty.ref.responseId),
        ).toEqual({ responseId: empty.ref.responseId, analysis: null });
        expect(
          await repository.listSavedAnalyses('missing-project', [first.ref]),
        ).toEqual([]);
        expect(
          await repository.listSavedAnalyses(other.id, [first.ref]),
        ).toEqual([]);
        expect(
          await repository.listSavedAnalyses(project.id, [
            { ...first.ref, captureKey: 'incorrect' },
          ]),
        ).toEqual([]);
        expect(
          await repository.listSavedAnalyses(project.id, [
            { ...first.ref, analysisKey: 'incorrect' },
          ]),
        ).toEqual([]);
        expect(
          await repository.listSavedAnalyses(project.id, [
            {
              responseId: first.ref.responseId,
              captureKey: first.ref.captureKey,
            },
          ]),
        ).toEqual([]);

        // A changed workflow result cannot reuse a receipt published by an older finalizer.
        const revised = { ...first.result, version: 2 };
        expect(await repository.commitResult(revised, first.result)).toBe(true);
        expect(await repository.listSavedAnalyses(project.id, [first.ref])).toEqual([]);
        const updated = {
          ...revised,
          version: 3,
          analysisKey: `${first.result.analysisKey}-new`,
        };
        expect(await repository.commitResult(updated, revised)).toBe(true);
        const updatedRef = { ...first.ref, analysisKey: updated.analysisKey };
        expect(
          await repository.listSavedAnalyses(project.id, [
            first.ref,
            updatedRef,
          ]),
        ).toEqual([]);
        await repository.saveMeasurement(
          first.result,
          first.run,
          first.answer,
          first.saved,
        );
        expect(
          await repository.listSavedAnalyses(project.id, [updatedRef]),
        ).toEqual([]);
        const updatedAnalysis: Analysis = {
          ...first.saved,
          raw: { updated: true },
        };
        await repository.saveMeasurement(
          updated,
          first.run,
          first.answer,
          updatedAnalysis,
        );
        expect(
          await repository.listSavedAnalyses(project.id, [updatedRef]),
        ).toEqual([
          { responseId: first.ref.responseId, analysis: indexedAnalysis(updatedAnalysis) },
        ]);
        expect(
          await repository.listSavedAnalyses(project.id, [first.ref]),
        ).toEqual([]);

        if (db) {
          // Existing rows from before this reader had analysis but no new identity metadata.
          const id = uuidFor(`${project.id}:response:${updated.responseId}`);
          await db.query(
            "UPDATE prompt_responses SET json_response=json_response-'measurement' WHERE id=$1",
            [id],
          );
          expect(
            await repository.listSavedAnalyses(project.id, [updatedRef]),
          ).toEqual([
            { responseId: first.ref.responseId, analysis: indexedAnalysis(updatedAnalysis) },
          ]);
          await db.query(
            "UPDATE prompt_responses SET s3_key='another-capture' WHERE id=$1",
            [id],
          );
          expect(
            await repository.listSavedAnalyses(project.id, [updatedRef]),
          ).toEqual([]);
          await db.query(
            "UPDATE prompt_responses SET s3_key=$2,json_response=json_response-'analysis' WHERE id=$1",
            [id, updated.captureKey],
          );
          expect(
            await repository.listSavedAnalyses(project.id, [updatedRef]),
          ).toEqual([]);
        }
      } finally {
        await db?.close();
      }
    }, 30000);
  },
);
