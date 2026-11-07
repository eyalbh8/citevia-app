import { hasRestrictedDestination } from '@citevia/core';
import { normalizeDomain, normalizeUrl } from '@citevia/core';

// Official logo from https://e2visasusa.com/wp-content/uploads/2023/11/logo-1.jpeg.
// Serve verified brand assets locally before trying third-party logo indexes.
const verifiedLogoAssets: Readonly<Record<string, string>> = {
  'e2visasusa.com': '/brand-logos/e2visasusa.jpeg',
};

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

/** Verified brand assets, then Logo.dev and favicon fallbacks. */
export function domainLogoSources(
  value?: string | null,
  token?: string,
): string[] {
  const domain = logoDomain(value);
  if (!domain || hasRestrictedDestination(domain)) return [];
  const publicToken = token?.trim();
  const sources: string[] = verifiedLogoAssets[domain]
    ? [verifiedLogoAssets[domain]]
    : [];
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
