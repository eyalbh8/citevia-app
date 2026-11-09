import { createHash } from 'node:crypto';
import type { Brandbook, CapturedAnswer } from '@citevia/core';
import { containsPromptName, normalizeUrl, promptFingerprint } from '@citevia/core';
import { object, ProviderError } from './provider.js';
import { BRANDBOOK_SCHEMA } from './onboarding-prompts.js';

export interface ResearchEvidence {
  id: string;
  blockId: string;
  start: number;
  end: number;
  quote: string;
  url: string;
  listHeading?: string;
}

/** Compare against the submitted host, preserving tenant boundaries for hosted sites. */
export function isOfficialBrandSource(url: string, website: string) {
  const actual = normalizeUrl(url);
  const submitted = normalizeUrl(website);
  if (!actual || !submitted || new URL(actual).port || new URL(submitted).port) return false;
  const host = new URL(actual).hostname.replace(/^www\./i, '').replace(/\.$/, '');
  const own = new URL(submitted).hostname.replace(/^www\./i, '').replace(/\.$/, '');
  return host === own || host.endsWith('.' + own);
}

// An inline citation label can contain a name even when the researcher did not
// identify the business in the passage. Keep only the prose for matching.
function narrative(text: string) {
  return text.replace(/!?\[[^\]\n]*\]\(https?:\/\/[^)\n]+\)/giu, '')
    .replace(/https?:\/\/[^\s)\]]+/giu, '').replace(/[\*_]/gu, '')
    .replace(/\(\s*\)|\[\s*\]/gu, '').trim();
}

function disputesIdentity(text: string) {
  const wording = promptFingerprint(text);
  return [
    /\b(?:cannot|can t|could not|unable to|failed to) (?:be )?(?:identify|confirm|verify|establish|match|identify the relationship)\b/u,
    /\b(?:could not be|cannot be|was not|has not been) (?:identified|verified|matched|confirmed)\b/u,
    /\b(?:no (?:reliable |official |clear )?(?:evidence|confirmation|connection|affiliation)|unrelated (?:business|firm|company)|a different (?:business|firm|company)|not (?:the same|affiliated|associated) (?:with|as|business|firm|company))\b/u,
    /(?:^| )(?:לא ניתן|לא היה ניתן|אי אפשר|לא הצלחנו|לא הצלחתי) (?:היה )?(?:לזהות|לאמת|לאשר|לשייך)(?: |$)/u,
    /(?:^| )(?:לא (?:אותר|נמצא|זוהה|אומת)(?:ה|ו)?|אין (?:עדות|ראיה|ראייה|הוכחה|קשר|זיקה)|(?:חברה|עסק|משרד) (?:אחר|אחרת|שונה|שונים)|אינ[הו] (?:קשור|מזוהה))(?: |$)/u,
  ].some(pattern => pattern.test(wording));
}

function identifiesCompany(text: string, name: string) {
  const wording = ' ' + promptFingerprint(text) + ' ';
  const key = promptFingerprint(name);
  return containsPromptName(text, name) && !disputesIdentity(text) &&
    !['not ', 'rather than ', 'ולא ', 'לא ', 'אינו ', 'אינה '].some(prefix => wording.includes(' ' + prefix + key + ' '));
}

export function deniesOffering(text: string) {
  const wording = promptFingerprint(text);
  return [
    /\b(?:does not|do not|did not|doesn t|don t|no longer|cannot|never) (?:itself |directly |actually )?(?:offer|provide|sell|deliver|operate|serve|support|perform|manufacture|speciali[sz]e|handle)\b/u,
    /\b(?:not (?:offered|provided|sold|available)|no evidence (?:that|of)|whether .+ offers?)\b/u,
    /(?:^| )(?:אינ[והםן]|איננו|איננה|לא|אף פעם לא) (?:מציע\S*|מספק\S*|מוכר\S*|נות[ןנ]\S*|עוסק\S*|מטפל\S*|מתמח\S*|מעניק\S*)(?: |$)/u,
  ].some(pattern => pattern.test(wording));
}

export function requireOfficialResearch(catalog: ResearchEvidence[], website: string, name: string) {
  if (!catalog.some(item => isOfficialBrandSource(item.url, website) && identifiesCompany(narrative(item.quote), name)))
    throw new ProviderError('onboarding_official_research_missing',
      'Research needs a source-cited description identifying the submitted business on its official website.', false);
}

export function verifiedBrandNames(primary: string, website: string, book: Pick<Brandbook, 'names' | 'evidence'>): string[] {
  const passages = book.evidence
    .filter(item => item.field === 'names' && isOfficialBrandSource(item.url, website))
    .map(item => narrative(item.quote)).filter(text => !disputesIdentity(text));
  const unique = new Map([[promptFingerprint(primary), primary]]);
  for (const candidate of book.names) {
    const key = promptFingerprint(candidate);
    if (key && !unique.has(key) && passages.some(passage => containsPromptName(passage, candidate))) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].slice(0, 20);
}

function sourceListHeading(text: string, lineStart: number, quote: string) {
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s/u;
  if (!bullet.test(quote)) return undefined;
  // Walk the contiguous list to its nearest heading. A blank line, a new
  // heading, or a paragraph about another business ends the attribution.
  const lines = text.slice(Math.max(0, lineStart - 4000), Math.max(0, lineStart - 1)).split('\n');
  while (lines.length && bullet.test(lines[lines.length - 1])) lines.pop();
  const heading = lines.pop()?.trim();
  return heading && (/[:：]$/u.test(heading) || /^#{1,6}\s/u.test(heading)) && heading.length <= 500
    ? heading : undefined;
}

/** Quotes and source bindings come from saved native citations, never from generated text. */
export function researchEvidenceCatalog(
  research: CapturedAnswer,
): ResearchEvidence[] {
  const catalog = new Map<string, ResearchEvidence>();
  for (const citation of research.citations) {
    const block = research.blocks.find(
      (block) => block.id === citation.blockId,
    );
    if (
      !block ||
      !Number.isInteger(citation.start) ||
      !Number.isInteger(citation.end)
    )
      continue;
    const start = citation.start!,
      end = citation.end!;
    if (start < 0 || end <= start || end > block.text.length) continue;
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      citation.url.length > 2048
    )
      continue;
    const lineStart = block.text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    // A second claim can follow the first citation on the same line. Its
    // source cannot be used to back the preceding business's claim. Adjacent
    // citation markers with only punctuation between them support the same text.
    let clauseStart = lineStart;
    for (const other of research.citations) {
      if (other.blockId !== citation.blockId || other.end === null || other.end > start || other.end <= clauseStart) continue;
      if (/[\p{L}\p{N}]/u.test(narrative(block.text.slice(other.end, start)))) clauseStart = other.end;
    }
    const from = Math.max(clauseStart, end - 2000), to = end;
    const quote = block.text.slice(from, to).trim();
    if (!quote || !research.text.includes(quote)) continue;
    const offset = block.text.indexOf(quote, from);
    if (offset > start || offset + quote.length < end) continue;
    const id = `e_${createHash('sha256').update(`${block.id}:${offset}:${quote}:${citation.url}`).digest('hex').slice(0, 20)}`;
    const listHeading = sourceListHeading(block.text, lineStart, quote);
    catalog.set(id, {
      id,
      blockId: block.id,
      start: offset,
      end: offset + quote.length,
      quote,
      url: citation.url,
      ...(listHeading ? {listHeading} : {}),
    });
    if (catalog.size >= 100) break;
  }
  return [...catalog.values()];
}

const factFields = [
  'about', 'industryCategory', 'subIndustryCategory', 'names', 'keyFeatures',
  'toneOfVoice', 'values', 'personality', 'targetAudience',
] as const;

type FactField = typeof factFields[number];
type Facts = Pick<Brandbook, FactField>;

function invalidEvidence(message: string): never {
  throw new ProviderError('brandbook_evidence_invalid', message, false);
}

export function brandbookGenerationSchema(official: ResearchEvidence[]) {
  return {
    ...BRANDBOOK_SCHEMA,
    properties: {
      ...BRANDBOOK_SCHEMA.properties,
      evidence: {
        type: 'array',
        minItems: 2,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: [...factFields] },
            value: { type: 'string' },
            evidenceId: { type: 'string', enum: official.map(item => item.id) },
          },
          required: ['field', 'value', 'evidenceId'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function plainText(text: string) {
  return narrative(text).normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Keep the entire supporting statement, including qualifications such as
 * “for business customers only”. A selected noun alone can invert its meaning. */
export function supportedStatement(passage: string, selected: string, language: string) {
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(language); }
  catch { locale = new Intl.Locale(language.split('-')[0] || 'und'); }
  const sentences = new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(passage);
  for (const {segment} of sentences) {
    if (segment.includes(selected)) return segment.trim().replace(/^[-•–]\s*/u, '');
  }
  // More than one sentence can legitimately describe the business.
  return passage;
}

export function resolveBrandbookEvidence(
  raw: unknown,
  official: ResearchEvidence[],
  company: { name: string; website: string; language: string },
): unknown {
  const value = object(raw);
  if (!value || !Array.isArray(value.evidence) || value.evidence.length > 50)
    invalidEvidence('Select official research evidence for the company profile.');
  if (value.identityStatus !== undefined && value.identityStatus !== 'identified')
    invalidEvidence('Official research does not establish the submitted business identity.');
  if (factFields.some(field => Object.hasOwn(value, field)))
    invalidEvidence('Company facts must be selected from the saved research.');
  const byId = new Map(official.map(item => [item.id, item]));
  const facts: Facts = { about: '', industryCategory: '', subIndustryCategory: '', names: [],
    keyFeatures: [], toneOfVoice: [], values: [], personality: [], targetAudience: [] };
  const evidence: Brandbook['evidence'] = [];
  const gaps = new Set<string>();
  for (const rawSelection of value.evidence) {
    const selection = object(rawSelection);
    const item = typeof selection?.evidenceId === 'string' ? byId.get(selection.evidenceId) : undefined;
    if (!selection || !item || typeof selection.value !== 'string' || typeof selection.field !== 'string' ||
        !factFields.includes(selection.field as FactField) || !isOfficialBrandSource(item.url, company.website) ||
        Object.keys(selection).some(key => !['field', 'value', 'evidenceId'].includes(key)))
      invalidEvidence('A company fact has no valid reference to the official website.');
    const field = selection.field as FactField;
    const passage = plainText(item.quote);
    const claim = plainText(selection.value);
    if (!claim || !/[\p{L}\p{N}]/u.test(claim) || !passage.includes(claim)) {
      if (claim) gaps.add(claim.slice(0, 300));
      continue;
    }
    const supported = field === 'about' || field === 'keyFeatures'
      ? supportedStatement(passage, claim, company.language) : claim;
    if (field === 'about' && (!identifiesCompany(supported, company.name) || supported.length < 20))
      invalidEvidence('Select an official overview identifying ' + company.name + ' by name.');
    const listSubject = item.listHeading && identifiesCompany(narrative(item.listHeading), company.name) &&
      !/\b(?:competitors?|rivals?|alternatives?|partners?)\b|(?:מתחר|חלופ|שותפים)/iu.test(item.listHeading);
    if (field === 'keyFeatures' && ((!identifiesCompany(supported, company.name) && !listSubject) ||
        disputesIdentity(supported) || deniesOffering(supported))) {
      gaps.add(claim.slice(0, 300));
      continue;
    }
    if (field === 'about' || field === 'industryCategory' || field === 'subIndustryCategory') {
      if (facts[field] && facts[field] !== supported)
        invalidEvidence('Select one supported ' + field + ' description.');
      facts[field] = supported;
    } else if (!facts[field].includes(supported)) {
      facts[field].push(supported);
    }
    if (!evidence.some(entry => entry.field === field && entry.quote === item.quote && entry.url === item.url))
      evidence.push({ field, quote: item.quote, url: item.url });
  }
  if (!facts.about || !facts.keyFeatures.length)
    invalidEvidence('Select both an official company overview and at least one verified product or service.');

  // The Brandbook view already presents unknowns under “Needs verification”.
  // Keep omitted candidate wording in the requested language for the owner.
  const unknowns = Array.isArray(value.unknowns)
    ? [...new Set([...value.unknowns, ...[...gaps].map(claim => company.language.split('-')[0] === 'he'
      ? 'לא אומת מול מקורות המשרד: ' + claim : 'Unverified against the official sources: ' + claim)])].slice(0, 30)
    : value.unknowns;
  const {identityStatus: _status, ...editorial} = value;
  return { ...editorial, ...facts, evidence, unknowns };
}
