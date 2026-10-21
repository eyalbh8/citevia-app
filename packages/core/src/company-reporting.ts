import type {
  Analysis,
  BrandAnalysis,
  CapturedAnswer,
  Citation,
  RunSnapshot,
} from './types.js';
import { brandRank, brandSentimentScore } from './scoring.js';
import { promptFingerprint } from './onboarding.js';
import { domainForUrl } from './urls.js';

/** Queryable iGEO projection; native captures and analysis receipts remain unchanged. */
export function reportingCitations(
  answer: CapturedAnswer | null,
): (Citation & { domain: string | null })[] {
  return (answer?.citations || []).map((citation) => ({
    ...citation,
    domain: domainForUrl(citation.url),
  }));
}
export function reportingCompanies(
  analysis: Analysis | null,
  snapshot: RunSnapshot,
  answer: CapturedAnswer | null,
) {
  const tracked = [snapshot.brand, ...snapshot.competitors];
  const mentioned = (analysis?.brands || []).filter((brand) => brand.mentioned);
  const measured = new Map<string, BrandAnalysis>();
  const entries = (analysis?.companies || []).map((company) => {
    const name = promptFingerprint(company.name);
    const identity = tracked.find((brand) =>
      [brand.name, ...brand.aliases].some(
        (alias) => promptFingerprint(alias) === name,
      ),
    );
    const brand = identity
      ? mentioned.find((item) => item.brandId === identity.id)
      : undefined;
    if (brand) measured.set(brand.brandId, brand);
    return {
      company: company.name,
      rank: company.rank,
      identity,
      brand,
      sentiment: company.sentimentEvidence
        ? company.sentiment || 'unknown'
        : 'unknown',
      evidence: [company.evidence],
    };
  });
  for (const brand of mentioned) {
    if (measured.has(brand.brandId)) continue;
    const identity = tracked.find((item) => item.id === brand.brandId);
    if (identity)
      entries.push({
        company: identity.name,
        rank: brandRank(brand)!,
        identity,
        brand,
        sentiment:
          brand.sentiment === 'not_applicable' ? 'unknown' : brand.sentiment,
        evidence: brand.evidence,
      });
  }
  return entries
    .map((entry) => {
      const evidence = entry.brand?.evidence || entry.evidence;
      const domain = entry.identity?.domains[0] || null;
      const sentiment = entry.brand?.sentiment || entry.sentiment;
      // Only native citation ranges that overlap verified company evidence imply attribution.
      const sources = reportingCitations(answer).filter(
        (citation) =>
          citation.start !== null &&
          citation.end !== null &&
          evidence.some(
            (span) =>
              span.blockId === citation.blockId &&
              span.start < citation.end! &&
              citation.start! < span.end,
          ),
      );
      return {
        company: entry.identity?.name || entry.company,
        rank: entry.brand ? brandRank(entry.brand) : entry.rank,
        explicitRank: entry.brand?.explicitRank ?? null,
        sentimentScore: brandSentimentScore({ mentioned: true, sentiment }),
        feel: sentiment,
        sentiment,
        company_site_url: domain ? `https://${domain}` : null,
        domain,
        sources,
        reason: evidence.map((span) => span.quote).join('\n'),
        tracked: !!entry.identity,
        brandId: entry.identity?.id || null,
      };
    })
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}
