import { normalizeUrl, type Brand } from '@citevia/core';
import { aliasOffset } from './extraction.js';

const urls = /https?:\/\/[^\s)\]>]+/giu;
const domainShape = /^(?:[a-z\d-]+\.)+[a-z]{2,63}$/iu;
const host = (value: string) => {
  const normalized = normalizeUrl(value.includes('://') ? value : 'https://' + value);
  return normalized ? new URL(normalized).hostname.replace(/^www\./i, '').replace(/\.$/, '') : null;
};

/** Render emphasis for name matching while mapping every index back to the saved text. */
function inlineName(text: string) {
  const omitted = new Set<number>();
  for (const match of text.matchAll(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/gu)) {
    for (let i = 0; i < match[1].length; i++) {
      omitted.add(match.index! + i);
      omitted.add(match.index! + match[0].length - match[1].length + i);
    }
  }
  const indices: number[] = [];
  let plain = '';
  for (let at = 0; at < text.length; at++) if (!omitted.has(at)) {
    plain += text[at]; indices.push(at);
  }
  return { plain, indices };
}

/** Exact configured identifiers only: no inferred surnames, translations or fuzzy names. */
export function businessIdentifierOffset(text: string, brand: Brand): number {
  const names = [brand.name, ...brand.aliases].filter(Boolean);
  const domains = [...brand.domains, ...names.filter(name => domainShape.test(name))].map(host).filter(Boolean);
  const owned = (candidate: string) => domains.some(domain => candidate === domain || candidate.endsWith('.' + domain));
  const visible = text.replace(urls, value => ' '.repeat(value.length));
  const literalNames = { ...brand, name: '', aliases: names.filter(name => !domainShape.test(name)) };
  let position = aliasOffset(visible, literalNames);
  if (position < 0) {
    const rendered = inlineName(visible), at = aliasOffset(rendered.plain, literalNames);
    if (at >= 0) position = rendered.indices[at];
  }
  const include = (at: number) => { position = position < 0 ? at : Math.min(position, at); };
  // Parse URLs, rather than finding an owned hostname inside somebody else's path or authority.
  for (const match of text.matchAll(urls)) {
    const lineStart = text.lastIndexOf('\n', match.index!) + 1;
    const prefix = text.slice(lineStart, match.index!);
    // Link destinations and source lists are provenance, not a visible business identity.
    if (prefix.endsWith('](') || /^\s*(?:source|sources|reference|references|מקור|מקורות)\s*[:：]/iu.test(prefix) ||
        !/[\p{L}\p{N}]/u.test(prefix)) continue;
    try {
      const url = new URL(match[0]);
      if (!url.username && !url.password && owned(url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')))
        include(match.index! + match[0].toLowerCase().indexOf(url.hostname.toLowerCase()));
    } catch { /* Malformed links establish no identity. */ }
  }
  // This also recognizes a contact address such as office@the-official-domain.com.
  for (const match of visible.matchAll(/(?<![\p{L}\p{N}_.\/-])(?:[a-z\d-]+\.)+[a-z]{2,63}(?![\p{L}\p{N}_.-])/giu)) {
    if (owned(match[0].toLowerCase().replace(/^www\./, ''))) include(match.index!);
  }
  return position;
}

export const containsBusinessIdentifier = (text: string, brand: Brand) => businessIdentifierOffset(text, brand) >= 0;
