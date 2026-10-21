import { getDomain } from 'tldts';
import { promptFingerprint } from './onboarding.js';
import { sourceId } from './urls.js';
import type { Brand, Project } from './types.js';

export interface DiscoveredCompetitor {
  name: string;
  domain: string;
  evidence: { quote: string; url: string }[];
}

/** Public company domains only; a citation or a generated hostname is not itself a competitor. */
export function competitorDomain(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      /\.(example|invalid|test|local)$/i.test(url.hostname)
    )
      return null;
    return getDomain(url.hostname, { allowPrivateDomains: true });
  } catch {
    return null;
  }
}

/** Stable tracking identities survive retries, while duplicate/owned candidates are excluded. */
export function competitorBrands(
  project: Pick<Project, 'id' | 'brand'>,
  candidates: DiscoveredCompetitor[],
): Brand[] {
  const names = new Set(
    [project.brand.name, ...project.brand.aliases].map(promptFingerprint),
  );
  const domains = new Set(
    project.brand.domains.map(competitorDomain).filter(Boolean),
  );
  const brands: Brand[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.trim(),
      normalizedName = promptFingerprint(name);
    const domain = competitorDomain(candidate.domain);
    if (
      !name ||
      name.length > 120 ||
      !domain ||
      names.has(normalizedName) ||
      domains.has(domain)
    )
      continue;
    names.add(normalizedName);
    domains.add(domain);
    brands.push({
      id: `competitor_${sourceId(`${project.id}:${domain}`).slice(2)}`,
      name,
      aliases: [],
      domains: [domain],
    });
    if (brands.length === 5) break;
  }
  return brands;
}
