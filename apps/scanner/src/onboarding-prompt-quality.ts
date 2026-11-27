import { promptFingerprint, type Brand } from '@citevia/core';
import { ProviderError } from './provider.js';

type BuyerSearch = { text: string; branded: boolean };
export type BuyerSearchIssue = { index: number; code: string; reason: string; relatedIndex?: number };
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
  if (language === 'es') {
    // A named-provider recommendation may begin with the same words as a definition.
    if (/(?:^| )(?:mejor(?:es)?|recomiendan|recomiendas|recomendados?|alternativas?|dónde (?:puedo|podemos))(?= |$)/u.test(text)) return false;
    return [
      /^(?:qué (?:es|son)|qué significa|en qué consiste|cómo funciona[n]?) /u,
      /^cuál es (?:la definición|el significado|la diferencia) /u,
      /^cuáles son (?:los|las) (?:requisitos|pasos|documentos|reglas)(?: |$)/u,
      /^(?:cómo (?:puedo |debo |se )?(?:elegir|escoger|seleccionar)|qué (?:documentos|requisitos|pasos) (?:necesito|necesitamos|se necesitan|hacen falta)) /u,
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

// Look for positive evidence of the other language. A bare name, ticker, or
// borrowed term such as "copy trading" does not identify the surrounding language.
const englishQuestion = /^(?:which|what|where|who|whose|how|can i|should i|would|does|do i|looking (?:for|to)|find a|is .+ (?:good|better))(?= |$)/u;
const spanishQuestion = /^(?:qué|cuál|cuáles|cuánto|dónde|quién|cómo|puedo|hay|me recomiendan)(?= |$)/u;
const spanishGrammar = /(?:^| )(?:qué|cuál|cuáles|cuánto|dónde|quién|cómo|para|del|las|los|con|desde|entre|mejor|mejores|tienen|ofrecen|puedo|cobran|sirven)(?= |$)/gu;
const englishGrammar = /(?:^| )(?:which|what|where|who|whose|how|the|and|by|on|other|with|for|from|offer|offers|providers?|suppliers?|buyers?|recommended|lowest|cheapest|best|can|should)(?= |$)/gu;

function wrongLatinLanguage(wording: string, language: string): boolean {
  if (language !== 'es' && language !== 'en') return false;
  const markers = (pattern: RegExp) =>
    new Set(Array.from(wording.matchAll(pattern), match => match[0].trim())).size;
  const english = markers(englishGrammar);
  const spanish = markers(spanishGrammar);
  if (language === 'es') {
    return spanish === 0 && (englishQuestion.test(wording) || english >= 2 ||
      /^best .*(?:apps|brokers|platforms|accounts|companies|firms)(?: |$)/u.test(wording));
  }
  return english === 0 && (spanishQuestion.test(wording) || spanish >= 2);
}

function multipleDecisions(original: string, wording: string, language: string): boolean {
  if ((original.match(/[?？؟]/gu) || []).length > 1) return true;
  // "stocks and crypto" and "what and where to buy" can be one buying decision.
  // Look for a second self-contained question, after the first clause.
  if (language === 'en') {
    return /\S+ \S+ .*\b(?:and|also) (?:(?:how|where|when|why|what|which|who) (?:can|could|do|does|did|is|are|should|would|will|much|long|many)|(?:which|what) (?:[\p{L}]+ ){1,2}(?:can|do|does|are|is|will))\b/u.test(wording);
  }
  if (language === 'es') {
    return /\S+ \S+ .*(?: y | e | además )(?:cómo|cuánto|cuándo|dónde|qué|cuál|cuáles|quién) /u.test(wording);
  }
  if (language === 'he') {
    return /\S+ \S+ .* ו(?:איך|כמה|מתי|היכן|איפה|למי|האם) /u.test(wording);
  }
  return false;
}

// Remove common ways of phrasing the same search. Preserve names, numbers,
// negation, action, criteria, and word order (e.g. transfers from A to B).
function decisionKey(text: string, language: string): string {
  let key = text;
  if (language === 'en') {
    key = key
      .replace(/^(?:(?:can|could) you (?:please )?(?:recommend|suggest|list)|(?:please )?(?:recommend|suggest|list)|what (?:is|are)|which|show me|looking for) /u, '')
      .replace(/\b(?:apps|brokers|platforms|accounts|providers)\b/gu, plural => plural.slice(0, -1))
      .replace(/\b(?:have|has|charge|charges) (?=(?:the )?(?:lowest|highest|low|high) (?:[\p{L}]+ ){0,2}(?:fees?|spreads?|rates?)\b)/gu, '')
      .replace(/\b(?:offer|offers|offering|provide|provides|with|that|the|a|an|are|is)\b/gu, ' ');
  } else if (language === 'es') {
    key = key
      .replace(/^(?:qué|cuáles son|cuál es|me recomiendan|recomiéndame|busco) /u, '')
      .replace(/(?:^| )(?:ofrecen|ofrece|con|los|las|el|la|un|una)(?= |$)/gu, ' ');
  }
  key = key.replace(/\s+/gu, ' ').trim();
  // A short remainder lacks context for claiming two prompts are equivalent.
  return key.split(' ').length >= 2 ? key : '';
}

export function buyerSearchIssues(
  searches: BuyerSearch[],
  locale: string,
  brand: Identity,
  competitors: readonly Identity[] = [],
): BuyerSearchIssue[] {
  if (!searches.length) return [];
  let language: Intl.Locale;
  try {
    language = new Intl.Locale(locale.replaceAll('_', '-'));
  } catch {
    language = new Intl.Locale(/^[a-z]{2,3}(?:[-_]|$)/i.exec(locale)?.[0].replace(/[-_]$/, '') || 'und');
  }
  const expectedScript = language.language === 'und' ? undefined : scripts[language.maximize().script || ''];
  const names = [brand, ...competitors].flatMap((entity, id) =>
    [entity.name, ...entity.aliases, ...entity.domains]
      .map(promptFingerprint).filter(Boolean).map(name => ({name, token: 'entity' + id})))
    .sort((a, b) => b.name.length - a.name.length);
  const seen = new Map<string, number>();
  const issues: BuyerSearchIssue[] = [];
  for (const [index, search] of searches.entries()) {
    const text = promptFingerprint(search.text);
    let masked = ' ' + text + ' ';
    for (const {name, token} of names) masked = masked.replaceAll(' ' + name + ' ', ' ' + token + ' ');
    const wording = masked.replace(/\bentity\d+\b/gu, '').replace(/\s+/gu, ' ').trim();
    const letters = wording.match(/\p{L}/gu) ?? [];
    if ((expectedScript && (!letters.length ||
      letters.filter(letter => expectedScript.test(letter)).length < Math.ceil(letters.length / 8))) ||
      wrongLatinLanguage(wording, language.language)) {
      issues.push({index, code: 'onboarding_prompt_language', reason: 'Use natural wording in ' + locale + ' around official names.'});
    }
    if (!search.branded && asksForGeneralAdvice(text, language.language)) {
      issues.push({index, code: 'onboarding_generic_prompt', reason: 'Ask where to find or which provider offers the service. A definition or checklist answers this draft.'});
    }
    if (language.language === 'es' && /(?:^| )(?:mejor|mejores) shortlist(?= |$)/u.test(wording)) {
      issues.push({index, code: 'onboarding_prompt_wording', reason: 'Ask for a recommendation in everyday Spanish.'});
    }
    if (multipleDecisions(search.text, text, language.language)) {
      issues.push({index, code: 'onboarding_multiple_decisions', reason: 'Keep one buyer decision and remove the second question.'});
    }
    const key = decisionKey(masked.trim(), language.language);
    if (!key) continue;
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({index, relatedIndex: previous, code: 'onboarding_duplicate_decision', reason: 'Choose a different buyer need. This repeats the decision in row ' + (previous + 1) + '.'});
    } else {
      seen.set(key, index);
    }
  }
  return issues;
}

export function validateBuyerSearches(
  searches: BuyerSearch[],
  locale: string,
  brand: Identity,
  competitors: readonly Identity[] = [],
): void {
  const issues = buyerSearchIssues(searches, locale, brand, competitors);
  if (!issues.length) return;
  const message = issues.map(({index, reason}) => 'Row ' + (index + 1) + ': ' + reason).join('\n');
  throw Object.assign(new ProviderError(issues[0].code, message, false), {
    issues,
    rowIndices: [...new Set(issues.map(issue => issue.index))],
  });
}
