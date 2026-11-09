import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  generatedBrandbookSchema,
  generatedPromptSchema,
  journeyAllocation,
  JOURNEY_STAGES,
  journeyGoal,
  promptFingerprint,
  brandedAllocation,
  comparisonAllocation,
  containsPromptName,
  isBrandedPrompt,
  isShortBuyerPrompt,
  MAX_BRANDED_PROMPTS,
  STAGE_INTENTS,
  type Brandbook,
  type JourneyStage,
  type Brand,
  type CapturedAnswer,
  type DiscoveredCompetitor,
  type OnboardingJob,
  type Prompt,
} from '@citevia/core';
import { validateBuyerSearches } from './onboarding-prompt-quality.js';
import { normalizeAnswer } from './normalize.js';
import {
  ProviderError,
  object,
  responseFailure,
  type ProviderReceipt,
  type ResponseProvider,
} from './provider.js';
import {
  BRANDBOOK_INSTRUCTIONS,
  ONBOARDING_INSTRUCTIONS_VERSION,
  PORTFOLIO_INSTRUCTIONS,
  portfolioGenerationSchema,
  RESEARCH_INSTRUCTIONS,
} from './onboarding-prompts.js';
import {
  researchEvidenceCatalog,
  brandbookGenerationSchema,
  resolveBrandbookEvidence,
  verifiedBrandNames,
} from './onboarding-evidence.js';
import {
  competitorGenerationSchema,
  resolveDiscoveredCompetitors,
} from './competitor-discovery.js';
export type PortfolioPeer = Pick<Brand, 'name' | 'aliases' | 'domains'>;
type DraftSearch = { stage: JourneyStage; group: 'branded' | 'unbranded'; text: string; intent: string };

/** Pass only the rejected search text and its classification back for revision. */
export function previousPortfolioDraft(receipt: ProviderReceipt): DraftSearch[] {
  try {
    const draft = object(json(receipt));
    const searches = JOURNEY_STAGES.flatMap(stage => {
      const section = object(draft?.[stage]);
      return (['branded', 'unbranded'] as const).flatMap(group => {
        const rows = section?.[group];
        return Array.isArray(rows) ? rows.slice(0, 50).flatMap(value => {
          const row = object(value);
          return typeof row?.text === 'string' && typeof row.intent === 'string'
            ? [{ stage, group, text: row.text.slice(0, 200), intent: row.intent.slice(0, 20) }] : [];
        }) : [];
      });
    });
    return searches.slice(0, 50);
  } catch {
    return [];
  }
}
export interface OnboardingProvider {
  research(job: OnboardingJob): Promise<CapturedAnswer>;
  brandbook(
    job: OnboardingJob,
    research: CapturedAnswer,
  ): Promise<{
    brandbook: Brandbook;
    competitors?: DiscoveredCompetitor[];
    receipt: unknown;
  }>;
  prompts(
    job: OnboardingJob,
    brandbook: Brandbook,
    competitors?: readonly PortfolioPeer[],
    previousDraft?: DraftSearch[],
  ): Promise<{ prompts: Prompt[]; receipt: unknown }>;
}
export class OnboardingOutputError extends ProviderError {
  readonly canRevise: boolean;
  constructor(
    error: unknown,
    readonly receipt: ProviderReceipt,
  ) {
    super(
      error instanceof ProviderError ? error.code : 'onboarding_invalid_output',
      error instanceof ProviderError
        ? error.message
        : 'The generated account output did not pass validation.',
      false,
      receipt.requestId,
    );
    this.canRevise = receipt.response.status === 'completed' && (error instanceof z.ZodError ||
      (error instanceof ProviderError && error.code.startsWith('onboarding_') && error.code !== 'onboarding_refused'));
  }
}
function json(receipt: ProviderReceipt): unknown {
  const failure = responseFailure(receipt.response, false);
  if (failure) throw failure;
  const parts = (receipt.response.output || [])
    .flatMap((value) => {
      const item = object(value);
      return Array.isArray(item?.content) ? item.content : [];
    })
    .map(object);
  if (parts.some((part) => part?.type === 'refusal'))
    throw new ProviderError(
      'onboarding_refused',
      'The model declined to generate this account.',
      false,
    );
  const text = parts
    .filter((part) => part?.type === 'output_text')
    .map((part) => part?.text || '')
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(
      'onboarding_invalid_json',
      'The generated output was not valid JSON.',
      true,
    );
  }
}
const canonical = promptFingerprint;
function portfolioBrand(job: OnboardingJob, book: Brandbook) {
  return { name: job.input.name, aliases: book.names, domains: book.domains };
}

function asksForComparison(text: string, locale: string): boolean {
  const wording = promptFingerprint(text);
  switch (locale.split('-')[0].toLowerCase()) {
    case 'en':
      return /\b(?:vs|versus|or|compar\w*|alternative\w*|differ\w*|better|cheaper|faster|lower|higher|more|less|than|between|best|top|leading|most|stands? out|tradeoffs?|trade offs?|shortlist\w*|choose between|stack up|pros and cons|strengths and weaknesses)\b/u.test(wording);
    case 'he':
      return /(?:^| )(?:מול|לעומת|או|ולא|בין|להשוות|משתוו\S*|שונ\S*|[בלמה]?השוו\S*|[בלמה]?השווא\S*|בולט\S*|מוביל\S*|החוזקות|חוזקות|חלופ\S*|אלטרנטיב\S*|מתחר\S*|עדיפ\S*|עדיף|יותר|ביותר|הכי|מדורג\S*|[הב]?הבדל\S*|יתרונות וחסרונות)(?: |$)/u.test(wording);
    default:
      // The generation instructions require the comparison intent in every locale.
      return true;
  }
}
/** Assign one rival per question, even if a shortlist names several eligible rivals. */
function namedComparisonCount(texts: string[], rivals: readonly PortfolioPeer[]): number {
  const matches = texts.map(text => rivals.filter(rival => isBrandedPrompt(text, rival)));
  const assigned = new Map<PortfolioPeer, number>();
  function assign(question: number, tried: Set<PortfolioPeer>): boolean {
    for (const rival of matches[question]) {
      if (tried.has(rival)) continue;
      tried.add(rival);
      const previous = assigned.get(rival);
      if (previous === undefined || assign(previous, tried)) {
        assigned.set(rival, question);
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i < texts.length; i++) assign(i, new Set());
  return assigned.size;
}

function promptSlotPlan(
  allocation: Record<JourneyStage, number>,
  branded: Record<JourneyStage, number>,
  peers: readonly PortfolioPeer[],
) {
  const compare = comparisonAllocation(allocation.prefer, branded.prefer, peers.length);
  return Object.fromEntries(JOURNEY_STAGES.map(stage => {
    const section = (group: 'branded' | 'unbranded', count: number) => Array.from({ length: count }, (_, i) => {
      if (stage === 'prefer') {
        // Leave room for a natural discovery question while still obtaining
        // the minimum three explicit buyer comparisons in a full portfolio.
        const planned = group === 'unbranded' && count > compare.unbranded + 1
          ? compare.unbranded + 1 : compare[group];
        if (i >= planned) return { intent: 'commercial' };
        if (group === 'branded' && i < compare.distinct_named_rivals)
          return { intent: 'comparison', compare_with: peers[i].name };
        return { intent: 'comparison', buyer_decision: 'Ask to compare actual alternatives on a concrete buying criterion.' };
      }
      const offset = group === 'branded' ? 0 : branded[stage];
      const intents = STAGE_INTENTS[stage];
      return { intent: intents[(i + offset) % intents.length] };
    });
    return [stage, {
      branded: section('branded', branded[stage]),
      unbranded: section('unbranded', allocation[stage] - branded[stage]),
    }];
  }));
}

function manualBrandedCount(job: OnboardingJob, book: Brandbook) {
  const count = job.input.manualPrompts.filter((p) =>
    isBrandedPrompt(p.text, portfolioBrand(job, book)),
  ).length;
  if (count > MAX_BRANDED_PROMPTS)
    throw new ProviderError(
      'onboarding_branded_limit',
      'Saved manual prompts exceed the maximum of 15 branded questions. Edit them before retrying.',
      false,
    );
  return count;
}
export function validatePortfolio(
  job: OnboardingJob,
  book: Brandbook,
  raw: unknown,
  competitors: readonly PortfolioPeer[] = [],
): Prompt[] {
  const target = portfolioBrand(job, book);
  const generated = z
    .object({ prompts: z.array(generatedPromptSchema).max(50) })
    .strict()
    .parse(raw).prompts.map(prompt => ({
      ...prompt,
      branded: isBrandedPrompt(prompt.text, target),
    }));
  const allocation = journeyAllocation(job.input.manualPrompts);
  if (
    generated.length !== 50 - job.input.manualPrompts.length ||
    JOURNEY_STAGES.some(
      (stage) =>
        generated.filter((p) => p.stage === stage).length !== allocation[stage],
    )
  )
    throw new ProviderError(
      'onboarding_coverage_invalid',
      'Generated prompts did not match the requested section allocation.',
      true,
    );
  const all = [
    ...job.input.manualPrompts.map((p) => ({
      ...p,
      topic: 'Custom prompts',
      branded: isBrandedPrompt(p.text, target),
      intent: undefined,
    })),
    ...generated,
  ];
  const goals = new Set(
    JOURNEY_STAGES.map((stage) =>
      canonical(journeyGoal(stage, job.input.name)),
    ),
  );
  if (generated.some((prompt) => goals.has(canonical(prompt.text))))
    throw new ProviderError(
      'onboarding_measurement_goal_as_prompt',
      'Generated prompts repeated an internal measurement goal instead of a buyer question.',
      true,
    );
  if (new Set(all.map((p) => canonical(p.text))).size !== 50)
    throw new ProviderError(
      'onboarding_duplicate_prompts',
      'Generated prompts contained duplicates.',
      true,
    );
  if (generated.some((p) => !isShortBuyerPrompt(p.text)))
    throw new ProviderError(
      'onboarding_prompt_too_long',
      'Generated questions must be one short search phrase, at most 20 words and 160 characters.',
      false,
    );
  const slots = brandedAllocation(allocation, manualBrandedCount(job, book));
  if (JOURNEY_STAGES.some(stage => generated.filter(p => p.stage === stage && p.branded).length !== slots[stage]))
    throw new ProviderError(
      'onboarding_branded_limit',
      'The generated questions must fill the requested branded and unbranded slots in each section.',
      false,
    );
  if (generated.some(p => p.branded && !containsPromptName(p.text, target.name)))
    throw new ProviderError(
      'onboarding_brand_identity_invalid',
      'Use the full supplied company name in every generated branded question.',
      false,
    );
  for (const stage of JOURNEY_STAGES) {
    const rows = generated.filter((p) => p.stage === stage);
    const allowed: readonly string[] = STAGE_INTENTS[stage];
    if (
      rows.some((p) => !allowed.includes(p.intent)) ||
      (rows.length >= 2 &&
        allowed.some((intent) => !rows.some((p) => p.intent === intent)))
    )
      throw new ProviderError(
        'onboarding_intent_coverage_invalid',
        `The ${stage} section must cover ${allowed.join(' and ')}. It contained ${[...new Set(rows.map(p => p.intent))].join(', ')}. Use the intent assigned to each question in slot_plan.`,
        false,
      );
  }
  const comparison = comparisonAllocation(allocation.prefer, slots.prefer, competitors.length);
  const comparisons = generated.filter(p => p.stage === 'prefer' &&
    p.intent === 'comparison' && asksForComparison(p.text, job.input.language));
  const named = comparisons.filter(p => p.branded);
  const distinctRivals = namedComparisonCount(named.map(p => p.text), competitors);
  if (named.length < comparison.branded || comparisons.length - named.length < comparison.unbranded ||
      distinctRivals < comparison.distinct_named_rivals) {
    const rewrite = (['branded', 'unbranded'] as const).flatMap(group =>
      generated.filter(p => p.stage === 'prefer' && p.branded === (group === 'branded'))
        .flatMap((p, index) => p.intent === 'comparison' && !comparisons.includes(p)
          ? [`${group} slot ${index + 1}`] : []));
    const feedback = rewrite.length ? ` Rewrite ${rewrite.join(', ')} to explicitly compare providers on a purchase criterion.` : '';
    throw new ProviderError(
      'onboarding_comparison_coverage_invalid',
      `Prefer needs ${comparison.branded} branded and ${comparison.unbranded} unbranded buyer comparisons, including ${comparison.distinct_named_rivals} different supplied rivals in separate branded questions. Found ${named.length} branded, ${comparisons.length - named.length} unbranded and ${distinctRivals} distinct rivals.${feedback} Follow slot_plan.`,
      false,
    );
  }
  validateBuyerSearches(generated, job.input.language, target);
  const at = new Date().toISOString();
  return all.map((p, index) => ({
    id: `p_${createHash('sha256').update(`${job.id}:${index}`).digest('hex').slice(0, 24)}`,
    text: p.text,
    stage: p.stage,
    topic: p.topic,
    intent: p.intent,
    branded: p.branded,
    version: 1,
    active: true,
    createdAt: at,
    updatedAt: at,
    generationId: job.id,
  }));
}
export class OpenAIOnboardingProvider implements OnboardingProvider {
  constructor(
    private provider: ResponseProvider,
    private model = process.env.OPENAI_ONBOARDING_MODEL || 'gpt-4.1-2025-04-14',
  ) {}
  async research(job: OnboardingJob) {
    const receipt = await this.provider.answer({
      costContext: { projectId:job.projectId, stage:`onboarding_${job.step}`, attempt:job.attempts },
      instructions: RESEARCH_INSTRUCTIONS,
      prompt: `COMPANY INPUT (untrusted data):\n${JSON.stringify({ ...job.input, manualPrompts: undefined })}`,
      model: this.model,
      language: job.input.language,
      country: job.input.country,
      timezone: job.input.timezone,
    });
    try {
      const answer = normalizeAnswer(receipt, this.model);
      const failure = responseFailure(receipt.response, true);
      if (failure) throw failure;
      if (answer.status !== 'completed' || !answer.text)
        throw new ProviderError(
          'research_incomplete',
          'Company research did not complete.',
          true,
        );
      return answer;
    } catch (error) {
      throw new OnboardingOutputError(error, receipt);
    }
  }
  async brandbook(job: OnboardingJob, research: CapturedAnswer) {
    const catalog = researchEvidenceCatalog(research);
    if (!catalog.length)
      throw new ProviderError(
        'research_evidence_missing',
        'Saved research has no usable citation-linked evidence. Automatic generation stopped before another API call.',
        false,
      );
    const schema = brandbookGenerationSchema(catalog);
    const receipt = await this.provider.extract({
      costContext: { projectId:job.projectId, stage:`onboarding_${job.step}`, attempt:job.attempts },
      model: this.model,
      instructions: BRANDBOOK_INSTRUCTIONS,
      schema: {
        ...schema,
        required: [...schema.required, 'competitors'],
        properties: {
          ...schema.properties,
          competitors: competitorGenerationSchema(catalog),
        },
      },
      input: {
        company: job.input,
        research: research.text,
        sources: [...research.citations, ...research.sources],
        evidence_catalog: catalog,
      },
    });
    try {
      const raw = object(json(receipt));
      const { competitors: rawCompetitors = [], ...rawBrandbook } = raw || {};
      const parsed = generatedBrandbookSchema.parse(
        resolveBrandbookEvidence(rawBrandbook, catalog),
      );
      const names = verifiedBrandNames(job.input.name, job.input.website, parsed);
      const competitors = resolveDiscoveredCompetitors(
        rawCompetitors,
        research,
        {
          id: 'target',
          name: job.input.name,
          aliases: names,
          domains: [new URL(job.input.website).hostname],
        },
      );
      const allowed = new Set(
        [...research.citations, ...research.sources].map(
          (source) => source.url,
        ),
      );
      const urls = [
        ...parsed.knowledgeSources,
        ...parsed.evidence.map((e) => e.url),
        parsed.sitemapUrl,
        parsed.caseStudiesSourceUrl,
      ].filter((url): url is string => !!url);
      if (
        !parsed.evidence.length ||
        parsed.evidence.some((e) => !research.text.includes(e.quote)) ||
        urls.some((url) => !allowed.has(url))
      )
        throw new ProviderError(
          'brandbook_evidence_invalid',
          'Generated brandbook evidence could not be verified against the research.',
          false,
        );
      const brandbook: Brandbook = {
        ...parsed,
        companyCountry: job.input.country,
        language: job.input.language,
        domains: [new URL(job.input.website).hostname],
        names,
        caseStudies: [],
        generatedAt: receipt.receivedAt,
        model: receipt.response.model || this.model,
        version: 1,
        generationId: job.id,
      };
      return {
        brandbook,
        competitors,
        receipt: {
          instructionsVersion: ONBOARDING_INSTRUCTIONS_VERSION,
          evidenceCatalog: catalog,
          ...receipt,
        },
      };
    } catch (error) {
      throw new OnboardingOutputError(error, receipt);
    }
  }
  async prompts(
    job: OnboardingJob,
    brandbook: Brandbook,
    competitors: readonly PortfolioPeer[] = [],
    previousDraft?: DraftSearch[],
  ) {
    if (job.input.manualPrompts.length === 50)
      return {
        prompts: validatePortfolio(job, brandbook, { prompts: [] }),
        receipt: {
          manual: true,
          instructionsVersion: ONBOARDING_INSTRUCTIONS_VERSION,
        },
      };
    const allocation = journeyAllocation(job.input.manualPrompts);
    const branded = brandedAllocation(
      allocation,
      manualBrandedCount(job, brandbook),
    );
    const receipt = await this.provider.extract({
      costContext: { projectId:job.projectId, stage:`onboarding_${job.step}`, attempt:job.attempts },
      model: this.model,
      instructions: PORTFOLIO_INSTRUCTIONS,
      schema: portfolioGenerationSchema(allocation, branded),
      input: {
        brandbook,
        competitors,
        market: job.input.country,
        language: job.input.language,
        ...(job.input.promptFocus ? { prompt_focus: job.input.promptFocus } : {}),
        ...(job.portfolioFeedback ? { revision_feedback: job.portfolioFeedback } : {}),
        ...(previousDraft?.length ? { previous_draft: previousDraft } : {}),
        manual_prompts: job.input.manualPrompts,
        remaining_count: 50 - job.input.manualPrompts.length,
        section_allocation: allocation,
        required_generated_branded_count: Object.values(branded).reduce((sum, count) => sum + count, 0),
        slot_plan: promptSlotPlan(allocation, branded, competitors),
        minimum_prefer_comparisons: comparisonAllocation(allocation.prefer, branded.prefer, competitors.length),
        prompt_slots: Object.fromEntries(
          JOURNEY_STAGES.map((stage) => [
            stage,
            {
              branded: branded[stage],
              unbranded: allocation[stage] - branded[stage],
            },
          ]),
        ),
        brand_name: job.input.name,
        section_goals: Object.fromEntries(
          JOURNEY_STAGES.map((stage) => [
            stage,
            journeyGoal(stage, job.input.name),
          ]),
        ),
      },
    });
    try {
      const items = z
        .array(generatedPromptSchema.omit({ stage: true, branded: true }))
        .max(50);
      const section = z.object({ branded: items, unbranded: items }).strict();
      const sections = z
        .object({
          understand: section,
          prefer: section,
          trust: section,
          convert: section,
        })
        .strict()
        .parse(json(receipt));
      const generated = JOURNEY_STAGES.flatMap((stage) =>
        (['branded', 'unbranded'] as const).flatMap((group) => {
          const expected =
            group === 'branded'
              ? branded[stage]
              : allocation[stage] - branded[stage];
          if (sections[stage][group].length !== expected)
            throw new ProviderError(
              'onboarding_coverage_invalid',
              'Generated prompts did not match the requested section allocation.',
              false,
            );
          return sections[stage][group].map((prompt) => {
            const actual = isBrandedPrompt(
              prompt.text,
              portfolioBrand(job, brandbook),
            );
            if ((group === 'branded') !== actual)
              throw new ProviderError(
                'onboarding_branded_limit',
                'Every branded slot must identify the target, and every unbranded slot must omit it.',
                false,
              );
            return { ...prompt, stage, branded: actual };
          });
        }),
      );
      return {
        prompts: validatePortfolio(job, brandbook, { prompts: generated }, competitors),
        receipt: {
          instructionsVersion: ONBOARDING_INSTRUCTIONS_VERSION,
          ...receipt,
        },
      };
    } catch (error) {
      throw new OnboardingOutputError(error, receipt);
    }
  }
}
