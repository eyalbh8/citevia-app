import type { Brand, JourneyStage } from './types.js';
import { JOURNEY_STAGES, promptFingerprint } from './onboarding.js';

export const MAX_BRANDED_PROMPTS = 15;
export const MAX_GENERATED_PROMPT_CHARACTERS = 160;
export const MAX_GENERATED_PROMPT_WORDS = 20;
export const PROMPT_INTENTS = [
  'informational',
  'discovery',
  'commercial',
  'comparison',
  'validation',
  'transactional',
] as const;
export type PromptIntent = (typeof PROMPT_INTENTS)[number];
export const STAGE_INTENTS = {
  understand: ['informational', 'discovery'],
  prefer: ['commercial', 'comparison'],
  trust: ['validation'],
  convert: ['transactional', 'commercial'],
} as const satisfies Record<JourneyStage, readonly PromptIntent[]>;

/** Match complete names/aliases, including punctuation variants, never a substring of another word. */
export function isBrandedPrompt(
  text: string,
  brand: Pick<Brand, 'name' | 'aliases' | 'domains'>,
): boolean {
  const normalized = ` ${promptFingerprint(text)} `;
  return [brand.name, ...brand.aliases, ...brand.domains].some((name) => {
    const key = promptFingerprint(name);
    return !!key && normalized.includes(` ${key} `);
  });
}

/** Branded slots are a ceiling, shared across sections after counting saved manual questions. */
export function brandedAllocation(
  allocation: Record<JourneyStage, number>,
  manualBranded = 0,
): Record<JourneyStage, number> {
  const slots = { understand: 0, prefer: 0, trust: 0, convert: 0 };
  let remaining = Math.max(0, MAX_BRANDED_PROMPTS - manualBranded);
  while (remaining > 0) {
    let assigned = false;
    for (const stage of JOURNEY_STAGES) {
      if (slots[stage] >= allocation[stage]) continue;
      slots[stage]++;
      remaining--;
      assigned = true;
      if (!remaining) break;
    }
    if (!assigned) break;
  }
  return slots;
}

export function isShortBuyerPrompt(text: string): boolean {
  return (
    Array.from(text).length <= MAX_GENERATED_PROMPT_CHARACTERS &&
    text.trim().split(/\s+/u).length <= MAX_GENERATED_PROMPT_WORDS &&
    !/[\r\n]/u.test(text) &&
    (text.match(/[?？؟]/gu) || []).length <= 1
  );
}
