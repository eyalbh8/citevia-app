import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Analysis, CapturedAnswer, EvidenceSpan, RunSnapshot, Usage } from '@citevia/core';
import { analysisRequest, parseAnalysisReceipt } from '../apps/scanner/src/analysis-request.js';
import { estimateProviderCost, hasCompleteTokenUsage, PRICE_VERSION } from '../apps/scanner/src/cost-observer.js';
import { usage } from '../apps/scanner/src/normalize.js';
import { createResponseProviderFromEnv } from '../apps/scanner/src/openai.js';
import { ProviderError, type ResponseProvider } from '../apps/scanner/src/provider.js';

const evaluationProvider = () => createResponseProviderFromEnv(null);

const sentiment = z.enum(['positive', 'neutral', 'negative', 'mixed', 'unknown', 'not_applicable']);
const span = z.object({ blockId: z.string(), quote: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
const brand = z.object({ id: z.string().min(1), name: z.string().min(1), aliases: z.array(z.string()), domains: z.array(z.string()) });
const expectedSchema = z.object({
  brands: z.array(z.object({
    brandId: z.string(), mentioned: z.boolean(), sentiment: sentiment.optional(),
    explicitRank: z.number().int().positive().nullable().optional(),
    appearanceRank: z.number().int().positive().nullable().optional(),
    evidence: z.array(span).optional(),
  }).strict()).default([]),
  // When present, this is the complete human-labelled company inventory for this answer.
  companies: z.array(z.object({
    name: z.string().trim().min(1), rank: z.number().int().positive().optional(),
    sentiment: sentiment.exclude(['not_applicable']).optional(), evidence: span.optional(),
  }).strict()).optional(),
}).strict();
export type ExpectedAnalysis = z.infer<typeof expectedSchema>;
export interface EvaluationSample {
  id: string;
  answer: CapturedAnswer;
  snapshot: RunSnapshot;
  expected?: ExpectedAnalysis;
}
export interface EvaluationOptions {
  candidate?: string;
  baseline?: string;
  execute?: boolean;
  estimatedOutputTokens?: number;
}
interface Outcome {
  status: 'valid' | 'invalid' | 'request_failed';
  analysis?: Analysis;
  errorCode?: string;
  usage?: Usage;
  estimatedUsd?: number | null;
}
const sampleSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  answer: z.object({
    providerResponseId: z.string(), model: z.string(), status: z.literal('completed'),
    blocks: z.array(z.object({ id: z.string(), text: z.string() })).min(1), text: z.string(),
    citations: z.array(z.object({ id: z.string(), blockId: z.string(), url: z.string(), title: z.string(), start: z.number().nullable(), end: z.number().nullable() })),
    sources: z.array(z.object({ url: z.string() }).passthrough()),
    usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative() }).passthrough(),
    createdAt: z.string(),
  }).passthrough(),
  snapshot: z.object({
    projectName: z.string(), brand, competitors: z.array(brand), prompts: z.array(z.unknown()),
    country: z.string(), language: z.string(), timezone: z.string(), generationModel: z.string(),
    extractionModel: z.string().min(1), parserVersion: z.string().min(1), configVersion: z.number(),
  }).passthrough(),
  expected: expectedSchema.optional(),
});

/** Read only local saved captures. Errors contain line numbers, never business text. */
export function parseEvaluationSamples(text: string, limit = 300): EvaluationSample[] {
  const samples: EvaluationSample[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (samples.length >= limit) break;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on sample line ${index + 1}.`); }
    const parsed = sampleSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid saved answer, snapshot or labels on sample line ${index + 1}.`);
    const row = parsed.data;
    const id = row.id ?? `line-${index + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate sample ID on line ${index + 1}.`);
    ids.add(id);
    const brandIds = [row.snapshot.brand, ...row.snapshot.competitors].map((item) => item.id);
    const expectedIds = row.expected?.brands.map((item) => item.brandId) ?? [];
    if (new Set(brandIds).size !== brandIds.length || new Set(expectedIds).size !== expectedIds.length || expectedIds.some((key) => !brandIds.includes(key)))
      throw new Error(`Unknown or duplicate brand labels on sample line ${index + 1}.`);
    const companyNames = row.expected?.companies?.map((item) => nameKey(item.name)) ?? [];
    if (new Set(companyNames).size !== companyNames.length)
      throw new Error(`Duplicate company labels on sample line ${index + 1}.`);
    const answer: CapturedAnswer = { ...row.answer, raw: row.answer.raw ?? null };
    if (new Set(answer.blocks.map((item) => item.id)).size !== answer.blocks.length)
      throw new Error(`Duplicate answer blocks on sample line ${index + 1}.`);
    for (const evidence of [...(row.expected?.brands.flatMap((item) => item.evidence ?? []) ?? []), ...(row.expected?.companies?.flatMap((item) => item.evidence ? [item.evidence] : []) ?? [])]) {
      const block = answer.blocks.find((item) => item.id === evidence.blockId);
      if (!block || evidence.end <= evidence.start || block.text.slice(evidence.start, evidence.end) !== evidence.quote)
        throw new Error(`Label evidence does not match the saved answer on sample line ${index + 1}.`);
    }
    samples.push({ id, answer, snapshot: row.snapshot as RunSnapshot, ...(row.expected ? { expected: row.expected } : {}) });
  }
  if (!samples.length) throw new Error('The sample file contains no saved answers.');
  return samples;
}

const nameKey = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase();
const evidenceKey = (value: EvidenceSpan) => JSON.stringify([value.blockId, value.start, value.end, value.quote]);
const score = () => ({ correct: 0, total: 0 });
const result = (value: ReturnType<typeof score>) => ({ ...value, value: value.total ? value.correct / value.total : null });
const confusion = () => ({ truePositive: 0, falsePositive: 0, falseNegative: 0 });
function retrieval(value: ReturnType<typeof confusion>) {
  const precisionDenominator = value.truePositive + value.falsePositive;
  const recallDenominator = value.truePositive + value.falseNegative;
  return {
    ...value,
    precision: precisionDenominator ? value.truePositive / precisionDenominator : null,
    recall: recallDenominator ? value.truePositive / recallDenominator : null,
    precisionDenominator, recallDenominator,
  };
}
function compareSets(actual: string[], expected: string[], counts: ReturnType<typeof confusion>) {
  const a = new Set(actual), e = new Set(expected);
  for (const key of a) counts[e.has(key) ? 'truePositive' : 'falsePositive'] += 1;
  for (const key of e) if (!a.has(key)) counts.falseNegative += 1;
  return a.size === e.size && [...a].every((key) => e.has(key));
}

/** Partial labels are excluded from unrelated denominators. Invalid output is an abstention, never an absence. */
export function labelledMetrics(rows: { expected?: ExpectedAnalysis; analysis?: Analysis }[]) {
  const mentions = { ...confusion(), trueNegative: 0, abstainedPositive: 0, abstainedNegative: 0 };
  const mentionAccuracy = score(), sentimentAccuracy = score(), explicitRankAccuracy = score(), appearanceRankAccuracy = score();
  const companyCounts = confusion(), companyInventoryAccuracy = score(), companyRankAccuracy = score(), companySentimentAccuracy = score(), companyEvidenceAccuracy = score();
  const evidenceCounts = confusion(), evidenceSetAccuracy = score();
  let labelledSamples = 0, validLabelledSamples = 0;
  for (const { expected, analysis } of rows) {
    if (!expected) continue;
    labelledSamples += 1;
    if (analysis) validLabelledSamples += 1;
    for (const label of expected.brands) {
      const actual = analysis?.brands.find((item) => item.brandId === label.brandId);
      mentionAccuracy.total += 1;
      if (!actual) mentions[label.mentioned ? 'abstainedPositive' : 'abstainedNegative'] += 1;
      else {
        if (actual.mentioned === label.mentioned) mentionAccuracy.correct += 1;
        if (label.mentioned) mentions[actual.mentioned ? 'truePositive' : 'falseNegative'] += 1;
        else mentions[actual.mentioned ? 'falsePositive' : 'trueNegative'] += 1;
      }
      // Absent brands do not inflate sentiment/rank accuracy through not_applicable/null.
      for (const [field, metric] of [
        ['sentiment', sentimentAccuracy], ['explicitRank', explicitRankAccuracy], ['appearanceRank', appearanceRankAccuracy],
      ] as const) {
        if (label.mentioned && Object.hasOwn(label, field)) {
          metric.total += 1;
          if (actual && actual[field] === label[field]) metric.correct += 1;
        }
      }
      if (label.evidence !== undefined) {
        evidenceSetAccuracy.total += 1;
        const same = compareSets(actual?.evidence.map(evidenceKey) ?? [], label.evidence.map(evidenceKey), evidenceCounts);
        if (actual && same) evidenceSetAccuracy.correct += 1;
      }
    }
    if (expected.companies !== undefined) {
      companyInventoryAccuracy.total += 1;
      const actual = new Map((analysis?.companies ?? []).map((item) => [nameKey(item.name), item]));
      const same = compareSets([...actual.keys()], expected.companies.map((item) => nameKey(item.name)), companyCounts);
      if (analysis?.companies && same) companyInventoryAccuracy.correct += 1;
      for (const label of expected.companies) {
        const company = actual.get(nameKey(label.name));
        for (const [field, metric] of [['rank', companyRankAccuracy], ['sentiment', companySentimentAccuracy]] as const) {
          if (Object.hasOwn(label, field)) {
            metric.total += 1;
            if (company && company[field] === label[field]) metric.correct += 1;
          }
        }
        if (label.evidence !== undefined) {
          companyEvidenceAccuracy.total += 1;
          if (company && evidenceKey(company.evidence) === evidenceKey(label.evidence)) companyEvidenceAccuracy.correct += 1;
        }
      }
    }
  }
  return {
    labelledSamples, validLabelledSamples,
    mentions: {
      ...mentions,
      ...retrieval({ ...mentions, falseNegative: mentions.falseNegative + mentions.abstainedPositive }),
      falseNegative: mentions.falseNegative,
      recallIncludesAbstainedPositives: true,
      accuracy: result(mentionAccuracy),
    },
    sentiment: result(sentimentAccuracy), explicitRank: result(explicitRankAccuracy), appearanceRank: result(appearanceRankAccuracy),
    companies: { ...retrieval(companyCounts), exactInventory: result(companyInventoryAccuracy), rank: result(companyRankAccuracy), sentiment: result(companySentimentAccuracy), evidence: result(companyEvidenceAccuracy) },
    evidence: { ...retrieval(evidenceCounts), exactSpanSets: result(evidenceSetAccuracy) },
  };
}

function agreement(rows: { baseline: Outcome; candidate: Outcome }[]) {
  const mentions = score(), sentiments = score(), explicitRanks = score(), appearanceRanks = score(), companies = score();
  let pairedValidSamples = 0;
  for (const { baseline, candidate } of rows) {
    if (!baseline.analysis || !candidate.analysis) continue;
    pairedValidSamples += 1;
    for (const old of baseline.analysis.brands) {
      const current = candidate.analysis.brands.find((item) => item.brandId === old.brandId);
      mentions.total += 1;
      if (old.mentioned === current?.mentioned) mentions.correct += 1;
      if (!old.mentioned) continue;
      for (const [field, metric] of [['sentiment', sentiments], ['explicitRank', explicitRanks], ['appearanceRank', appearanceRanks]] as const) {
        if (old[field] === undefined) continue;
        metric.total += 1;
        if (current && current[field] === old[field]) metric.correct += 1;
      }
    }
    if (baseline.analysis.companies !== undefined) {
      companies.total += 1;
      if (candidate.analysis.companies && compareSets(candidate.analysis.companies.map((item) => nameKey(item.name)), baseline.analysis.companies.map((item) => nameKey(item.name)), confusion()))
        companies.correct += 1;
    }
  }
  return {
    interpretation: 'Agreement with the baseline model is not correctness or proof of quality.',
    totalSamples: rows.length, pairedValidSamples,
    mentions: result(mentions), sentiment: result(sentiments), explicitRank: result(explicitRanks), appearanceRank: result(appearanceRanks), companyInventory: result(companies),
  };
}

export async function evaluateAnalysis(
  samples: EvaluationSample[],
  options: EvaluationOptions = {},
  providerFactory: () => Promise<ResponseProvider> = evaluationProvider,
) {
  const candidate = options.candidate ?? 'gpt-6-luna';
  const outputTokens = options.estimatedOutputTokens ?? 400;
  const planned = new Map<string, { model: string; requests: number; estimatedInputTokens: number; assumedOutputTokens: number; estimatedUsd: number | null }>();
  for (const sample of samples) {
    for (const model of new Set([options.baseline ?? sample.snapshot.extractionModel, candidate])) {
      const request = analysisRequest(sample.answer, { ...sample.snapshot, extractionModel: model });
      const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 4);
      const cost = estimateProviderCost('openai', model, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      const previous = planned.get(model) ?? { model, requests: 0, estimatedInputTokens: 0, assumedOutputTokens: 0, estimatedUsd: 0 };
      previous.requests += 1;
      previous.estimatedInputTokens += inputTokens;
      previous.assumedOutputTokens += outputTokens;
      previous.estimatedUsd = previous.estimatedUsd === null || cost === null ? null : previous.estimatedUsd + cost;
      planned.set(model, previous);
    }
  }
  const plan = {
    mode: options.execute ? 'execute' : 'dry-run', samples: samples.length,
    labelledSamples: samples.filter((sample) => sample.expected).length,
    candidate, baseline: options.baseline ?? 'saved snapshot extractionModel (per sample)',
    priceVersion: PRICE_VERSION, models: [...planned.values()],
    costCaveat: 'Planning uses UTF-8 bytes / 4 as a token heuristic and assumed output tokens, not a spend cap or measured usage. Unknown model prices are null. Provider invoices are authoritative.',
    calls: 'Extraction only: no answer collection, web search, automatic retry, or production writes. Identical baseline/candidate models share one request per sample.',
  };
  if (!options.execute) return { plan, qualityProven: false };
  const provider = await providerFactory();
  const evaluated: { sample: EvaluationSample; baseline: Outcome; candidate: Outcome }[] = [];
  for (const sample of samples) {
    const results = new Map<string, Outcome>();
    for (const model of new Set([options.baseline ?? sample.snapshot.extractionModel, candidate])) {
      const snapshot = { ...sample.snapshot, extractionModel: model };
      let outcome: Outcome = { status: 'request_failed' };
      try {
        const receipt = await provider.extract(analysisRequest(sample.answer, snapshot));
        const tokens = usage(receipt.response);
        outcome = { status: 'invalid', usage: tokens,
          estimatedUsd: hasCompleteTokenUsage(receipt.response) ? estimateProviderCost('openai', String(receipt.response.model ?? model), tokens) : null };
        outcome.analysis = parseAnalysisReceipt(receipt, sample.answer, snapshot);
        outcome.status = 'valid';
      } catch (error) {
        outcome.errorCode = error instanceof ProviderError ? error.code : 'evaluation_error';
      }
      results.set(model, outcome);
    }
    evaluated.push({ sample, baseline: results.get(options.baseline ?? sample.snapshot.extractionModel)!, candidate: results.get(candidate)! });
  }
  const summarize = (kind: 'baseline' | 'candidate') => ({
    valid: evaluated.filter((row) => row[kind].status === 'valid').length,
    invalid: evaluated.filter((row) => row[kind].status === 'invalid').length,
    requestFailed: evaluated.filter((row) => row[kind].status === 'request_failed').length,
    validationWarnings: evaluated.reduce((sum, row) => sum + (row[kind].analysis?.validationWarnings?.length ?? 0), 0),
    metricsAgainstLabels: labelledMetrics(evaluated.map((row) => ({ expected: row.sample.expected, analysis: row[kind].analysis }))),
  });
  return {
    plan, qualityProven: false,
    interpretation: 'Human-label metrics and validation coverage support a rollout decision; this report does not automatically approve a model switch. Sentiment and rank denominators include only explicitly labelled present brands. Evidence compares exact labelled spans; company names use Unicode normalization and case folding.',
    baseline: summarize('baseline'), candidate: summarize('candidate'),
    baselineAgreement: agreement(evaluated),
    samples: evaluated.map((row) => ({
      id: row.sample.id,
      baseline: { model: options.baseline ?? row.sample.snapshot.extractionModel, status: row.baseline.status, errorCode: row.baseline.errorCode, usage: row.baseline.usage, estimatedUsd: row.baseline.estimatedUsd },
      candidate: { model: candidate, status: row.candidate.status, errorCode: row.candidate.errorCode, usage: row.candidate.usage, estimatedUsd: row.candidate.estimatedUsd },
    })),
  };
}

export async function runEvaluationCli(argv: string[], providerFactory = evaluationProvider) {
  const { values } = parseArgs({ args: argv, options: {
    input: { type: 'string' }, output: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
    limit: { type: 'string', default: '300' }, 'estimated-output-tokens': { type: 'string', default: '400' },
    execute: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) return 'Usage: npm run analysis:eval -- --input saved-answers.jsonl [--candidate gpt-6-luna] [--baseline MODEL] [--limit 300] [--estimated-output-tokens 400] [--output report.json] [--execute]\nDefault is a local dry run without credentials or paid calls. --execute explicitly authorizes up to two paid extraction calls per sample; no collection or search. Each JSONL row: {id?,answer:CapturedAnswer,snapshot:RunSnapshot,expected?:{brands:[{brandId,mentioned,sentiment?,explicitRank?,appearanceRank?,evidence?}],companies?:[{name,rank?,sentiment?,evidence?}]}}. Omit unknown labels; companies, when present, must be the complete labelled inventory.';
  const limit = Number(values.limit), estimatedOutputTokens = Number(values['estimated-output-tokens']);
  if (!values.input || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(estimatedOutputTokens) || estimatedOutputTokens < 1)
    throw new Error('Supply --input, --limit 1–1000 and a positive integer --estimated-output-tokens; use --help.');
  if (values.output && resolve(values.output) === resolve(values.input))
    throw new Error('The report output must differ from the saved-answer input.');
  const samples = parseEvaluationSamples(await readFile(resolve(values.input), 'utf8'), limit);
  const report = await evaluateAnalysis(samples, { candidate: values.candidate, baseline: values.baseline, execute: values.execute, estimatedOutputTokens }, providerFactory);
  const text = JSON.stringify(report, null, 2);
  if (values.output) await writeFile(resolve(values.output), `${text}\n`, { mode: 0o600 });
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runEvaluationCli(process.argv.slice(2)).then((text) => console.log(text)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Evaluation failed.');
    process.exitCode = 1;
  });
}
