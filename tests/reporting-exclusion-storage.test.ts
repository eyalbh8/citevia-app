import { expect, it } from 'vitest';
import type { PromptResult, ScanRun, TrackedUrl } from '@citevia/core';
import {
  MemoryRepository,
  PostgresRepository,
  type Repository,
  type PromptAnswerPageOptions,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { promptAnswers } from '../apps/api/src/prompt-answers.js';
import {
  project as fixture,
  snapshot,
  captured,
  analysis,
} from '../apps/scanner/test/fixtures.js';

const start = '2026-10-20T00:00:00.000Z';
const end = '2026-10-20T23:59:59.999Z';
const excludedAt = '2026-10-23T00:00:00.000Z';
const exclusion = {
  reportingExcludedAt: excludedAt,
  reportingExclusionReason: 'Keep the later October 20 scan round',
};

/** Mirrors an operator changing reporting metadata after receipts are already saved. */
class MutableMemoryRepository extends MemoryRepository {
  exclude(run: ScanRun) {
    return this.operation(() => {
      const stored = this.state.runs[`${run.projectId}:${run.id}`];
      Object.assign(stored, exclusion);
    }, true);
  }
}

it.each(['memory', 'postgres'])(
  'hides an earlier scan and its reanalysis from reports while preserving stored evidence (%s)',
  async (backend) => {
    const db = backend === 'postgres' ? await localPostgres() : undefined;
    const repository: Repository = db
      ? new PostgresRepository(db)
      : new MutableMemoryRepository();
    try {
      const project = { ...structuredClone(fixture), id: 'reporting-exclusion' };
      await repository.saveProject(project, null);
      const prompt = project.prompts[0];
      const tracked: TrackedUrl = {
        id: 'f88c9a89-27db-40ce-b705-b029730aebaf',
        projectId: project.id,
        url: 'https://example.org/review',
        normalizedUrl: 'example.org/review',
        title: 'Review',
        contentType: 'WEBSITE',
        active: true,
        createdAt: start,
        updatedAt: start,
        publishedAt: start,
        version: 1,
      };
      await repository.registerTrackedUrl(tracked);

      const observation = async (index: number, hour: number, original?: {
        run: ScanRun;
        result: PromptResult;
      }) => {
        const id = `run_${index.toString(16).padStart(24, '0')}`;
        const at = `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`;
        const run: ScanRun = {
          id,
          projectId: project.id,
          scheduledAt: at,
          createdAt: at,
          status: 'completed',
          trigger: 'manual',
          snapshot: { ...snapshot, provider: 'openai', prompts: project.prompts },
          ...(original ? { reanalysisOf: original.run.id } : {}),
          totalCount: 1,
          terminalCount: 1,
          succeededCount: 1,
          capturedCount: 1,
          resultVersion: 1,
          deadlineAt: end,
          expiresAt: 2000000000,
        };
        const answer = captured();
        answer.createdAt = original?.result.capturedAt || at;
        const analyzed = analysis(answer);
        const result: PromptResult = {
          projectId: project.id,
          runId: id,
          promptId: prompt.id,
          responseId: `${id}~${prompt.id}`,
          prompt,
          status: 'succeeded',
          version: 1,
          attempts: 1,
          captureKey: original?.result.captureKey || `captures/${id}`,
          analysisKey: `analysis/${id}`,
          capturedAt: answer.createdAt,
          citationCount: answer.citations.length,
          sourceCount: answer.sources.length,
          target: analyzed.brands[0],
          expiresAt: 2000000000,
        };
        expect(await repository.createRun(run, [result])).toBe(true);
        await repository.saveMeasurement(result, run, answer, analyzed);
        return { run, result };
      };
      const original = await observation(1, 8);
      const reanalysis = await observation(2, 9, original);
      const kept = await observation(3, 15);
      const options: PromptAnswerPageOptions = {
        start,
        end,
        promptId: prompt.id,
        sort: 'date',
        direction: 'desc',
        offset: 0,
        limit: 1,
      };
      const answers = async () => promptAnswers(
        await repository.listPromptHistory(project.id, start, end),
        project.id, prompt.id, undefined, 'date', 'desc',
      );
      expect((await answers()).map((row) => row.run.id)).toEqual([
        kept.run.id, reanalysis.run.id,
      ]);
      expect((await repository.listTrackingMatches(project.id)).map((row) => row.capture.runId))
        .toEqual([kept.run.id, reanalysis.run.id]);
      if (repository.listPromptAnswerPage) {
        expect(await repository.listPromptAnswerPage(project.id, options))
          .toMatchObject({ total: 2, items: [{ run: { id: kept.run.id } }] });
        expect(await repository.listPromptAnswerPage(project.id, { ...options, offset: 1 }))
          .toMatchObject({ total: 2, items: [{ run: { id: reanalysis.run.id } }] });
      }

      for (const { run } of [original, reanalysis]) {
        if (db) {
          // Full fixture manifests keep legacy JSON-to-typed counter triggers unchanged.
          await db.query(
            'UPDATE citevia_runs SET data=$3::jsonb WHERE project_id=$1 AND id=$2',
            [project.id, run.id, JSON.stringify({ ...run, ...exclusion })],
          );
        } else await (repository as MutableMemoryRepository).exclude(run);
      }

      expect((await repository.listRuns(project.id)).map((run) => run.id)).toEqual([kept.run.id]);
      const history = await repository.listPromptHistory(project.id, start, end, prompt.id);
      expect(history.runs.map((run) => run.id)).toEqual([kept.run.id]);
      expect(history.results).toEqual([kept.result]);
      expect((await answers()).map((row) => row.run.id)).toEqual([kept.run.id]);
      expect((await repository.listTrackingMatches(project.id, tracked.id)).map((row) => row.capture.runId))
        .toEqual([kept.run.id]);
      expect(await repository.listRuns('another-project')).toEqual([]);
      expect(await repository.listPromptHistory('another-project', start, end))
        .toEqual({ runs: [], results: [] });
      expect(await repository.listTrackingMatches('another-project')).toEqual([]);
      if (repository.listPromptAnswerPage) {
        expect(await repository.listPromptAnswerPage(project.id, options))
          .toMatchObject({ total: 1, items: [{ run: { id: kept.run.id } }] });
        expect(await repository.listPromptAnswerPage(project.id, { ...options, offset: 1 }))
          .toEqual({ total: 1, items: [] });
        expect(await repository.listPromptAnswerPage('another-project', options))
          .toEqual({ total: 0, items: [] });
      }

      for (const item of [original, reanalysis]) {
        expect(await repository.getRun(project.id, item.run.id)).toMatchObject({
          ...item.run, ...exclusion,
        });
        expect(await repository.listResults(project.id, item.run.id)).toEqual([item.result]);
        expect(await repository.getResult(project.id, item.run.id, prompt.id)).toEqual(item.result);
      }
      // Historical receipts remain available by explicit identity for auditing or reversal.
      expect(await repository.listNativeCitations(project.id, [`openai:${original.result.captureKey}`]))
        .toMatchObject([{ citations: [{ url: tracked.url }] }]);
      if (db) {
        expect((await db.query('SELECT count(*)::int AS total FROM citevia_prompt_results WHERE project_id=$1', [project.id])).rows[0].total)
          .toBe(3);
        expect((await db.query('SELECT count(*)::int AS total FROM citevia_citation_captures WHERE project_id=$1', [project.id])).rows[0].total)
          .toBe(2);
      }
    } finally {
      await db?.close();
    }
  },
  30000,
);
