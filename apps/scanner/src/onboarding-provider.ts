import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  generatedBrandbookSchema,
  generatedPromptSchema,
  journeyAllocation,
  JOURNEY_STAGES,
  journeyGoal,
  promptFingerprint,
  type Brandbook,
  type CapturedAnswer,
  type OnboardingJob,
  type Prompt,
} from '@citevia/core';
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
  PORTFOLIO_SCHEMA,
  RESEARCH_INSTRUCTIONS,
} from './onboarding-prompts.js';
import {
  researchEvidenceCatalog,
  brandbookGenerationSchema,
  resolveBrandbookEvidence,
} from './onboarding-evidence.js';
export interface OnboardingProvider {
  research(job: OnboardingJob): Promise<CapturedAnswer>;
  brandbook(
    job: OnboardingJob,
    research: CapturedAnswer,
  ): Promise<{ brandbook: Brandbook; receipt: unknown }>;
  prompts(
    job: OnboardingJob,
    brandbook: Brandbook,
  ): Promise<{ prompts: Prompt[]; receipt: unknown }>;
}
export class OnboardingOutputError extends ProviderError {
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
export function validatePortfolio(
  job: OnboardingJob,
  book: Brandbook,
  raw: unknown,
): Prompt[] {
  const generated = z
    .object({ prompts: z.array(generatedPromptSchema).max(50) })
    .strict()
    .parse(raw).prompts;
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
      branded: false,
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
  const at = new Date().toISOString();
  return all.map((p, index) => ({
    id: `p_${createHash('sha256').update(`${job.id}:${index}`).digest('hex').slice(0, 24)}`,
    text: p.text,
    stage: p.stage,
    topic: p.topic,
    branded: [job.input.name, ...book.names].some(
      (name) => name.length > 1 && canonical(p.text).includes(canonical(name)),
    ),
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
    const receipt = await this.provider.extract({
      model: this.model,
      instructions: BRANDBOOK_INSTRUCTIONS,
      schema: brandbookGenerationSchema(catalog),
      input: {
        company: job.input,
        research: research.text,
        sources: [...research.citations, ...research.sources],
        evidence_catalog: catalog,
      },
    });
    try {
      const parsed = generatedBrandbookSchema.parse(
        resolveBrandbookEvidence(json(receipt), catalog),
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
        names: [...new Set([job.input.name, ...parsed.names])].slice(0, 20),
        caseStudies: [],
        generatedAt: receipt.receivedAt,
        model: receipt.response.model || this.model,
        version: 1,
        generationId: job.id,
      };
      return {
        brandbook,
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
  async prompts(job: OnboardingJob, brandbook: Brandbook) {
    if (job.input.manualPrompts.length === 50)
      return {
        prompts: validatePortfolio(job, brandbook, { prompts: [] }),
        receipt: {
          manual: true,
          instructionsVersion: ONBOARDING_INSTRUCTIONS_VERSION,
        },
      };
    const receipt = await this.provider.extract({
      model: this.model,
      instructions: PORTFOLIO_INSTRUCTIONS,
      schema: PORTFOLIO_SCHEMA,
      input: {
        brandbook,
        market: job.input.country,
        language: job.input.language,
        manual_prompts: job.input.manualPrompts,
        remaining_count: 50 - job.input.manualPrompts.length,
        section_allocation: journeyAllocation(job.input.manualPrompts),
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
      return {
        prompts: validatePortfolio(job, brandbook, json(receipt)),
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
