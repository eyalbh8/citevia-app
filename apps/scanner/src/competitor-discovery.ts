import {
  competitorBrands,
  competitorDomain,
  containsPromptName,
  normalizeUrl,
  promptFingerprint,
  type Brand,
  type CapturedAnswer,
  type DiscoveredCompetitor,
} from '@citevia/core';
import { z } from 'zod';
import {
  deniesOffering,
  isOfficialBrandSource,
  plainText,
  researchEvidenceCatalog,
  supportedStatement,
  type ResearchEvidence,
} from './onboarding-evidence.js';
import { ProviderError } from './provider.js';

const relationship = [
  'direct_alternative',
  'indirect',
  'same_business',
  'uncertain',
] as const;
const proofSchema = z.strictObject({
  evidenceId: z.string(),
  quote: z.string().trim().min(1).max(360),
});
const candidateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  websiteUrl: z.string().trim().url().max(2048),
  relationship: z.enum(relationship),
  sharedNeed: z.string().trim().min(1).max(100),
  targetOffering: proofSchema,
  competingOffering: proofSchema,
  market: proofSchema.extend({
    country: z.string().regex(/^[A-Z]{2}$/),
    area: z.string().trim().min(1).max(100),
  }),
});

export function competitorGenerationSchema(catalog: ResearchEvidence[]) {
  const evidenceId = { type: 'string', enum: catalog.map((item) => item.id) };
  const proof = {
    evidenceId,
    quote: { type: 'string', minLength: 1, maxLength: 360 },
  };
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return {
    type: 'array',
    maxItems: 5,
    items: object({
      name: { type: 'string', minLength: 1, maxLength: 120 },
      websiteUrl: { type: 'string' },
      relationship: { type: 'string', enum: [...relationship] },
      sharedNeed: { type: 'string', minLength: 1, maxLength: 100 },
      targetOffering: object(proof),
      competingOffering: object(proof),
      market: object({
        ...proof,
        country: { type: 'string', pattern: '^[A-Z]{2}$' },
        area: { type: 'string', minLength: 1, maxLength: 100 },
      }),
    }),
  };
}

const narrative = (text: string) =>
  text
    .replace(/\[[^\]]*\]\(https?:\/\/[^)]+\)/giu, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/giu, ' ')
    .replace(/\[(?:\d+|source|citation)\]/giu, ' ')
    .trim();

function selectedProof(
  selection: z.infer<typeof proofSchema>,
  officialSites: string[],
  catalog: Map<string, ResearchEvidence>,
  language: string,
) {
  const entry = catalog.get(selection.evidenceId);
  if (
    !entry ||
    !officialSites.some((site) =>
      isOfficialBrandSource(
        entry.url,
        site.includes('://') ? site : 'https://' + site,
      ),
    )
  )
    return undefined;
  const statement = plainText(entry.quote);
  const claim = plainText(selection.quote);
  if (!claim || !statement.includes(claim) || !narrative(claim))
    return undefined;
  const quote = supportedStatement(statement, claim, language);
  if (deniesOffering(quote)) return undefined;
  return { quote, url: entry.url };
}

// Common audience, sector or vendor labels alone cannot establish a buyer substitution.
const genericNeedWords = new Set(
  (
    'a an and for the of to in on at from across around within our with offering offers delivers small medium sized size team teams large online local global professional specialist specialists consulting services service products product business businesses companies company customers customer clients client consumers consumer providers provider firms firm solutions solution enterprises enterprise support advice guidance ' +
    'שירות שירותים שירותי מוצר מוצרים פתרון פתרונות ייעוץ ליווי תמיכה עסקי עסקית עסק עסקים חברות לקוחות לקוח ספק ספקים מקצועי מקצועית מקומי מקומיים קטנים ברחבי בתוך עבור בין במדינה באזור ו'
  ).split(' '),
);
function needKey(value: string) {
  return promptFingerprint(value)
    .split(' ')
    .filter((word) => !genericNeedWords.has(word))
    .join(' ');
}

function excludedLocations(language: string) {
  const excluded = new Set(Object.values(marketAliases).flat().map(needKey));
  for (const locale of new Set(['en', language])) {
    let display;
    try {
      display = new Intl.DisplayNames([locale], {
        type: 'region',
        fallback: 'none',
      });
    } catch {
      continue;
    }
    for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const name = display.of(first + second);
        if (name) excluded.add(needKey(name));
      }
    }
  }
  return excluded;
}

function locationOnly(need: string, locations: Set<string>) {
  const key = needKey(need);
  return (
    locations.has(key) || (/^[במלהו]/u.test(key) && locations.has(key.slice(1)))
  );
}

function specificNeed(
  need: string,
  ownBrand: Brand,
  candidateName: string,
  country: string,
) {
  const key = promptFingerprint(need);
  if (/^(?=.*[a-z])(?=.*\d)[a-z\d‐‑–-]+$/iu.test(need)) return true;
  return (
    key
      .split(' ')
      .some((word) => word.length > 1 && !genericNeedWords.has(word)) &&
    ![country, candidateName, ownBrand.name, ...ownBrand.aliases].some(
      (name) => promptFingerprint(name) === key,
    )
  );
}

// Common market abbreviations and irregular demonyms. Research is asked to
// record the country alongside local service areas in the account language.
const marketAliases: Record<string, string[]> = {
  US: [
    'US',
    'U.S.',
    'USA',
    'U.S.A.',
    'United States',
    'American',
    'Americans',
    'ארה"ב',
    'ארצות הברית',
  ],
  GB: ['UK', 'U.K.', 'United Kingdom', 'Britain', 'British'],
  IL: [
    'Israel',
    'Israeli',
    'Israelis',
    'ישראל',
    'ישראלי',
    'ישראלית',
    'ישראלים',
    'ישראליות',
    'ישראליים',
  ],
  IT: ['Italian', 'Italiani', 'italiani', 'italiane'],
  FR: ['French', 'Français', 'française', 'françaises'],
  DE: ['German', 'Germans', 'deutsche', 'deutschen'],
  CA: ['Canadian', 'Canadians'],
  AU: ['Australian', 'Australians'],
  NL: ['Dutch'],
  CH: ['Swiss'],
  ES: ['Spanish'],
  JP: ['Japanese'],
};
const globalMarket =
  /(?:\b(?:worldwide|globally|all countries|around the world|across the globe|à travers le monde|weltweit|in tutto il mondo|en todo el mundo)\b|(?:בכל|מכל|ברחבי) העולם|世界各地|世界中)/iu;
const serviceWords =
  /\b(?:serves?|serving|supports?|ships?|shipping|delivers?|available|offers?|operates?|provides?|sells?|accepts?|customers?|clients?|buyers?)\b/iu;
const hebrewService =
  /(?:לקוחות|משקיע|צרכנ|שירות|מספק|משרת|מציע|מלווה|מטפל|מעניק|פעיל|פועל|זמי|משלוח)/u;
const headquarters =
  /\b(?:headquarter\w*|based|incorporated|founded|registered office)\b|(?:משרדי החברה|מטה החברה)/iu;

function marketLabels(country: string, language: string) {
  const names = new Set([country, ...(marketAliases[country] ?? [])]);
  for (const locale of new Set(['en', language])) {
    try {
      const localName = new Intl.DisplayNames([locale], {
        type: 'region',
        fallback: 'none',
      }).of(country);
      if (localName) names.add(localName);
    } catch {
      /* Legacy locale tags may not be supported by this runtime. */
    }
  }
  return [...names];
}

function marketFits(
  area: string,
  quote: string,
  marketNames: string[],
  language: string,
  sharedNeed: string,
): boolean {
  const statement = narrative(quote);
  if (
    !containsPromptName(statement, area) ||
    /\b(?:excluding|except|unavailable|with the exception of)\b|(?:למעט|חוץ מ|אינו משרת|אינה משרתת|לא משרת)/iu.test(
      statement,
    )
  )
    return false;
  const locale = language.split('-')[0];
  const supportedMarket =
    marketNames.some((name) => containsPromptName(statement, name)) ||
    globalMarket.test(statement);
  if (!supportedMarket) return false;
  const describesService =
    serviceWords.test(statement) || hebrewService.test(statement);
  if (headquarters.test(statement) && !describesService) return false;
  if (
    headquarters.test(statement) &&
    !marketNames.some((name) => containsPromptName(area, name))
  )
    return false;
  return (
    describesService ||
    (!['en', 'he'].includes(locale) &&
      (containsPromptName(statement, sharedNeed) ||
        promptFingerprint(statement) !== promptFingerprint(area)))
  );
}

// Research may spell a product or visa identifier both E2 and E‑2.
function containsService(text: string, term: string) {
  const normalizeCodes = (value: string) =>
    value.replace(/([a-z])[‐‑–-](?=\d)/giu, '$1');
  return containsPromptName(normalizeCodes(text), normalizeCodes(term));
}

// When a model writes a sentence instead of the short requested service label,
// retain only a specific shared phrase literally present in both official claims.
// A shared technical identifier (e.g. E-2, SQL2022) can stand on its own.
function commonService(
  proposal: string,
  target: string,
  rival: string,
  exclude: string[],
  locations: Set<string>,
): string | undefined {
  const supports = (term: string) =>
    !locationOnly(term, locations) &&
    !exclude.some(
      (value) => promptFingerprint(value) === promptFingerprint(term),
    ) &&
    [target, rival].every((quote) => containsService(quote, term));
  if (supports(proposal)) return proposal;
  const words = proposal.match(/[\p{L}\p{N}]+(?:[‐‑–-][\p{L}\p{N}]+)*/gu) ?? [];
  const productCode = words.find(
    (word) =>
      /^(?=.*[a-z])(?=.*\d)[a-z\d‐‑–-]+$/iu.test(word) && supports(word),
  );
  if (productCode) return productCode;
  for (let n = Math.min(6, words.length); n >= 2; n--) {
    for (let at = 0; at + n <= words.length; at++) {
      const group = words.slice(at, at + n);
      const informative = group.filter(
        (word) =>
          word.length > 1 && !genericNeedWords.has(promptFingerprint(word)),
      );
      if (informative.length < 2) continue;
      const term = group.join(' ');
      if (supports(term)) return term;
    }
  }
  return undefined;
}

function publicationOnly(text: string) {
  const editorial =
    /(?:\b(?:publish(?:es|ed)?|review(?:s|ed)?|lists?|articles?|directories|news coverage|resource guide)\b|מפרס[םמ]ת? מאמר|מציג[ה]? (?:הסבר|מדריך)|פורטל|אתר חדשות)/iu;
  const offersService =
    /(?:\b(?:sells?|delivers?|provides? .* services?|offers? .* services?|represents? clients)\b|(?:מעניק|מספק|מציע)[ה]? שירות|מייצג[ת]? לקוחות)/iu;
  return editorial.test(text) && !offersService.test(text);
}

/** A numbered heading can label the following cited bullet. Require the exact
 * heading, plus an identity independently corroborated by the official hostname
 * or a distinctive acronym in both the offering and that hostname. */
function identifiedHeading(
  name: string,
  entry: ResearchEvidence,
  research: CapturedAnswer,
  offering: string,
  domain: string,
) {
  const block = research.blocks.find((item) => item.id === entry.blockId);
  const heading = block?.text
    .slice(0, entry.start)
    .trimEnd()
    .split('\n')
    .at(-1)
    ?.trim();
  if (!heading || !/^(?:#{1,6}\s+|\d+[.)]\s+|\*\*)/u.test(heading))
    return false;
  const label = heading.replace(/^(?:#{1,6}\s+|\d+[.)]\s+)/u, '');
  if (promptFingerprint(label) !== promptFingerprint(name)) return false;
  const stem = domain.split('.')[0].replaceAll('-', '');
  if (promptFingerprint(name).replaceAll(' ', '') === stem) return true;
  const acronyms = name.match(/\b[A-Z]{3,}\b/g) ?? [];
  return acronyms.some(
    (term) =>
      containsPromptName(offering, term) && stem.includes(term.toLowerCase()),
  );
}

/** Only select quotes from official cited research. Preserve the evidence used to decide
 * what a buyer could buy from either provider and whom the competing business serves. */
export function resolveDiscoveredCompetitors(
  raw: unknown,
  research: CapturedAnswer,
  ownBrand: Brand,
  scope: { country: string; language: string; promptFocus?: string },
): DiscoveredCompetitor[] {
  if (!Array.isArray(raw) || raw.length > 5)
    throw new ProviderError(
      'competitor_evidence_invalid',
      'Generated competitors did not pass validation.',
      false,
    );
  const catalog = new Map(
    researchEvidenceCatalog(research).map((item) => [item.id, item]),
  );
  const domains = ownBrand.domains
    .map(competitorDomain)
    .filter((x): x is string => !!x);
  const marketNames = marketLabels(scope.country, scope.language);
  const locations = excludedLocations(scope.language);
  const focus = scope.promptFocus?.trim();
  // Sometimes the requested focus is an exact service name in first-party
  // research. In that case a different business line cannot justify a rival.
  // Across translations, the researched direct-alternative decision supplies this check.
  const explicitFocus =
    focus &&
    [...catalog.values()].some(
      (item) =>
        domains.includes(competitorDomain(item.url) || '') &&
        containsPromptName(narrative(item.quote), focus),
    );
  const focusTerms = explicitFocus
    ? promptFingerprint(focus!)
        .split(' ')
        .filter((term) => term.length > 1 && !genericNeedWords.has(term))
    : [];
  const candidates: DiscoveredCompetitor[] = [];
  for (const row of raw) {
    // A weak candidate should not discard the supported rivals or the brandbook.
    const parsed = candidateSchema.safeParse(row);
    if (!parsed.success) continue;
    const candidate = parsed.data;
    const domain = competitorDomain(candidate.websiteUrl);
    if (
      !domain ||
      domains.includes(domain) ||
      candidate.relationship !== 'direct_alternative' ||
      candidate.market.country !== scope.country ||
      !specificNeed(
        candidate.sharedNeed,
        ownBrand,
        candidate.name,
        scope.country,
      )
    )
      continue;
    const targetOffering = selectedProof(
      candidate.targetOffering,
      ownBrand.domains,
      catalog,
      scope.language,
    );
    let competingOffering = selectedProof(
      candidate.competingOffering,
      [candidate.websiteUrl],
      catalog,
      scope.language,
    );
    const submittedOffering = competingOffering;
    const selectedMarket = selectedProof(
      candidate.market,
      [candidate.websiteUrl],
      catalog,
      scope.language,
    );
    if (!targetOffering || !competingOffering || !selectedMarket) continue;
    if (
      publicationOnly(competingOffering.quote) &&
      !publicationOnly(targetOffering.quote)
    )
      continue;
    const excluded = [
      ...marketNames,
      candidate.market.area,
      ownBrand.name,
      ...ownBrand.aliases,
      candidate.name,
    ];
    const sharedNeed = commonService(
      candidate.sharedNeed,
      targetOffering.quote,
      competingOffering.quote,
      excluded,
      locations,
    );
    if (
      !sharedNeed ||
      !specificNeed(sharedNeed, ownBrand, candidate.name, scope.country)
    )
      continue;
    if (
      focusTerms.length &&
      !focusTerms.some(
        (term) =>
          containsService(sharedNeed, term) ||
          (containsService(targetOffering.quote, term) &&
            containsService(competingOffering!.quote, term)),
      )
    )
      continue;

    // A named native citation to the very same official page can corroborate a
    // bullet that omitted the business name. Keep that attribution in the UI.
    if (
      !containsPromptName(competingOffering.quote, candidate.name) &&
      !identifiedHeading(
        candidate.name,
        catalog.get(candidate.competingOffering.evidenceId)!,
        research,
        competingOffering.quote,
        domain,
      )
    ) {
      const related = [...catalog.values()].filter((item) => {
        const passage = plainText(item.quote);
        return (
          normalizeUrl(item.url) === normalizeUrl(competingOffering!.url) &&
          containsPromptName(passage, candidate.name) &&
          containsService(passage.replaceAll(ownBrand.name, ' '), sharedNeed) &&
          !deniesOffering(passage) &&
          (!publicationOnly(passage) || publicationOnly(targetOffering.quote))
        );
      });
      const linked =
        related.find((item) =>
          marketNames.some((name) =>
            containsPromptName(plainText(item.quote), name),
          ),
        ) ?? related[0];
      if (!linked) continue;
      competingOffering = { quote: plainText(linked.quote), url: linked.url };
    }

    let market = selectedMarket;
    if (
      !marketFits(
        candidate.market.area,
        market.quote,
        marketNames,
        scope.language,
        sharedNeed,
      )
    ) {
      // Use the page's explicit buyer-facing offering itself if it also verifies
      // availability in this market. A contrary or uncertain country claim
      // cannot be replaced using an unrelated page or a generic background link.
      const regionalOffering = [competingOffering, submittedOffering].find(
        (offering) =>
          offering &&
          marketNames.some((name) =>
            marketFits(
              name,
              offering.quote,
              marketNames,
              scope.language,
              sharedNeed,
            ),
          ),
      );
      if (
        !regionalOffering ||
        normalizeUrl(selectedMarket.url) !==
          normalizeUrl(regionalOffering.url) ||
        /\b(?:only|exclusively|except|excluding|unavailable)\b|(?:בלבד|למעט|חוץ מ)/iu.test(
          selectedMarket.quote,
        )
      )
        continue;
      market = regionalOffering;
    }
    const evidence = [competingOffering, market].filter(
      (item, i, all) =>
        all.findIndex(
          (other) => other.quote === item.quote && other.url === item.url,
        ) === i,
    );
    candidates.push({
      name: candidate.name,
      domain,
      evidence,
      relevance: {
        country: scope.country,
        sharedNeed,
        targetOffering,
        competingOffering,
        market,
      },
    });
  }
  // If two different domains use the same unqualified name, neither is safe
  // as a named comparison. A qualified trading name can distinguish them.
  const unambiguous = candidates.filter(
    (item) =>
      !candidates.some(
        (other) =>
          other.domain !== item.domain &&
          promptFingerprint(other.name) === promptFingerprint(item.name),
      ),
  );
  const brands = competitorBrands(
    { id: 'discovery', brand: ownBrand },
    unambiguous,
  );
  return brands.map((brand) =>
    unambiguous.find(
      (item) => item.domain === brand.domains[0] && item.name === brand.name,
    )!,
  );
}
