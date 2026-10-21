import { describe, expect, it, vi } from 'vitest';
import {
  reportingCompanies,
  type Analysis,
  type CapturedAnswer,
  type RunSnapshot,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import {
  parseScoredExtraction,
  scoredExtractionRequest,
} from '../apps/scanner/src/scoring-extraction.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { reanalyzeCapturedRun } from '../apps/scanner/src/reanalysis.js';
import { captured } from '../apps/scanner/test/fixtures.js';
import { newProject } from './fixtures/scanner.js';

const receipt = (raw: unknown) => ({
  response: {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(raw) }],
    }],
  },
  requestId: 'sentiment-test', receivedAt: '2026-10-20T12:00:00.000Z',
});
const companyRows = [
  { name: 'Northstar', evidenceId: 0, sentiment: 'positive', sentimentEvidenceId: 0 },
  { name: 'Clearview', evidenceId: 1, sentiment: 'negative', sentimentEvidenceId: 1 },
  { name: 'Metriclane', evidenceId: 2, sentiment: 'neutral', sentimentEvidenceId: 2 },
  { name: 'Skyward', evidenceId: 3, sentiment: 'positive', sentimentEvidenceId: 3 },
];
const answer = () => captured([
  'Northstar is excellent.',
  'Clearview is unreliable.',
  'Metriclane is another provider.',
  'Skyward is a strong option.',
].join('\n'));
function rawFor(snapshot: RunSnapshot) {
  return {
    companies: structuredClone(companyRows),
    brands: Object.fromEntries([snapshot.brand, ...snapshot.competitors].map((brand) => {
      const company = companyRows.find((row) => row.name === brand.name)!;
      return [brand.id, {
        mentioned: true, sentiment: company.sentiment,
        evidenceIds: [company.evidenceId], sentimentEvidenceId: company.sentimentEvidenceId,
        explicitRank: null, rankEvidenceId: null,
      }];
    })),
  };
}
const projectSnapshot = () => {
  const project = newProject({ prompts: ['Which providers should I compare?'] });
  return { ...project, projectName: project.name, configVersion: project.version };
};

describe('competitor sentiment in saved scans', () => {
  it('requires sentiment for every discovered company and preserves separate assessments and evidence', () => {
    const snapshot = projectSnapshot();
    const request = scoredExtractionRequest(answer(), snapshot);
    expect(request.schema).toMatchObject({ properties: { companies: {
      items: { required: ['name', 'evidenceId', 'sentiment', 'sentimentEvidenceId'] },
    } } });
    const analysis = parseScoredExtraction(receipt(rawFor(snapshot)), answer(), snapshot);
    expect(analysis.brands.map((row) => [row.brandId, row.sentimentScore])).toEqual([
      ['target', 100], ['clearview', 0], ['metriclane', 50],
    ]);
    expect(
      analysis.companies?.map((row) => [row.name, row.sentiment, row.sentimentScore]),
    ).toEqual([
      ['Northstar', 'positive', 100], ['Clearview', 'negative', 0],
      ['Metriclane', 'neutral', 50], ['Skyward', 'positive', 100],
    ]);
    expect(analysis.companies?.[3].sentimentEvidence?.quote).toBe('Skyward is a strong option.');
    expect(
      reportingCompanies(analysis, snapshot, answer())
        .find((row) => row.company === 'Skyward'),
    ).toMatchObject({
      sentiment: 'positive', sentimentScore: 100, tracked: false,
    });
  });

  it('keeps untracked sentiment unknown when its evidence refers to a different company and rejects nonexistent references', () => {
    const snapshot = projectSnapshot();
    const raw = rawFor(snapshot);
    raw.companies[3].sentimentEvidenceId = 0;
    const analysis = parseScoredExtraction(receipt(raw), answer(), snapshot);
    expect(analysis.companies?.[3]).toMatchObject({
      name: 'Skyward', sentiment: 'unknown', sentimentScore: null, sentimentEvidence: null,
    });
    raw.companies[3].sentimentEvidenceId = 999;
    expect(() =>
      parseScoredExtraction(receipt(raw), answer(), snapshot),
    ).toThrow('unknown evidence ID');
  });

  it('persists competitor scores and untracked assessments in results, artifacts, and indexed analyses', async () => {
    const project = newProject({ prompts: ['Which providers should I compare?'] });
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const provider = {
      collect: vi.fn(async () => answer()),
      extract: vi.fn(async (saved: CapturedAnswer, snapshot: RunSnapshot) =>
        parseScoredExtraction(receipt(rawFor(snapshot)), saved, snapshot),
      ),
    };
    const scanner = new Scanner({ repository, artifacts, queue, provider });
    await scanner.handle({
      kind: 'kickoff', projectId: project.id,
      scheduledAt: new Date().toISOString(), trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const run = (await repository.listRuns(project.id))[0];
    expect(run.status).toBe('completed');
    const [result] = await repository.listResults(project.id, run.id);
    expect(result.brands?.find((row) => row.brandId === 'clearview')).toMatchObject({
      mentioned: true, sentiment: 'negative', sentimentScore: 0,
      sentimentEvidence: { quote: 'Clearview is unreliable.' },
    });
    const saved = await artifacts.get<Analysis>(result.analysisKey!);
    expect(
      saved?.companies?.find((row) => row.name === 'Skyward'),
    ).toMatchObject({ sentiment: 'positive', sentimentScore: 100 });
    const indexed = await repository.listSavedAnalyses(project.id, [{
      responseId: result.responseId,
      captureKey: result.captureKey!,
      analysisKey: result.analysisKey,
    }]);
    expect(indexed[0].analysis).toEqual(saved);
    expect(provider.collect).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledOnce();
  });

  it('reassesses saved answers against current competitors without recollecting or reusing a stale staged receipt', async () => {
    const project = newProject({ prompts: ['Which providers should I compare?'] });
    project.competitors = [];
    const repository = new MemoryRepository(),
      artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue();
    await repository.saveProject(project, null);
    const provider = {
      collect: vi.fn(async () => answer()),
      extract: vi.fn(async (saved: CapturedAnswer, snapshot: RunSnapshot) =>
        parseScoredExtraction(receipt(rawFor(snapshot)), saved, snapshot),
      ),
    };
    const scanner = new Scanner({ repository, artifacts, queue, provider });
    await scanner.handle({
      kind: 'kickoff', projectId: project.id,
      scheduledAt: new Date().toISOString(), trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const source = (await repository.listRuns(project.id))[0];
    const [original] = await repository.listResults(project.id, source.id);
    await artifacts.put(
      `${original.captureKey}.scored-v2.json`,
      await artifacts.get(original.analysisKey!),
    );
    await repository.saveProject({
      ...project, version: project.version + 1,
      competitors: [{ id: 'skyward', name: 'Skyward', aliases: [], domains: ['skyward.example'] }],
    }, project.version);
    provider.collect.mockClear();
    provider.extract.mockClear();
    const rescore = await reanalyzeCapturedRun(
      { repository, artifacts, queue },
      project.id, source.id, 'competitor-rescore',
    );
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const replacement = await repository.getRun(project.id, rescore.runId);
    expect(replacement?.snapshot).toMatchObject({
      brand: source.snapshot.brand, prompts: source.snapshot.prompts,
      provider: source.snapshot.provider, generationModel: source.snapshot.generationModel,
      extractionModel: source.snapshot.extractionModel,
      competitors: [{ id: 'skyward', name: 'Skyward' }],
    });
    const [result] = await repository.listResults(project.id, rescore.runId);
    expect(result).toMatchObject({
      captureKey: original.captureKey,
      capturedAt: original.capturedAt,
      status: 'succeeded',
    });
    expect(
      result.brands?.find((row) => row.brandId === 'skyward'),
    ).toMatchObject({ sentiment: 'positive', sentimentScore: 100 });
    expect(provider.collect).not.toHaveBeenCalled();
    expect(provider.extract).toHaveBeenCalledOnce();
    expect(await repository.getRun(project.id, source.id)).toEqual(source);
    expect(await repository.listResults(project.id, source.id)).toEqual([original]);
    const duplicate = await reanalyzeCapturedRun(
      { repository, artifacts, queue },
      project.id, source.id, 'competitor-rescore',
    );
    expect(duplicate.runId).toBe(rescore.runId);
  });
});
