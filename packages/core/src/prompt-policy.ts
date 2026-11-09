import type { Brand, JourneyStage } from './types.js';
import { JOURNEY_STAGES, promptFingerprint } from './onboarding.js';

export const MAX_BRANDED_PROMPTS = 15;
/** New 50-prompt portfolios use this exact target. The separate manual editor cap preserves custom portfolios. */
export const ONBOARDING_BRANDED_PROMPTS = 10;
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

const domainInPrompt =
  /(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,})(?:[/?#][^\s]*)?/giu;
const hebrewPrefixes = [
  'ב',
  'ל',
  'מ',
  'כ',
  'ו',
  'ה',
  'ש',
  'וב',
  'ול',
  'ומ',
  'וכ',
  'וה',
  'וש',
];
const unspacedScripts =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function promptWords(value: string): string {
  const normalized = promptFingerprint(value);
  if (!unspacedScripts.test(normalized)) return normalized;
  return Array.from(segmenter.segment(normalized))
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .join(' ');
}

function matchesPromptIdentity(
  text: string,
  names: string[],
  domains: string[],
): boolean {
  const hosts: string[] = [];
  const wording = text.replace(domainInPrompt, (_match, host: string) => {
    hosts.push(host.toLowerCase());
    return ' ';
  });
  const words = ` ${promptWords(wording)} `;
  const hasDomain = (value: string) => {
    const host = value
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    return (
      !!host &&
      hosts.some((found) => found === host || found.endsWith('.' + host))
    );
  };
  return (
    domains.some(hasDomain) ||
    names.some((name) => {
      // Companies such as example.com use their own domain as their display name.
      if (name.includes('.') && hasDomain(name)) return true;
      const key = promptWords(name);
      if (!key) return false;
      if (words.includes(` ${key} `)) return true;
      return (
        /\p{Script=Hebrew}/u.test(wording) &&
        hebrewPrefixes.some((prefix) => words.includes(` ${prefix}${key} `))
      );
    })
  );
}

/** A URL identifies a company by its host. A name in another site's URL is not a mention. */
export function isBrandedPrompt(
  text: string,
  brand: Pick<Brand, 'name' | 'aliases' | 'domains'>,
): boolean {
  return matchesPromptIdentity(
    text,
    [brand.name, ...brand.aliases],
    brand.domains,
  );
}

export function containsPromptName(text: string, name: string): boolean {
  return matchesPromptIdentity(text, [name], []);
}

/** Allocate the remaining branded slots around the operator's saved manual questions. */
export function brandedAllocation(
  allocation: Record<JourneyStage, number>,
  manualBranded = 0,
): Record<JourneyStage, number> {
  const slots = { understand: 0, prefer: 0, trust: 0, convert: 0 };
  let remaining = Math.max(0, ONBOARDING_BRANDED_PROMPTS - manualBranded);
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

/** Reserve room for a commercial question when a partially manual Prefer section is small. */
export function comparisonAllocation(
  prefer: number,
  branded: number,
  peerCount: number,
) {
  const comparisonSlots = prefer >= 2 ? prefer - 1 : prefer;
  const brandedComparisons = Math.min(3, branded, comparisonSlots);
  const unbrandedComparisons = Math.min(
    3,
    prefer - branded,
    comparisonSlots - brandedComparisons,
  );
  return {
    branded: brandedComparisons,
    unbranded: unbrandedComparisons,
    distinct_named_rivals: Math.min(brandedComparisons, peerCount),
  };
}

export function isShortBuyerPrompt(text: string): boolean {
  return (
    Array.from(text).length <= MAX_GENERATED_PROMPT_CHARACTERS &&
    text.trim().split(/\s+/u).length <= MAX_GENERATED_PROMPT_WORDS &&
    !/[\r\n]/u.test(text) &&
    (text.match(/[?？؟]/gu) || []).length <= 1
  );
}
