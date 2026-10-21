import {
  competitorBrands,
  competitorDomain,
  promptFingerprint,
  type Brand,
  type CapturedAnswer,
  type DiscoveredCompetitor,
} from '@citevia/core';
import { z } from 'zod';
import {
  researchEvidenceCatalog,
  type ResearchEvidence,
} from './onboarding-evidence.js';
import { ProviderError } from './provider.js';

export function competitorGenerationSchema(catalog: ResearchEvidence[]) {
  return {
    type: 'array',
    maxItems: 5,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        websiteUrl: { type: 'string' },
        evidenceIds: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', enum: catalog.map((item) => item.id) },
        },
      },
      required: ['name', 'websiteUrl', 'evidenceIds'],
      additionalProperties: false,
    },
  };
}

/** Resolve only names and official sites backed by the saved web research. */
export function resolveDiscoveredCompetitors(
  raw: unknown,
  research: CapturedAnswer,
  ownBrand: Brand,
): DiscoveredCompetitor[] {
  const parsed = z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          websiteUrl: z.string().trim().url().max(2048),
          evidenceIds: z.array(z.string()).min(1).max(5),
        })
        .strict(),
    )
    .max(5)
    .safeParse(raw);
  if (!parsed.success)
    throw new ProviderError(
      'competitor_evidence_invalid',
      'Generated competitors did not pass validation.',
      false,
    );
  const catalog = researchEvidenceCatalog(research);
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const candidates: DiscoveredCompetitor[] = [];
  for (const value of parsed.data) {
    const domain = competitorDomain(value.websiteUrl);
    const evidence = value.evidenceIds.map((id) => byId.get(id));
    const name = promptFingerprint(value.name);
    // Require the candidate's name and an official-domain citation in its selected
    // evidence. Third-party citations alone cannot establish a website identity.
    if (
      !domain ||
      evidence.some((item) => !item) ||
      !evidence.some(
        (item) =>
          item &&
          competitorDomain(item.url) === domain &&
          ` ${promptFingerprint(item.quote)} `.includes(` ${name} `),
      )
    )
      continue;
    candidates.push({
      name: value.name,
      domain,
      evidence: [
        ...new Map(
          evidence.map((item) => [
            item!.id,
            { quote: item!.quote, url: item!.url },
          ]),
        ).values(),
      ],
    });
  }
  const accepted = new Set(
    competitorBrands({ id: 'discovery', brand: ownBrand }, candidates).map(
      (brand) => `${brand.domains[0]}:${promptFingerprint(brand.name)}`,
    ),
  );
  const unique = new Map<string, DiscoveredCompetitor>();
  for (const candidate of candidates)
    if (
      accepted.has(
        `${candidate.domain}:${promptFingerprint(candidate.name)}`,
      ) &&
      !unique.has(candidate.domain)
    )
      unique.set(candidate.domain, candidate);
  return [...unique.values()];
}
