export {
  hasRestrictedWord as hasExcerptOmissions,
  publicReportText as reportExcerpt,
  publicReportTextParts as reportExcerptParts,
} from '@citevia/core';

const blockTags = new Set('address article aside blockquote br caption dd details div dl dt figure figcaption footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul'.split(' '));
export function isReportTextBoundary(tag?: string): boolean {
  return tag !== undefined && blockTags.has(tag.toLowerCase());
}
