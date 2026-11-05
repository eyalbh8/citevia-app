const omittedWords = /(?<![\p{L}\p{M}\p{N}])demos?(?![\p{L}\p{M}\p{N}])/giu;
const omission = '[…]';

/** Mask the displayed excerpt only. Callers keep saved text and link destinations intact. */
export function reportExcerpt(text: string): string {
  return text.replace(omittedWords, omission);
}

export function hasExcerptOmissions(text: string): boolean {
  return text.search(omittedWords) !== -1;
}

// Inline styling may split one visible word among several nodes, e.g. **de**mo.
export function reportExcerptParts(parts: string[]): string[] {
  const combined = parts.join('');
  const matches = [...combined.matchAll(omittedWords)];
  if (!matches.length) return parts;
  let offset = 0, index = 0;
  return parts.map(part => {
    let cursor = offset;
    offset += part.length;
    let rendered = '';
    while (index < matches.length && matches[index].index < offset) {
      const match = matches[index];
      if (match.index >= cursor) rendered += combined.slice(cursor, match.index) + omission;
      const end = match.index + match[0].length;
      cursor = Math.min(end, offset);
      if (end > offset) break;
      index++;
    }
    return rendered + combined.slice(cursor, offset);
  });
}

const blockTags = new Set('address article aside blockquote br caption dd details div dl dt figure figcaption footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul'.split(' '));
export function isReportTextBoundary(tag?: string): boolean {
  return tag !== undefined && blockTags.has(tag.toLowerCase());
}
