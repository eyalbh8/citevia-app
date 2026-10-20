import { describe, expect, it, vi } from 'vitest';
import {
  brandRank,
  brandSentimentScore,
  metricsFromResults,
  promptMetrics,
  type BrandAnalysis,
  type PromptResult,
  type ScanRun,
} from '@citevia/core';
import {
  answerEvidenceCatalog,
  parseScoredExtraction,
  scoredExtractionRequest,
  SCORED_PARSER_VERSION,
} from '../apps/scanner/src/scoring-extraction.js';
import { OpenAIAnswerProvider } from '../apps/scanner/src/openai.js';
import { captured, snapshot, target } from '../apps/scanner/test/fixtures.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { Scanner } from '../apps/scanner/src/engine.js';
import { reanalyzeCapturedRun } from '../apps/scanner/src/reanalysis.js';
import { createApi } from '../apps/api/src/app.js';
import { testIdentity } from './fixtures/users.js';

const receipt = (value: unknown) => ({
  response: {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(value) }],
      },
    ],
  },
  requestId: 'test',
  receivedAt: new Date().toISOString(),
});
const row = {
  mentioned: true,
  sentiment: 'negative',
  evidenceIds: [0],
  sentimentEvidenceId: 0,
  explicitRank: null,
  rankEvidenceId: null,
};
const scoredSnapshot = {
  ...snapshot,
  competitors: [],
  parserVersion: SCORED_PARSER_VERSION,
};

describe('iGEO numeric scoring', () => {
  it.each([
    ['positive', 100],
    ['neutral', 50],
    ['mixed', 50],
    ['negative', 0],
    ['unknown', null],
    ['not_applicable', null],
  ] as const)(
    'maps %s to %s without confusing zero with missing data',
    (sentiment, score) => {
      expect(
        brandSentimentScore({ mentioned: true, sentiment } as BrandAnalysis),
      ).toBe(score);
      expect(
        brandSentimentScore({ mentioned: false, sentiment } as BrandAnalysis),
      ).toBeNull();
    },
  );
  it('uses appearance rank without turning the first tracked mention into rank one', () => {
    expect(
      brandRank({
        mentioned: true,
        appearanceRank: 3,
        explicitRank: null,
        mentionOrder: 1,
      } as BrandAnalysis),
    ).toBe(3);
    expect(
      brandRank({
        mentioned: true,
        explicitRank: null,
        mentionOrder: 1,
      } as BrandAnalysis),
    ).toBeNull();
  });
  it('matches the iGEO weighted sentiment formula, excluding unknowns, absence and failed answers', () => {
    const results = ['positive', 'negative', 'neutral', 'mixed', 'unknown'].map(
      (sentiment) => ({
        status: 'succeeded',
        target: {
          mentioned: true,
          sentiment,
          explicitRank: null,
          appearanceRank: 2,
        },
      }),
    ) as PromptResult[];
    results.push(
      { status: 'failed_extraction' } as PromptResult,
      {
        status: 'succeeded',
        target: {
          mentioned: false,
          sentiment: 'not_applicable',
          explicitRank: null,
        },
      } as PromptResult,
    );
    expect(metricsFromResults(results).sentimentScore).toEqual({
      value: 50,
      numerator: 200,
      denominator: 4,
    });
    expect(metricsFromResults(results).averageRank.value).toBe(2);
  });
});
describe('saved answer evidence and full company appearance order', () => {
  it('derives rank across untracked alternatives, not generated array order, preserving exact Unicode spans', () => {
    const answer = captured(
      '🧭 Bravo is useful. Acme has important limitations. Delta is another option.',
    );
    const result = parseScoredExtraction(
      receipt({
        companies: [
          { name: 'Delta', evidenceId: 0 },
          { name: 'Acme', evidenceId: 0 },
          { name: 'Bravo', evidenceId: 0 },
          { name: 'ACME', evidenceId: 0 },
        ],
        brands: { [target.id]: row },
      }),
      answer,
      scoredSnapshot,
    );
    expect(
      result.companies?.map((company) => [company.name, company.rank]),
    ).toEqual([
      ['Bravo', 1],
      ['Acme', 2],
      ['Delta', 3],
    ]);
    expect(result.brands[0]).toMatchObject({
      appearanceRank: 2,
      explicitRank: null,
      sentimentScore: 0,
      mentionOrder: 1,
    });
    for (const span of result.brands[0].evidence)
      expect(answer.blocks[0].text.slice(span.start, span.end)).toBe(
        span.quote,
      );
  });
  it('keeps a numbered recommendation separate from company appearance', () => {
    const answer = captured(
      '2. Acme is useful.\nBravo is another alternative.',
    );
    const result = parseScoredExtraction(
      receipt({
        companies: [
          { name: 'Acme', evidenceId: 0 },
          { name: 'Bravo', evidenceId: 1 },
        ],
        brands: {
          [target.id]: {
            ...row,
            sentiment: 'positive',
            explicitRank: 2,
            rankEvidenceId: 0,
          },
        },
      }),
      answer,
      scoredSnapshot,
    );
    expect(result.brands[0]).toMatchObject({
      appearanceRank: 1,
      explicitRank: 2,
      sentimentScore: 100,
    });
  });
  it('rejects invented evidence IDs, company names, contradictory presence and URL-only names', () => {
    for (const companies of [
      [{ name: 'Acme', evidenceId: 999 }],
      [{ name: 'Invented', evidenceId: 0 }],
      [],
      [{ name: 'Bravo', evidenceId: 0 }],
    ]) {
      expect(() =>
        parseScoredExtraction(
          receipt({ companies, brands: { [target.id]: row } }),
          captured('Acme has limitations.'),
          scoredSnapshot,
        ),
      ).toThrow();
    }
    expect(() =>
      parseScoredExtraction(
        receipt({
          companies: [{ name: 'Acme', evidenceId: 0 }],
          brands: { [target.id]: row },
        }),
        captured('Source: https://acme.com/about'),
        scoredSnapshot,
      ),
    ).toThrow('Company evidence');
  });
  it('uses schema-bound evidence references and fixed brand keys, without generated quotes or offsets', () => {
    const request = scoredExtractionRequest(
      captured('Acme is useful.'),
      scoredSnapshot,
    );
    expect(request.schema.properties.brands).toMatchObject({
      required: [target.id],
      additionalProperties: false,
    });
    expect(request.schema.$defs.evidenceId).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 0,
    });
    expect(request.instructions).toContain('untracked companies');
    expect(
      answerEvidenceCatalog(captured('x'.repeat(2000))).every(
        (span) => span.quote.length <= 900,
      ),
    ).toBe(true);
  });
  it('retains a single failed native analysis receipt and requires explicit retry', async () => {
    const extract = vi.fn(async () =>
      receipt({
        companies: [{ name: 'Acme', evidenceId: 999 }],
        brands: { [target.id]: row },
      }),
    );
    await expect(
      new OpenAIAnswerProvider({ answer: vi.fn(), extract }).extract(
        captured('Acme is useful.'),
        scoredSnapshot,
      ),
    ).rejects.toMatchObject({ retryable: false, receipt: expect.any(Object) });
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
describe('prompt table score fields', () => {
  it('exposes the iGEO score fields only to account members', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.syncUser(testIdentity('owner'));
    const project = newProject({
      prompts: ['Which reporting tools should I compare?'],
    });
    await repository.saveProject(project, null);
    await repository.putMembership({
      projectId: project.id,
      userId: 'owner',
      role: 'owner',
    });
    const scanner = new Scanner({
      repository,
      artifacts,
      queue,
      provider: new FixtureProvider(),
    });
    await scanner.handle({
      kind: 'kickoff',
      projectId: project.id,
      scheduledAt: new Date().toISOString(),
      trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const run = (await repository.listRuns(project.id))[0];
    const api = createApi({ repository, artifacts, queue }, { mode: 'live' });
    const request = () =>
      new Request(
        `https://test/v1/projects/${project.id}/prompt-metrics?runId=${run.id}`,
      );
    const response = await api(request(), testIdentity('owner'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      regions: [project.country],
      language: project.language,
      visibilityChange: null,
      rankChange: null,
      sentimentChange: null,
    });
    expect(body.items[0]).toHaveProperty('avgRank');
    expect(body.items[0]).toHaveProperty('avgSentimentScore');
    expect((await api(request(), testIdentity('outsider'))).status).toBe(404);
  });
  it('returns numbers and comparable changes, preserving absent and unmeasured nulls', () => {
    const project = newProject({ prompts: ['Is Acme useful?'] });
    const snap = {
      ...snapshot,
      brand: project.brand,
      competitors: project.competitors,
      country: project.country,
      language: project.language,
      generationModel: project.generationModel,
      extractionModel: project.extractionModel,
      parserVersion: project.parserVersion,
    };
    const current = {
      id: 'current',
      projectId: project.id,
      snapshot: snap,
    } as ScanRun;
    const previous = { ...current, id: 'previous' };
    const result = (
      runId: string,
      score: 'negative' | 'neutral',
      rank: number,
    ) =>
      ({
        projectId: project.id,
        runId,
        promptId: project.prompts[0].id,
        prompt: project.prompts[0],
        status: 'succeeded',
        target: {
          mentioned: true,
          sentiment: score,
          appearanceRank: rank,
          explicitRank: null,
        },
      }) as PromptResult;
    const rows = promptMetrics(
      project,
      current,
      [result('current', 'negative', 1)],
      previous,
      [result('previous', 'neutral', 2)],
    );
    expect(rows[0]).toMatchObject({
      avgVisibility: 100,
      avgRank: 1,
      avgSentimentScore: 0,
      sentimentChange: -100,
      rankChange: 50,
      visibilityChange: 0,
    });
    expect(promptMetrics(project, current, [])[0]).toMatchObject({
      avgVisibility: null,
      avgRank: null,
      avgSentimentScore: null,
      rankChange: null,
    });
    const older = result('current', 'negative', 1);
    project.prompts[0] = { ...project.prompts[0], version: 2 };
    expect(
      promptMetrics(project, current, [older], previous, [])[0],
    ).toMatchObject({
      avgVisibility: null,
      avgRank: null,
      avgSentimentScore: null,
      sentimentChange: null,
    });
  });
});
describe('saved-answer reanalysis', () => {
  it('creates one idempotent report and never recollects missing or captured answers', async () => {
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    const project = newProject({
      prompts: ['Compare reporting tools.', 'Compare setup options.'],
    });
    await repository.saveProject(project, null);
    const provider = new FixtureProvider(),
      scanner = new Scanner({ repository, artifacts, queue, provider });
    await scanner.handle({
      kind: 'kickoff',
      projectId: project.id,
      scheduledAt: new Date().toISOString(),
      trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const original = (await repository.listRuns(project.id))[0];
    const originalRows = await repository.listResults(project.id, original.id);
    const collect = vi.spyOn(provider, 'collect');
    const extract = vi.spyOn(provider, 'extract');
    const saved = await artifacts.get<any>(originalRows[1].analysisKey!);
    await artifacts.put(`${originalRows[1].captureKey}.scored-v2.json`, {
      ...saved,
      parserVersion: SCORED_PARSER_VERSION,
      model: original.snapshot.extractionModel,
    });
    const result = await reanalyzeCapturedRun(
      { repository, artifacts, queue },
      project.id,
      original.id,
      'repeatable-rescore',
    );
    const duplicate = await reanalyzeCapturedRun(
      { repository, artifacts, queue },
      project.id,
      original.id,
      'repeatable-rescore',
    );
    expect(duplicate.runId).toBe(result.runId);
    expect(await repository.listRuns(project.id)).toHaveLength(2);
    const pending = await repository.listResults(project.id, result.runId);
    artifacts.values.delete(pending[0].captureKey!);
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    expect(collect).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(
      (await repository.listResults(project.id, result.runId))[0].status,
    ).toBe('failed_extraction');
    expect(await repository.listResults(project.id, original.id)).toEqual(
      originalRows,
    );
  });
});
