import { normalizeDomain, normalizeUrl } from '@citevia/core';

/** Only public hostnames are sent to image services, never paths or URL tokens. */
export function logoDomain(value?: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const url = normalizeUrl(
    raw.startsWith('//')
      ? `https:${raw}`
      : raw.includes('://')
        ? raw
        : `https://${raw}`,
  );
  if (!url) return null;
  const domain = normalizeDomain(url)?.replace(/\.$/, '');
  if (
    !domain ||
    !domain.includes('.') ||
    /^\d+(?:\.\d+){3}$/.test(domain) ||
    /[\[\]:]/.test(domain) ||
    /\.(?:localhost|local|internal|test|invalid|example)$/i.test(domain)
  )
    return null;
  return domain;
}

/** iGEO's Logo.dev domain lookup, with a favicon fallback when unavailable. */
export function domainLogoSources(
  value?: string | null,
  token?: string,
): string[] {
  const domain = logoDomain(value);
  if (!domain) return [];
  const publicToken = token?.trim();
  const sources: string[] = [];
  if (publicToken?.startsWith('pk_')) {
    const params = new URLSearchParams({
      token: publicToken,
      size: '64',
      format: 'png',
      fallback: '404',
    });
    sources.push(
      `https://img.logo.dev/${encodeURIComponent(domain)}?${params}`,
    );
  }
  sources.push(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
  );
  return sources;
}

export function logoInitials(
  name?: string | null,
  domain?: string | null,
): string {
  const label = name?.trim() || logoDomain(domain)?.split('.')[0] || '';
  const words = label.split(/\s+/).filter(Boolean);
  return words.length > 1
    ? `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`.toUpperCase()
    : Array.from(label).slice(0, 2).join('').toUpperCase() || '↗';
}
