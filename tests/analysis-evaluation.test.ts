import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, BrandAnalysis } from '@citevia/core';
import { captured, snapshot } from '../apps/scanner/test/fixtures.js';
import { evaluateAnalysis, labelledMetrics, parseEvaluationSamples, runEvaluationCli, type ExpectedAnalysis } from '../scripts/evaluate-analysis.js';
import type { ResponseProvider } from '../apps/scanner/src/provider.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const answer = captured('1. Acme is useful.');
const evidence = { blockId: answer.blocks[0].id, quote: answer.text, start: 0, end: answer.text.length };
const sample = {
  id: 'sample-1', answer,
  snapshot: { ...snapshot, extractionModel: 'gpt-4.1-mini-2025-04-14', competitors: [] },
};
const brandRow = (brandId = 'acme', changes: Partial<BrandAnalysis> = {}): BrandAnalysis => ({
  brandId, mentioned: true, sentiment: 'positive', explicitRank: 1, appearanceRank: 1,
  mentionOrder: 1, evidence: [evidence], sentimentEvidence: evidence, rankEvidence: evidence,
  ...changes,
});
const analysis = (changes: Partial<Analysis> = {}): Analysis => ({
  brands: [brandRow()], companies: [{ name: 'Acme', rank: 1, sentiment: 'positive', evidence }],
  model: 'test', parserVersion: snapshot.parserVersion, createdAt: '2026-10-22T12:00:00Z',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, ...changes,
});
function provider(invalidCandidate = false): ResponseProvider {
  const { appearanceRank: _, mentionOrder: __, ...observation } = brandRow();
  return {
    answer: vi.fn(async () => { throw new Error('Evaluation must not collect answers.'); }),
    extract: vi.fn(async (request) => ({
      response: {
        status: 'completed', model: request.model,
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: invalidCandidate && request.model === 'gpt-6-luna' ? '{}' : JSON.stringify({ brands: [observation] }) }] }],
      },
      requestId: 'evaluation-test', receivedAt: '2026-10-22T12:00:00Z',
    })),
  };
}

describe('saved-answer analysis evaluation', () => {
  it('defaults to a local dry run without initializing credentials or making paid calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'citevia-analysis-eval-'));
    const input = join(directory, 'answers.jsonl');
    const output = join(directory, 'report.json');
    const factory = vi.fn(async () => provider());
    try {
      await writeFile(input, JSON.stringify(sample));
      const report = JSON.parse(await runEvaluationCli(['--input', input, '--output', output], factory));
      expect(factory).not.toHaveBeenCalled();
      expect(report).toMatchObject({ qualityProven: false, plan: { mode: 'dry-run', samples: 1, labelledSamples: 0, candidate: 'gpt-6-luna' } });
      expect(report.plan.models.map((item: { model: string }) => item.model)).toEqual(['gpt-4.1-mini-2025-04-14', 'gpt-6-luna']);
      expect(report.plan.models.every((item: { estimatedUsd: number }) => item.estimatedUsd > 0)).toBe(true);
      expect(await readFile(output, 'utf8')).not.toContain(answer.text);
      expect(await readFile(input, 'utf8')).toBe(JSON.stringify(sample));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('executes extraction only, retains parser failures and does not claim agreement is correctness', async () => {
    const responseProvider = provider(true);
    const report = await evaluateAnalysis([sample], { execute: true }, async () => responseProvider);
    expect(responseProvider.answer).not.toHaveBeenCalled();
    expect(responseProvider.extract).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      qualityProven: false,
      baseline: { valid: 1, invalid: 0 }, candidate: { valid: 0, invalid: 1, requestFailed: 0 },
      baselineAgreement: { pairedValidSamples: 0, mentions: { total: 0, value: null } },
      samples: [{ candidate: { status: 'invalid', errorCode: 'invalid_extraction' } }],
    });
    expect(JSON.stringify(report)).not.toContain(answer.text);
  });
  it('keeps explicit evaluation local under APP_MODE=aws without initializing database or S3 writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'citevia-analysis-eval-aws-'));
    const input = join(directory, 'answers.jsonl');
    vi.stubEnv('APP_MODE', 'aws');
    vi.stubEnv('OPENAI_API_KEY', 'evaluation-test-key');
    vi.stubEnv('EVIDENCE_BUCKET', undefined);
    vi.stubEnv('QUEUE_URL', undefined);
    const { appearanceRank: _, mentionOrder: __, ...observation } = brandRow();
    const fetcher = vi.fn(async (_url, init) => Response.json({
      status:'completed',model:JSON.parse(init.body).model,usage:{input_tokens:100,output_tokens:50,total_tokens:150},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({brands:[observation]})}]}],
    }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await writeFile(input, JSON.stringify(sample));
      const report = JSON.parse(await runEvaluationCli(['--input', input, '--execute']));
      expect(report).toMatchObject({baseline:{valid:1},candidate:{valid:1}});
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.every(([url])=>url==='https://api.openai.com/v1/responses')).toBe(true);
    } finally { await rm(directory, {recursive:true,force:true}); }
  });
  it('shares a request when the saved baseline and candidate are identical', async () => {
    const responseProvider = provider();
    const report = await evaluateAnalysis([{ ...sample, snapshot: { ...sample.snapshot, extractionModel: 'gpt-6-luna' } }], { execute: true }, async () => responseProvider);
    expect(responseProvider.extract).toHaveBeenCalledOnce();
    expect(report.plan.models).toHaveLength(1);
    expect(report).toMatchObject({ baselineAgreement: { pairedValidSamples: 1, mentions: { total: 1, correct: 1 } } });
  });
  it('does not report missing native evaluation usage as a free request', async () => {
    const responseProvider = provider();
    const original = responseProvider.extract;
    responseProvider.extract = async (request) => {
      const receipt = await original(request);
      return { ...receipt, response: { ...receipt.response, usage: undefined } };
    };
    const report = await evaluateAnalysis([sample], { execute: true }, async () => responseProvider);
    expect(report).toMatchObject({
      baseline: {valid:1},candidate:{valid:1},
      samples:[{baseline:{estimatedUsd:null},candidate:{estimatedUsd:null}}],
    });
  });
  it('keeps partial-label denominators explicit, penalizes abstentions and does not inflate sentiment with absent brands', () => {
    const first: ExpectedAnalysis = {
      brands: [
        { brandId: 'acme', mentioned: true, sentiment: 'positive', explicitRank: 1, evidence: [evidence] },
        { brandId: 'bravo', mentioned: false, sentiment: 'not_applicable', explicitRank: null },
      ],
      companies: [{ name: 'Acme', rank: 1 }, { name: 'Bravo', rank: 2 }],
    };
    const failed: ExpectedAnalysis = {
      brands: [{ brandId: 'acme', mentioned: true, sentiment: 'negative', explicitRank: 2, evidence: [evidence] }],
      companies: [{ name: 'Acme', rank: 1 }],
    };
    const metrics = labelledMetrics([
      { expected: first, analysis: analysis({ brands: [brandRow(), brandRow('bravo')], companies: [
        { name: 'ACME', rank: 1, evidence }, { name: 'Delta', rank: 2, evidence },
      ] }) },
      { expected: failed },
      { analysis: analysis() },
    ]);
    expect(metrics).toMatchObject({
      labelledSamples: 2, validLabelledSamples: 1,
      mentions: {
        truePositive: 1, falsePositive: 1, falseNegative: 0, abstainedPositive: 1,
        precision: 0.5, recall: 0.5, precisionDenominator: 2, recallDenominator: 2,
        accuracy: { correct: 1, total: 3, value: 1 / 3 },
      },
      sentiment: { correct: 1, total: 2, value: 0.5 },
      explicitRank: { correct: 1, total: 2, value: 0.5 },
      appearanceRank: { total: 0, value: null },
      companies: { truePositive: 1, falsePositive: 1, falseNegative: 2, precision: 0.5, recall: 1 / 3, rank: { correct: 1, total: 3 } },
      evidence: { truePositive: 1, falsePositive: 0, falseNegative: 1, precision: 1, recall: 0.5, exactSpanSets: { correct: 1, total: 2 } },
    });
    expect(labelledMetrics([{ analysis: analysis() }])).toMatchObject({
      labelledSamples: 0, mentions: { precision: null, recall: null }, sentiment: { total: 0, value: null },
    });
  });
  it('rejects unknown brand labels and invented label evidence before any paid call', () => {
    expect(() => parseEvaluationSamples(JSON.stringify({ ...sample, expected: { brands: [{ brandId: 'unknown', mentioned: true }] } }))).toThrow('Unknown or duplicate brand labels');
    expect(() => parseEvaluationSamples(JSON.stringify({ ...sample, expected: { brands: [{ brandId: 'acme', mentioned: true, evidence: [{ ...evidence, quote: 'Invented' }] }] } }))).toThrow('Label evidence does not match');
    expect(() => parseEvaluationSamples('private malformed answer')).toThrow('Invalid JSON on sample line 1.');
  });
});
