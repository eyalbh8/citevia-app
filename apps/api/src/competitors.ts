import {
  IDENTITY_PARSER_VERSION,
  promptFingerprint,
  normalizeDomain,
  brandSentimentScore,
  type Analysis,
  type Brand,
  type BrandAnalysis,
  type DashboardObservation,
  type EvidenceSpan,
  type Project,
  type ScanRun,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { containsAlias } from '../../scanner/src/extraction.js';
import { promptAnswers } from './prompt-answers.js';

const HISTORY_DAYS = 90;
const SUGGESTION_CAPTURE_LIMIT = 300;
const ARTIFACT_BATCH_SIZE = 5;

function validEvidence(
  span: EvidenceSpan | null | undefined,
): span is EvidenceSpan {
  return (
    !!span &&
    typeof span.blockId === 'string' &&
    typeof span.quote === 'string' &&
    !!span.quote.trim() &&
    span.quote.length <= 1000 &&
    Number.isInteger(span.start) &&
    span.start >= 0 &&
    Number.isInteger(span.end) &&
    span.end - span.start === span.quote.length
  );
}
const visible = (text: string) => text.replace(/https?:\/\/[^\s)\]>]+/giu, ' ');

export interface CompetitorSuggestion {
  name: string;
  mentions: number;
  evidence: { quote: string; runId: string; promptId: string };
}

/** These receipts already passed exact-span validation against the immutable capture. */
function verifiedCompanies(analysis: Analysis | null, run: ScanRun) {
  if (
    !analysis ||
    analysis.parserVersion !== run.snapshot.parserVersion ||
    !(analysis.parserVersion === IDENTITY_PARSER_VERSION
      ? /^exact-evidence-v3(?:\.|$)/
      : /^exact-evidence-v2(?:\.|$)/).test(analysis.validationVersion || '')
  )
    return [];
  return (analysis.companies || []).filter((company) => {
    const span = company.evidence;
    if (
      typeof company.name !== 'string' ||
      !company.name.trim() ||
      company.name.length > 120 ||
      !Number.isInteger(company.rank) ||
      company.rank < 1 ||
      !validEvidence(span)
    )
      return false;
    // The identity scorer validated the first substantive passage, which can
    // refer back to a name in another sentence.
    if (analysis.parserVersion === IDENTITY_PARSER_VERSION)
      return company.brandId === null || typeof company.brandId === 'string';
    // A bare URL is not evidence that the answer discusses a company.
    return containsAlias(visible(span.quote), {
      id: 'candidate',
      name: company.name,
      aliases: [],
      domains: [],
    });
  });
}

const namesFor = (brand: Brand) =>
  [brand.name, ...brand.aliases].map(promptFingerprint).filter(Boolean);

function sameCompetitorIdentity(previous: Brand | undefined, current: Brand) {
  if (!previous) return false;
  const names = new Set(namesFor(previous));
  if (!namesFor(current).some((name) => names.has(name))) return false;
  const previousDomains = previous.domains.map(normalizeDomain).filter(Boolean);
  const currentDomains = current.domains.map(normalizeDomain).filter(Boolean);
  return (
    !previousDomains.length ||
    !currentDomains.length ||
    currentDomains.some((domain) => previousDomains.includes(domain))
  );
}

/** Indexed receipts avoid an S3 request per answer; omitted legacy records alone need fallback. */
async function savedAnalyses(
  runtime: Runtime,
  projectId: string,
  observations: Pick<DashboardObservation, 'result' | 'run'>[],
) {
  if (!observations.length) return [];
  const indexed = new Map(
    (
      await runtime.repository.listSavedAnalyses(
        projectId,
        observations
          .filter(({ result }) => result.captureKey)
          .map(({ result }) => ({
            responseId: result.responseId,
            captureKey: result.captureKey!,
            analysisKey: result.analysisKey,
          })),
      )
    ).map((row) => [row.responseId, row.analysis]),
  );
  const analyses = observations.map(
    ({ result }) => indexed.get(result.responseId) ?? null,
  );
  const missing = observations
    .map(({ result }, index) => ({ result, index }))
    .filter(
      ({ result }) => !indexed.has(result.responseId) && result.analysisKey,
    );
  for (let offset = 0; offset < missing.length; offset += ARTIFACT_BATCH_SIZE) {
    const batch = missing.slice(offset, offset + ARTIFACT_BATCH_SIZE);
    const receipts = await Promise.all(
      batch.map(({ result }) =>
        runtime.artifacts.get<Analysis>(result.analysisKey!),
      ),
    );
    batch.forEach(({ index }, position) => {
      analyses[index] = receipts[position];
    });
  }
  return analyses;
}

/** Observed alternatives, never guessed websites or all domains cited in an answer. */
export async function competitorSuggestions(
  runtime: Runtime,
  project: Project,
  now: Date,
): Promise<{ items: CompetitorSuggestion[] }> {
  const end = now.toISOString();
  const start = new Date(now.getTime() - HISTORY_DAYS * 86400000).toISOString();
  const history = await runtime.repository.listPromptHistory(
    project.id,
    start,
    end,
  );
  history.runs = history.runs.filter((run) =>
    ['completed', 'partial'].includes(run.status),
  );
  const observations = promptAnswers(
    history,
    project.id,
    undefined,
    undefined,
    'date',
    'desc',
  )
    .filter(
      ({ result }) =>
        result.status === 'succeeded' &&
        result.analysisKey &&
        result.captureKey &&
        result.capturedAt &&
        Date.parse(result.capturedAt) >= Date.parse(start) &&
        Date.parse(result.capturedAt) <= now.getTime(),
    )
    .slice(0, SUGGESTION_CAPTURE_LIMIT);
  const excluded = new Set(
    [project.brand, ...project.competitors].flatMap(namesFor),
  );
  const candidates = new Map<string, CompetitorSuggestion>();
  const analyses = await savedAnalyses(runtime, project.id, observations);
  observations.forEach(({ result, run }, index) => {
    const seen = new Set<string>();
    for (const company of verifiedCompanies(analyses[index], run)) {
      if (typeof company.brandId === 'string') continue;
      const key = promptFingerprint(company.name);
      if (!key || excluded.has(key) || seen.has(key)) continue;
      seen.add(key);
      const candidate = candidates.get(key);
      if (candidate) candidate.mentions++;
      else
        candidates.set(key, {
          name: company.name.trim(),
          mentions: 1,
          evidence: {
            quote: company.evidence.quote,
            runId: run.id,
            promptId: result.promptId,
          },
        });
    }
  });
  return {
    items: [...candidates.values()]
      .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
      .slice(0, 10),
  };
}

/** Add only proven historical mentions for competitors that were not tracked at capture time. */
export async function historicalCompetitorMentions(
  runtime: Runtime,
  project: Project,
  observations: DashboardObservation[],
): Promise<DashboardObservation[]> {
  if (!project.competitors.length) return observations;
  const currentNames = new Map(
    project.competitors.map((brand) => [brand.id, new Set(namesFor(brand))]),
  );
  // All answers from one scan share the same competitor configuration.
  // Compare its saved identities once, including evidence exclusions for renamed brands.
  type Missing = { brand: Brand; excludedNames: Set<string> }[];
  const missingByRun = new Map<ScanRun, Missing>();
  const projected = [...observations];
  const pending: { item: DashboardObservation; index: number; missing: Missing }[] = [];
  for (const [index, original] of observations.entries()) {
    let missing = missingByRun.get(original.run);
    if (!missing) {
      const previous = new Map(original.run.snapshot.competitors.map(brand => [brand.id, brand]));
      missing = project.competitors.flatMap(brand => {
        const former = previous.get(brand.id);
        return sameCompetitorIdentity(former, brand) ? [] : [{
          brand, excludedNames: new Set(former ? namesFor(former) : []),
        }];
      });
      missingByRun.set(original.run, missing);
    }
    if (!missing.length) continue;
    const brands = original.result.brands || [];
    const retained = brands.filter(brand => !missing.some(row => row.brand.id === brand.brandId));
    if (retained.length !== brands.length)
      projected[index] = { ...original, result: { ...original.result, brands: retained } };
    // An explicit identity decision describes the brand roster at capture time.
    // A new or reassigned competitor needs a new analysis before it can get credit.
    if (original.result.analysisKey && original.run.snapshot.parserVersion !== IDENTITY_PARSER_VERSION)
      pending.push({ item: projected[index], index, missing });
  }
  const analyses = await savedAnalyses(
    runtime,
    project.id,
    pending.map(({ item }) => item),
  );
  pending.forEach(({ item, index, missing }, position) => {
    const companies = verifiedCompanies(analyses[position], item.run);
    const mentions: BrandAnalysis[] = [];
    for (const { brand, excludedNames } of missing) {
      const matches = companies.filter(
        (company) =>
          company.brandId === undefined &&
          currentNames.get(brand.id)!.has(promptFingerprint(company.name)) &&
          !excludedNames.has(promptFingerprint(company.name)),
      );
      if (!matches.length) continue;
      const first = matches.reduce((a, b) => (a.rank < b.rank ? a : b));
      const assessed = matches.find(
        (company) =>
          ['positive', 'neutral', 'negative', 'mixed'].includes(
            company.sentiment || '',
          ) &&
          validEvidence(company.sentimentEvidence) &&
          containsAlias(visible(company.sentimentEvidence.quote), brand) &&
          containsAlias(visible(company.sentimentEvidence.quote), {
            id: 'company',
            name: company.name,
            aliases: [],
            domains: [],
          }),
      );
      const mention: BrandAnalysis = {
        brandId: brand.id,
        mentioned: true,
        appearanceRank: first.rank,
        explicitRank: null,
        mentionOrder: null,
        sentiment: assessed?.sentiment || 'unknown',
        evidence: [first.evidence],
        rankEvidence: null,
        sentimentEvidence: assessed?.sentimentEvidence || null,
      };
      mention.sentimentScore = brandSentimentScore(mention);
      mentions.push(mention);
    }
    if (mentions.length)
      projected[index] = {
        ...item,
        result: {
          ...item.result,
          brands: [...(item.result.brands || []), ...mentions],
        },
      };
  });
  return projected;
}
