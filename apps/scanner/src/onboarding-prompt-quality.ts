import { promptFingerprint, type Brand } from '@citevia/core';
import { ProviderError } from './provider.js';

type BuyerSearch = { text: string; branded: boolean };
type Identity = Pick<Brand, 'name' | 'aliases' | 'domains'>;

// A native search can contain foreign product names and acronyms. Test the
// wording around those names, allowing the scripts mixed by each writing system.
const scripts: Record<string, RegExp> = {
  Arab: /\p{Script=Arabic}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Deva: /\p{Script=Devanagari}/u,
  Grek: /\p{Script=Greek}/u,
  Hans: /\p{Script=Han}/u,
  Hant: /\p{Script=Han}/u,
  Hebr: /\p{Script=Hebrew}/u,
  Jpan: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Kore: /[\p{Script=Hangul}\p{Script=Han}]/u,
  Latn: /\p{Script=Latin}/u,
  Thai: /\p{Script=Thai}/u,
};

// Only conclusively educational forms are rejected here. A profession in the
// question is not sufficient: "What is a broker?" can be answered without names.
function asksForGeneralAdvice(text: string, language: string): boolean {
  if (language === 'en') {
    const asksForNames = /\b(?:who|recommend\w*|shortlist\w*|alternatives?|best|top|cheapest|where (?:can|should) (?:i|we) (?:buy|hire|book))\b/u;
    const asksForOption = /\b(?:good|affordable|reputable|trusted|local|popular|reliable|specialist) (?:[\p{L}]+ ){0,3}(?:firms?|companies|brands?|providers?|practices?|brokers?|suppliers?|stores?|options?)\b/u;
    if (asksForNames.test(text) || asksForOption.test(text)) return false;
    // Match definitions and checklist requests narrowly. An open-ended plural
    // such as "What are three platforms for small teams?" is a provider search.
    return [
      /^what is (?:an? |the (?:meaning|definition|process|purpose) of )/u,
      /^what is (?:[\p{L}\p{N}]+ ){0,2}[\p{L}\p{N}]+$/u,
      /^what are (?:the )?(?:requirements|documents|steps|benefits|rules)\b/u,
      /^what (?:documents|qualifications|steps|requirements) (?:do|are) /u,
      /^(?:what|which) (?:(?:types|kinds) of )?services are (?:offered|available) to /u,
      /^what does .+ mean$/u,
      /^how (?:do (?:i|we)|to) (?:choose|select|qualify|apply for) /u,
    ].some(pattern => pattern.test(text));
  }
  if (language === 'he') {
    const asksForNames = /(?:^| )(?:מי|למי|ממי|תמליצו|המליצו|מומלץ|מומלצ(?:ים|ת|ות)|מובילים|מתחרים|חלופות|אלטרנטיבות)(?: |$)/u;
    if (asksForNames.test(text)) return false;
    return [
      /^מה (?:זה|זו|זאת|פירוש|המשמעות|הדרישות|התנאים|המסמכים|השלבים)(?: |$)/u,
      /^מה(?:ו|ם|ן|י) (?:ההבדל|השלבים|התנאים|הדרישות|המשמעות|התהליך)(?: |$)/u,
      /^(?:איך|כיצד) (?:לבחור|בוחרים) /u,
      /^(?:אילו|איזה) מסמכים (?:צריך|נדרשים)(?: |$)/u,
      /^(?:אילו|איזה|מהם) (?:סוגי )?שירותים (?:מוצעים|זמינים|קיימים|מסייעים|עוזרים)(?: |$)/u,
    ].some(pattern => pattern.test(text));
  }
  return false;
}

function firstWords(
  segmenter: Intl.Segmenter,
  text: string,
  language: string,
): string[] {
  const words: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue;
    words.push(segment);
    if (words.length === 2) break;
  }
  if (language === 'he' && /^ו?[מבלכ]?(?:אילו|איזו|איזה)$/u.test(words[0] || '')) {
    words[0] = 'אילו';
  }
  return words;
}

export function validateBuyerSearches(
  searches: BuyerSearch[],
  locale: string,
  brand: Identity,
): void {
  if (!searches.length) return;
  // Onboarding also supports saved BCP-47-style application tags. Older tags
  // with a non-standard subtag can still use their base language here.
  let language: Intl.Locale;
  try {
    language = new Intl.Locale(locale.replaceAll('_', '-'));
  } catch {
    language = new Intl.Locale(/^[a-z]{2,3}(?:[-_]|$)/i.exec(locale)?.[0].replace(/[-_]$/, '') || 'und');
  }
  const expectedScript = language.language === 'und' ? undefined : scripts[language.maximize().script || ''];
  const names = [brand.name, ...brand.aliases, ...brand.domains]
    .map(promptFingerprint)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  const openingWords = new Map<string, number>();
  const openingPairs = new Map<string, number>();
  for (const search of searches) {
    const text = promptFingerprint(search.text);
    let wording = ' ' + text + ' ';
    for (const name of names) wording = wording.replaceAll(' ' + name + ' ', ' ');
    const letters = wording.match(/\p{L}/gu) ?? [];
    if (
      expectedScript &&
      (!letters.length || letters.filter(letter => expectedScript.test(letter)).length < Math.ceil(letters.length / 8))
    ) {
      throw new ProviderError(
        'onboarding_prompt_language',
        'Write every generated search in the requested language, preserving brand names.',
        false,
      );
    }
    if (!search.branded && asksForGeneralAdvice(text, language.language)) {
      throw new ProviderError(
        'onboarding_generic_prompt',
        'A generated search asks for a definition, checklist or general advice. Ask for real providers, shortlists or places to buy for that need.',
        false,
      );
    }
    const words = firstWords(segmenter, text, language.language);
    if (words.length) openingWords.set(words[0], (openingWords.get(words[0]) ?? 0) + 1);
    if (words.length > 1) {
      const pair = words.join(' ');
      openingPairs.set(pair, (openingPairs.get(pair) ?? 0) + 1);
    }
  }
  // Apply portfolio-level variety checks only to a substantial generated batch.
  // When most prompts were supplied manually there may be only one or two slots.
  if (searches.length < 12) return;
  const repeated = [
    ...[...openingWords].filter(([, count]) => count > searches.length * 0.4),
    ...[...openingPairs].filter(([, count]) => count > searches.length * 0.25),
  ];
  if (repeated.length) {
    const examples = repeated.map(([words, count]) => `“${words.slice(0, 50)}” (${count} times)`).join(', ');
    throw new ProviderError(
      'onboarding_repetitive_openings',
      `Too many searches start with ${examples}. Rewrite at least half of those openings using specific buyer situations or short noun phrases.`,
      false,
    );
  }
}
