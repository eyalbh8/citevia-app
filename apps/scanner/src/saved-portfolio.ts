import type { Brand, Brandbook, OnboardingJob, Prompt } from '@citevia/core';
import { validatePortfolio } from './onboarding-provider.js';
import { ProviderError } from './provider.js';

/** A checkpoint can outlive the policy that generated it. Revalidate its actual
 * wording, including the original manual prefix on older onboarding jobs. */
export function validateSavedPortfolio(
  job: OnboardingJob,
  book: Brandbook,
  prompts: Prompt[] | undefined,
  competitors: Brand[],
): Prompt[] {
  try {
    const manual = job.input.manualPrompts;
    if (!Array.isArray(prompts) || prompts.length !== 50 ||
        prompts.some(prompt => !prompt?.active) ||
        manual.some((prompt, index) =>
          prompt.text !== prompts[index]?.text || prompt.stage !== prompts[index]?.stage)) {
      throw new Error('The saved portfolio does not contain the expected 50 active prompts.');
    }
    return validatePortfolio(job, book, {
      prompts: prompts.slice(manual.length).map(({ text, stage, topic, branded, intent }) => ({
        text, stage, topic, branded, intent,
      })),
    }, competitors);
  } catch (error) {
    const detail = error instanceof ProviderError ? error.message : 'The saved prompt data is invalid.';
    throw new ProviderError('onboarding_portfolio_policy_changed', detail, false);
  }
}
