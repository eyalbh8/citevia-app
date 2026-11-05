import { getDomain } from 'tldts';
import { hasRestrictedWord, reportOmission } from './public-text.js';

const isTrackingParameter = (key: string) =>
  /^utm_/i.test(key) || ['gclid', 'fbclid', 'msclkid'].includes(key.toLowerCase());

export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParameter(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

export function domainForUrl(raw: string): string | null {
  const safe = normalizeUrl(raw);
  if (!safe) return null;
  const hostname = new URL(safe).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) || hostname;
}

export function normalizeDomain(value: string): string | null {
  return domainForUrl(value.includes('://') ? value : `https://${value}`);
}

// Stable display identifiers, never used as authentication or authorization tokens.
export function sourceId(value: string): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return `s_${hash.toString(36)}`;
}

export function isOwnedDomain(domain: string, owned: string[]): boolean {
  return owned.some(value => normalizeDomain(value) === domain);
}

/** Existing saved publications and bookmarks use the original internal path. */
export function trackedArticleUrl(url: string): string {
  const prefix = 'https://app.citevia.io/demo-content/';
  if (!url.startsWith(prefix)) return url;
  const match = /^([a-zA-Z0-9_-]{1,160})\/([a-z0-9][a-z0-9-]{0,180})$/.exec(url.slice(prefix.length));
  if (!match) return url;
  const account = btoa(match[1]).replace(/=+$/, '');
  return `https://app.citevia.io/articles/${account}/${match[2]}`;
}

/** Check both the spelling displayed by a browser and percent-encoded destinations. */
export function hasRestrictedDestination(value: string): boolean {
  for (let depth = 0; depth < 5; depth++) {
    if (hasRestrictedWord(value) || value.includes(reportOmission)) return true;
    if (!/%[\da-f]{2}/i.test(value)) return false;
    const decoded = value.replace(/(?:%[\da-f]{2})+/gi, escapes => {
      try { return decodeURIComponent(escapes); }
      catch {
        // Malformed UTF-8 must not hide independently decodable ASCII letters.
        return escapes.replace(/%([0-7][\da-f])/gi, (_, digits: string) =>
          String.fromCharCode(Number.parseInt(digits, 16)));
      }
    });
    if (decoded === value) return false;
    value = decoded;
  }
  return hasRestrictedWord(value) || value.includes(reportOmission) || /%[0-7][\da-f]/i.test(value);
}

/** An exact public destination, or null when it cannot be shown without changing the cited page. */
export function publicSourceUrl(input: string | null | undefined): string | null {
  if (!input || !/^https?:\/\//i.test(input)) return null;
  try {
    const value = trackedArticleUrl(input);
    const url = new URL(value);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    if (!hasRestrictedDestination(value) && !hasRestrictedDestination(url.href)) return value;
    // A campaign tag is disposable. Paths, meaningful queries and anchors identify the source.
    let removed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParameter(key) && (hasRestrictedDestination(key) || url.searchParams.getAll(key).some(hasRestrictedDestination))) {
        url.searchParams.delete(key);
        removed = true;
      }
    }
    return removed && !hasRestrictedDestination(url.href) ? url.href : null;
  } catch { return null; }
}
