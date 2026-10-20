import { describe, expect, it, vi } from 'vitest';
import {
  brandedAllocation,
  isBrandedPrompt,
  isShortBuyerPrompt,
  JOURNEY_PROMPT_COUNTS,
} from '@citevia/core';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import {
  validatePortfolio,
  OpenAIOnboardingProvider,
} from '../apps/scanner/src/onboarding-provider.js';

import { policyJob } from './fixtures/onboarding-job.js';
async function portfolio() {
  const job = policyJob(),
    provider = new FixtureOnboardingProvider();
  const book = (await provider.brandbook(job)).brandbook;
  book.names = ['Acme', 'Acme Labs'];
  const prompts = (await provider.prompts(job, book)).prompts.map(
    ({ text, stage, topic, branded, intent }) => ({
      text,
      stage: stage!,
      topic: topic!,
      branded,
      intent: intent!,
    }),
  );
  return { job, book, prompts };
}
describe('natural prompt portfolio policy', () => {
  it('counts actual names and aliases regardless of a model-supplied branded flag', async () => {
    const { job, book, prompts } = await portfolio();
    for (let i = 0; i < 15; i++)
      prompts[i].text = `What does ACME Labs offer for need ${i}?`;
    const accepted = validatePortfolio(job, book, { prompts });
    expect(accepted.filter((p) => p.branded)).toHaveLength(15);
    prompts[15].text = 'What are the fees at acme.com?';
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({
        code: 'onboarding_branded_limit',
        retryable: false,
      }),
    );
  });
  it('matches whole multilingual names and punctuation without treating substrings as branded', () => {
    const brand = {
      name: 'Geo',
      aliases: ['New Balance', 'מותג'],
      domains: ['geo.com'],
    };
    expect(isBrandedPrompt('What is geology?', brand)).toBe(false);
    expect(isBrandedPrompt('Is GEO’s pricing fair?', brand)).toBe(true);
    expect(isBrandedPrompt('New-Balance running shoes', brand)).toBe(true);
    expect(isBrandedPrompt('מה מציע מותג?', brand)).toBe(true);
    expect(isBrandedPrompt('Compare www.geo.com fees', brand)).toBe(true);
  });
  it('limits length and multiple questions while allowing short search phrases', async () => {
    expect(isShortBuyerPrompt('Trading platforms with low fees')).toBe(true);
    expect(isShortBuyerPrompt('最適な取引プラットフォームは？')).toBe(true);
    expect(isShortBuyerPrompt('Which platform? What does it cost?')).toBe(
      false,
    );
    const { job, book, prompts } = await portfolio();
    prompts[0].text = Array.from({ length: 21 }, () => 'word').join(' ');
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({ code: 'onboarding_prompt_too_long' }),
    );
  });
  it('requires organic, comparison, commercial, trust and next-step intent coverage', async () => {
    const { job, book, prompts } = await portfolio();
    expect(new Set(prompts.map((p) => p.intent)).size).toBe(6);
    for (const p of prompts.filter((p) => p.stage === 'prefer'))
      p.intent = 'commercial';
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({ code: 'onboarding_intent_coverage_invalid' }),
    );
  });
  it('uses only the remaining branded budget and stops excessive manual inputs before a paid call', async () => {
    const slots = brandedAllocation(JOURNEY_PROMPT_COUNTS, 12);
    expect(Object.values(slots).reduce((sum, n) => sum + n, 0)).toBe(3);
    const { job, book } = await portfolio();
    job.input.manualPrompts = Array.from({ length: 16 }, (_, i) => ({
      text: `What is Acme option ${i}?`,
      stage: 'understand',
    }));
    const extract = vi.fn();
    await expect(
      new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).prompts(
        job,
        book,
      ),
    ).rejects.toMatchObject({ code: 'onboarding_branded_limit' });
    expect(extract).not.toHaveBeenCalled();
  });
  it('rejects a brand hidden in an unbranded slot after exactly one paid attempt', async () => {
    const { job, book, prompts } = await portfolio();
    const slots = brandedAllocation(JOURNEY_PROMPT_COUNTS);
    const sections = Object.fromEntries(
      Object.entries(slots).map(([stage, n]) => {
        const rows = prompts
          .filter((p) => p.stage === stage)
          .map(({ text, topic, intent }) => ({ text, topic, intent }));
        return [stage, { branded: rows.slice(0, n), unbranded: rows.slice(n) }];
      }),
    );
    sections.prefer.unbranded[0].text = 'Which Acme Labs plan is best?';
    const receipt = {
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(sections) }],
          },
        ],
      },
      requestId: 'one-paid-call',
      receivedAt: new Date().toISOString(),
    };
    const extract = vi.fn(async () => receipt);
    await expect(
      new OpenAIOnboardingProvider({ answer: vi.fn(), extract }).prompts(
        job,
        book,
      ),
    ).rejects.toMatchObject({
      code: 'onboarding_branded_limit',
      retryable: false,
      receipt,
    });
    expect(extract).toHaveBeenCalledOnce();
  });
});
