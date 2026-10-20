import { createHash } from 'node:crypto';
import type { Brandbook, CapturedAnswer } from '@citevia/core';
import { object, ProviderError } from './provider.js';
import { BRANDBOOK_SCHEMA } from './onboarding-prompts.js';

export interface ResearchEvidence {
  id: string;
  blockId: string;
  start: number;
  end: number;
  quote: string;
  url: string;
}

/** Quotes and source bindings come from saved native citations, never from generated text. */
export function researchEvidenceCatalog(
  research: CapturedAnswer,
): ResearchEvidence[] {
  const catalog = new Map<string, ResearchEvidence>();
  for (const citation of research.citations) {
    const block = research.blocks.find(
      (block) => block.id === citation.blockId,
    );
    if (
      !block ||
      !Number.isInteger(citation.start) ||
      !Number.isInteger(citation.end)
    )
      continue;
    const start = citation.start!,
      end = citation.end!;
    if (start < 0 || end <= start || end > block.text.length) continue;
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      citation.url.length > 2048
    )
      continue;
    const lineStart = block.text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const nextLine = block.text.indexOf('\n', end);
    const lineEnd = nextLine === -1 ? block.text.length : nextLine;
    // Long paragraphs remain bounded while retaining the native attribution and its nearby claim.
    const from = Math.max(lineStart, end - 1800),
      to = Math.min(lineEnd, from + 2000);
    const quote = block.text.slice(from, to).trim();
    if (!quote || !research.text.includes(quote)) continue;
    const offset = block.text.indexOf(quote, from);
    if (offset > start || offset + quote.length < end) continue;
    const id = `e_${createHash('sha256').update(`${block.id}:${offset}:${quote}:${citation.url}`).digest('hex').slice(0, 20)}`;
    catalog.set(id, {
      id,
      blockId: block.id,
      start: offset,
      end: offset + quote.length,
      quote,
      url: citation.url,
    });
    if (catalog.size >= 100) break;
  }
  return [...catalog.values()];
}

export function brandbookGenerationSchema(catalog: ResearchEvidence[]) {
  return {
    ...BRANDBOOK_SCHEMA,
    properties: {
      ...BRANDBOOK_SCHEMA.properties,
      evidence: {
        type: 'array',
      minItems: 1,
      maxItems: 50,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            evidenceId: {
              type: 'string',
              enum: catalog.map((item) => item.id),
            },
          },
          required: ['field', 'evidenceId'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function resolveBrandbookEvidence(
  raw: unknown,
  catalog: ResearchEvidence[],
): unknown {
  const value = object(raw);
  if (!value || !Array.isArray(value.evidence))
    throw new ProviderError(
      'brandbook_evidence_invalid',
      'The brandbook did not select research evidence. Automatic generation stopped.',
      false,
    );
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const evidence: Brandbook['evidence'] = value.evidence.map((raw) => {
    const selection = object(raw),
      item =
        typeof selection?.evidenceId === 'string'
          ? byId.get(selection.evidenceId)
          : undefined;
    if (
      !item ||
      typeof selection?.field !== 'string' ||
      Object.keys(selection).some(
        (key) => !['field', 'evidenceId'].includes(key),
      )
    )
      throw new ProviderError(
        'brandbook_evidence_invalid',
        'The brandbook selected invalid research evidence. Automatic generation stopped.',
        false,
      );
    return { field: selection.field, quote: item.quote, url: item.url };
  });
  return { ...value, evidence };
}
