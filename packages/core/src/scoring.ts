import type { BrandAnalysis } from './types.js';

/** Matches iGEO's 50 + 50 * (positive - negative) / classified mentions. */
export function brandSentimentScore(brand?: BrandAnalysis): number | null {
  if (!brand?.mentioned) return null;
  return {
    positive: 100,
    neutral: 50,
    mixed: 50,
    negative: 0,
    unknown: null,
    not_applicable: null,
  }[brand.sentiment];
}
export function brandRank(brand?: BrandAnalysis): number | null {
  if (!brand?.mentioned) return null;
  return brand.appearanceRank ?? brand.explicitRank ?? null;
}
