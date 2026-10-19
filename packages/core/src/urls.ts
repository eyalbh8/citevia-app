import { getDomain } from 'tldts';

export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['gclid', 'fbclid', 'msclkid'].includes(key.toLowerCase())) url.searchParams.delete(key);
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
