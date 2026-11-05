const restrictedWords = /(?<![\p{L}\p{M}\p{N}])demos?(?![\p{L}\p{M}\p{N}])/giu;
export const reportOmission = '[…]';

export function hasRestrictedWord(text: string): boolean {
  return text.search(restrictedWords) !== -1;
}

export function publicReportText(text: string): string {
  return text.replace(restrictedWords, reportOmission);
}

/** Inline markup can split a single visible word across multiple text nodes. */
export function publicReportTextParts(parts: string[]): string[] {
  const combined = parts.join('');
  const matches = [...combined.matchAll(restrictedWords)];
  if (!matches.length) return parts;
  let offset = 0, index = 0;
  return parts.map(part => {
    let cursor = offset;
    offset += part.length;
    let rendered = '';
    while (index < matches.length && matches[index].index < offset) {
      const match = matches[index];
      if (match.index >= cursor) rendered += combined.slice(cursor, match.index) + reportOmission;
      const end = match.index + match[0].length;
      cursor = Math.min(end, offset);
      if (end > offset) break;
      index++;
    }
    return rendered + combined.slice(cursor, offset);
  });
}
