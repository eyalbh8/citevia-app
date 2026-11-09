import { describe, expect, it, vi } from 'vitest';
import {
  brandedAllocation,
  comparisonAllocation,
  containsPromptName,
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
  it('requires exactly ten named questions and forty discovery questions using the actual text', async () => {
    const { job, book, prompts } = await portfolio();
    const misleadingFlags = prompts.map((p) => ({ ...p, branded: !p.branded }));
    const accepted = validatePortfolio(job, book, { prompts: misleadingFlags });
    expect(accepted.filter((p) => p.branded)).toHaveLength(10);
    expect(accepted.filter((p) => !p.branded)).toHaveLength(40);
    const firstBranded = prompts.find((p) => p.branded)!;
    firstBranded.text =
      'Who offers replacement parts for independent retailers?';
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({ code: 'onboarding_branded_limit' }),
    );
  });
  it('requires the complete brand name in generated branded searches including similar service names', async () => {
    const { job, book, prompts } = await portfolio();
    job.input.name = 'E2 Visas USA';
    book.names = ['E2 Visas USA', 'E2 Visa USA'];
    book.domains = ['e2visasusa.com'];
    for (const prompt of prompts)
      prompt.text = prompt.text.replaceAll('Acme', job.input.name);
    const branded = prompts.find((p) => p.branded)!;
    branded.text = 'Can E2 Visa USA handle my visa application?';
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({ code: 'onboarding_brand_identity_invalid' }),
    );
    branded.text = 'Who would use e2visasusa.com for an application?';
    expect(() => validatePortfolio(job, book, { prompts })).toThrowError(
      expect.objectContaining({ code: 'onboarding_brand_identity_invalid' }),
    );
  });
  it('uses distinct verified peers for direct comparisons and keeps open comparisons for discovery', async () => {
    const job = policyJob(),
      provider = new FixtureOnboardingProvider();
    const book = (await provider.brandbook(job)).brandbook;
    const peers = ['Cinder', 'Pinewood', 'Pondstar'].map((name) => ({
      name,
      aliases: [],
      domains: [],
    }));
    const { prompts } = await provider.prompts(job, book, peers);
    const comparisons = prompts.filter((p) => p.intent === 'comparison');
    expect(comparisons.filter((p) => p.branded)).toHaveLength(3);
    expect(comparisons.filter((p) => !p.branded)).toHaveLength(3);
    const rows = prompts.map(({ text, topic, intent, stage, branded }) => ({
      text,
      topic,
      intent,
      stage,
      branded,
    }));
    const direct = rows.filter(p => p.branded && p.intent === 'comparison');
    direct[0].text = 'Compare Acme, Cinder and Pinewood for setup help';
    direct[1].text = 'How does Acme compare to Cinder on repair support?';
    expect(validatePortfolio(job, book, { prompts: rows }, peers)).toHaveLength(50);
    rows.find((p) => p.text.includes('Pondstar'))!.text =
      'Compare Acme and a different supplier for training';
    expect(() =>
      validatePortfolio(job, book, { prompts: rows }, peers),
    ).toThrowError(
      expect.objectContaining({
        code: 'onboarding_comparison_coverage_invalid',
      }),
    );
    rows.find(
      (p) =>
        p.branded &&
        p.intent === 'comparison' &&
        p.text.includes('different supplier'),
    )!.text = 'Book a demo with Acme and Pondstar';
    expect(() =>
      validatePortfolio(job, book, { prompts: rows }, peers),
    ).toThrowError(
      expect.objectContaining({
        code: 'onboarding_comparison_coverage_invalid',
      }),
    );
    expect(comparisonAllocation(2, 1, 0)).toEqual({
      branded: 1,
      unbranded: 0,
      distinct_named_rivals: 0,
    });
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
    expect(isBrandedPrompt('מה ההבדל בין המתחרים ולמותג?', brand)).toBe(true);
    expect(
      isBrandedPrompt('מי מציע חלופה לE2 Visas USA?', {
        name: 'E2 Visas USA',
        aliases: [],
        domains: [],
      }),
    ).toBe(true);
    expect(isBrandedPrompt('Geo.com.evil.net/geo.com reviews', brand)).toBe(
      false,
    );
    expect(isBrandedPrompt('Geoの導入を検討できる会社', brand)).toBe(true);
    expect(containsPromptName('日本でAcmeを選ぶ理由', 'Acme')).toBe(true);
    expect(containsPromptName('日本でAcmeProを選ぶ理由', 'Acme')).toBe(false);
    expect(containsPromptName('任天堂の製品を扱う店', '任天堂')).toBe(true);
    expect(containsPromptName('任天堂の製品を扱う店', '天堂')).toBe(false);
    expect(containsPromptName('See https://geo.com for support', 'Geo')).toBe(
      false,
    );
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
    const slots = brandedAllocation(JOURNEY_PROMPT_COUNTS, 7);
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
