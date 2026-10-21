import { expect, it } from 'vitest';
import {
  type Analysis,
  type CapturedAnswer,
  type Page,
  type PromptAnswerRow,
  type PromptResult,
  type ScanProvider,
  type ScanRun,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
  PostgresRepository,
  uuidFor,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

it.each(['memory', 'postgres'])(
  'serves every saved answer and preserves history through archive/reactivation (%s)',
  async (backend) => {
    const db = backend === 'postgres' ? await localPostgres() : undefined;
    let repository = db ? new PostgresRepository(db) : new MemoryRepository();
    const artifacts = new MemoryArtifacts();
    try {
      const project = newProject({
        id: 'answer-history',
        prompts: ['Where can I check Northstar’s status?', 'Another question?'],
      });
      await repository.saveProject(project, null);
      await repository.syncUser(testIdentity('answers-owner'));
      await repository.syncUser(testIdentity('answers-viewer'));
      await repository.putMembership({
        projectId: project.id,
        userId: 'answers-owner',
        role: 'owner',
      });
      await repository.putMembership({
        projectId: project.id,
        userId: 'answers-viewer',
        role: 'viewer',
      });
      const prompt = project.prompts[0];
      async function observation(
        index: number,
        provider: ScanProvider,
        at: string,
        promptIndex = 0,
      ) {
        const id = `history_${index}`,
          captured = project.prompts[promptIndex];
        const run: ScanRun = {
          projectId: project.id,
          id,
          scheduledAt: at,
          createdAt: at,
          status: 'completed',
          trigger: 'manual',
          snapshot: {
            projectName: project.name,
            brand: project.brand,
            competitors: project.competitors,
            prompts: project.prompts,
            country: 'IT',
            language: 'en',
            timezone: 'UTC',
            provider,
            generationModel: `${provider}-model`,
            extractionModel: 'extract-test',
            parserVersion: project.parserVersion,
            configVersion: 1,
          },
          totalCount: 1,
          terminalCount: 1,
          succeededCount: 1,
          capturedCount: 1,
          resultVersion: 1,
          deadlineAt: at,
          expiresAt: 2000000000,
        };
        const result: PromptResult = {
          projectId: project.id,
          runId: id,
          promptId: captured.id,
          prompt: { ...captured },
          responseId: `${id}~${captured.id}`,
          status: 'succeeded',
          version: 1,
          attempts: 1,
          capturedAt: at,
          captureKey: `${id}/capture`,
          analysisKey: `${id}/analysis`,
          citationCount: index + 1,
          sourceCount: 1,
          expiresAt: 2000000000,
          target: {
            brandId: project.brand.id,
            mentioned: true,
            appearanceRank: index + 1,
            explicitRank: null,
            mentionOrder: 1,
            sentiment: 'positive',
            evidence: [],
            rankEvidence: null,
            sentimentEvidence: null,
          },
        };
        const answer: CapturedAnswer = {
          provider,
          providerResponseId: id,
          model: `${provider}-model`,
          status: 'completed',
          text: `**Northstar** answer ${index}\n\n### Official information\n\n- Preserved original text`,
          blocks: [],
          citations: [],
          sources: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          createdAt: at,
          raw: { id },
        };
        const analysis: Analysis = {
          brands: [result.target!],
          parserVersion: project.parserVersion,
          model: 'extract-test',
          createdAt: at,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
        await artifacts.put(result.captureKey!, answer);
        await artifacts.put(result.analysisKey!, analysis);
        await repository.createRun(run, [result]);
        await repository.saveMeasurement(result, run, answer, analysis);
        return { run, result, answer };
      }
      const original = await observation(
        0,
        'openai',
        '2026-10-13T12:00:00.000Z',
      );
      for (let i = 1; i < 24; i++)
        await observation(
          i,
          i % 2 ? 'gemini' : 'perplexity',
          '2026-10-20T12:00:00.000Z',
        );
      await observation(24, 'gemini', '2026-10-20T12:00:00.000Z', 1);
      // Successful reanalysis of the same captured answer is one history row at the original date.
      const reanalysis = {
        ...original.run,
        id: 'reanalysis',
        createdAt: '2026-10-21T10:00:00.000Z',
        reanalysisOf: original.run.id,
      };
      await repository.createRun(reanalysis, [
        {
          ...original.result,
          runId: reanalysis.id,
          responseId: `reanalysis~${prompt.id}`,
        },
      ]);
      const failed = {
        ...original.run,
        id: 'failed',
        createdAt: '2026-10-21T11:00:00.000Z',
      };
      await repository.createRun(failed, [
        {
          ...original.result,
          runId: failed.id,
          responseId: `failed~${prompt.id}`,
          status: 'failed_collection',
          captureKey: undefined,
          analysisKey: undefined,
          capturedAt: undefined,
          target: undefined,
          citationCount: 0,
        },
      ]);
      const pending = {
        ...reanalysis,
        id: 'pending',
        createdAt: '2026-10-21T12:00:00.000Z',
      };
      await repository.createRun(pending, [
        {
          ...original.result,
          runId: pending.id,
          responseId: `pending~${prompt.id}`,
          status: 'extracting',
          target: undefined,
        },
      ]);
      // New instance proves history does not depend on process-local scan state.
      if (db) repository = new PostgresRepository(db);
      const api = createApi(
        { repository, artifacts, queue: new MemoryQueue() },
        { mode: 'live', now: () => new Date('2026-10-21T23:59:59.999Z') },
      );
      const call = (tail: string, who = 'answers-owner', body?: unknown) =>
        api(
          new Request(`http://test/v1/projects/${project.id}/${tail}`, {
            method: body ? 'PATCH' : 'GET',
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          testIdentity(who),
        );
      const endpoint = `prompts/${prompt.id}/responses`;
      const list = async (suffix = '') => {
        const response = await call(`${endpoint}${suffix}`, 'answers-viewer');
        expect(response.status).toBe(200);
        return (await response.json()) as Page<PromptAnswerRow>;
      };
      const first = await list('?limit=20');
      expect(first.total).toBe(25);
      expect(first.items).toHaveLength(20);
      expect(first.items[0]).toMatchObject({
        responseId: `failed~${prompt.id}`,
        status: 'failed_collection',
        visibility: null,
        rank: null,
        sentimentScore: null,
        answerPreview: null,
      });
      const second = await list(`?limit=20&cursor=${first.nextCursor}`);
      expect(second.items).toHaveLength(5);
      expect(
        new Set([...first.items, ...second.items].map((row) => row.responseId))
          .size,
      ).toBe(25);
      const oldest = second.items.at(-1)!;
      expect(oldest).toMatchObject({
        responseId: `reanalysis~${prompt.id}`,
        date: original.answer.createdAt,
        promptVersion: 1,
        country: 'IT',
        answerPreview: original.answer.text,
        brands: ['Northstar'],
      });
      expect((await list('?days=7')).total).toBe(24);
      expect((await list('?provider=gemini')).total).toBe(12);
      expect((await list('?sort=rank&direction=asc')).items[0].rank).toBe(1);
      for (const suffix of [
        '?days=8',
        '?provider=bad',
        '?sort=bad',
        '?direction=bad',
        '?cursor=bad',
        '?limit=101',
      ])
        expect((await call(`${endpoint}${suffix}`)).status).toBe(400);
      expect((await call(endpoint, 'outsider')).status).toBe(404);
      expect((await call('prompts/absent/responses')).status).toBe(404);
      expect(
        (
          await call(`prompts/${prompt.id}`, 'answers-viewer', {
            version: 1,
            active: false,
          })
        ).status,
      ).toBe(403);
      const archived = await call(`prompts/${prompt.id}`, 'answers-owner', {
        version: 1,
        active: false,
      });
      expect(archived.status).toBe(200);
      expect((await list()).total).toBe(25);
      const restored = await call(`prompts/${prompt.id}`, 'answers-owner', {
        version: 2,
        active: true,
      });
      expect(restored.status).toBe(200);
      expect(
        (await repository.getProject(project.id))?.prompts[0],
      ).toMatchObject({ active: true, version: 3 });
      expect((await list()).total).toBe(25);
      const detail = await call(
        `responses/${encodeURIComponent(oldest.responseId)}`,
      );
      expect((await detail.json()).answer.text).toBe(original.answer.text);
      if (db) {
        const nativeAnswer = (
          await db.query('SELECT response FROM prompt_responses WHERE id=$1', [
            uuidFor(`${project.id}:response:${original.result.responseId}`),
          ])
        ).rows[0];
        expect(nativeAnswer.response).toBe(original.answer.text);
        expect(
          (
            await db.query('SELECT is_active FROM prompts WHERE id=$1', [
              uuidFor(`${project.id}:prompt:${prompt.id}`),
            ])
          ).rows[0].is_active,
        ).toBe(true);
        expect(
          (
            await repository.listPromptHistory(
              project.id,
              '1970-01-01T00:00:00Z',
              '2026-10-22T00:00:00Z',
              project.prompts[1].id,
            )
          ).results,
        ).toHaveLength(1);
      }
    } finally {
      await db?.close();
    }
  },
);
