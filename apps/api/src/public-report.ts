import {
  publicReportId, resolveReportId, publicReportText, publicReportMarkdown, publicSourceUrl,
  type CapturedAnswer, type DemoConfig,
} from '@citevia/core';
import { AccessError } from '@citevia/storage';
import { isDeepStrictEqual } from 'node:util';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifierField = (key: string) => key === 'id' || key === 'ids' || /Ids?$/.test(key) || key === 'subject';
const privateFields = new Set(['captureKey', 'analysisKey', 'summaryKey', 'researchKey', 'brandbookKey', 'promptsKey', 'reusedFrom', 'generationId']);
const sourceLists = new Set(['citations', 'sources', 'knowledgeSources', 'sourceUrls', 'evidence']);
const publicNames = new Map([['demo', 'reportingProfile'], ['demoPost', 'workspacePost']]);
const publicEnums = new Map([['website-demo', 'website-history'], ['demo-draft', 'report-draft'], ['public-website-demo', 'public-website-history']]);

type ReportingProfile = Pick<DemoConfig, 'startDate' | 'endDate' | 'anchorDate' | 'reportingProfile'> & {
  source: string; trackedUrls?: DemoConfig['trackedUrls'];
};

function profile(value: DemoConfig): ReportingProfile {
  return {
    source: publicEnums.get(value.source) ?? value.source,
    startDate: value.startDate, endDate: value.endDate, anchorDate: value.anchorDate,
    reportingProfile: value.reportingProfile,
    trackedUrls: value.trackedUrls?.filter(item => item.demoPost),
  };
}

function printText(value: string, key: string): string {
  if (identifierField(key)) return publicReportText(publicReportId(value));
  if (/^https?:\/\/\S+$/i.test(value)) return publicSourceUrl(value) ?? '';
  if (['kind', 'source', 'model', 'generationModel', 'extractionModel'].includes(key) && publicEnums.has(value))
    return publicEnums.get(value)!;
  return publicReportMarkdown(value);
}

// The wire includes only the metadata needed for attribution. Provider-native envelopes can include
// unrelated internal payloads, duplicate unabridged answers, signed handles, or encoded attachments.
function captureMetadata(raw: unknown): Record<string, unknown> {
  if (!record(raw)) return {};
  return Object.fromEntries(['demo', 'source', 'projection', 'illustrative', 'presentation']
    .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
}

function publicAnswer(answer: CapturedAnswer): Record<string, unknown> {
  const result = publicObject({ ...answer, raw: captureMetadata(answer.raw) });
  if (answer.text !== result.text || JSON.stringify(answer.blocks) !== JSON.stringify(result.blocks) ||
      answer.citations.length !== (result.citations as unknown[]).length ||
      answer.sources.length !== (result.sources as unknown[]).length) result.isExcerpt = true;
  return result;
}

function publicObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (privateFields.has(key)) return [];
    const name = publicNames.get(key) ?? publicReportText(publicReportId(key));
    if (key === 'demo' && record(item) && 'startDate' in item)
      return [[name, publicReportValue(profile(item as unknown as DemoConfig))]];
    if (key === 'answer' && record(item) && Array.isArray(item.blocks) && Array.isArray(item.sources) && Array.isArray(item.citations))
      return [[name, publicAnswer(item as unknown as CapturedAnswer)]];
    if (key === 'raw') return [[name, publicReportValue(captureMetadata(item))]];
    return [[name, publicReportValue(item, key)]];
  }));
}

/** Project stored records to their public report representations, without modifying persisted evidence. */
export function publicReportValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return printText(value, key);
  if (Array.isArray(value)) return value.flatMap(item => {
    const url = typeof item === 'string' ? item : record(item) ? item.url : undefined;
    if (sourceLists.has(key) && typeof url === 'string' && /^https?:\/\//i.test(url) && !publicSourceUrl(url)) return [];
    return [publicReportValue(item, key)];
  });
  return record(value) ? publicObject(value) : value;
}

/** Apply only to JSON report responses, never OAuth grants, signed blobs, or JSON-RPC envelopes. */
export async function publicReportResponse(response: Response): Promise<Response> {
  if (!response.body || !response.headers.get('content-type')?.includes('application/json')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(publicReportValue(await response.json())), { status: response.status, headers });
}

/** Decode identifiers only; customer text, OAuth audiences, credentials and URLs are never rewritten. */
export function resolveReportInput(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (identifierField(key)) return resolveReportId(value);
    if (key === 'path' && value.startsWith('/v1/projects/')) return resolveReportPath(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(child => resolveReportInput(child, key));
  return record(value) ? Object.fromEntries(Object.entries(value).map(([field, child]) => [field, resolveReportInput(child, field)])) : value;
}

function resolveReportPath(path: string): string {
  return path.split('/').map(segment => segment.includes('cvh_') ? resolveReportId(segment) : segment).join('/');
}

export function resolveReportUrl(original: string): URL {
  const url = new URL(original);
  url.pathname = resolveReportPath(url.pathname);
  for (const key of new Set(url.searchParams.keys())) {
    if (!identifierField(key)) continue;
    const values = url.searchParams.getAll(key);
    if (values.some(value => value.includes('cvh_'))) {
      url.searchParams.delete(key);
      values.forEach(value => url.searchParams.append(key, resolveReportId(value)));
    }
  }
  return url;
}

/** Full-form editors can send the visible representation back unchanged. Preserve withheld source
 * fields during unrelated edits and reject ambiguous changes to an incomplete source list. */
export function restoreReportFields(input: unknown, original: Record<string, unknown>): unknown {
  if (!record(input)) return input;
  const result = { ...input };
  for (const [field, incoming] of Object.entries(input)) {
    if (!Object.hasOwn(original, field)) continue;
    const saved = original[field];
    const visible = resolveReportInput(publicReportValue(saved, field), field);
    if (isDeepStrictEqual(saved, visible)) continue;
    if (isDeepStrictEqual(visible, incoming) || (visible === '' && incoming === null)) {
      result[field] = saved;
    } else if (record(incoming) && record(saved)) {
      result[field] = restoreReportFields(incoming, saved);
    } else if (Array.isArray(saved) || incoming === null || incoming === '' || JSON.stringify(incoming)?.includes('[…]')) {
      throw new AccessError(409, 'INCOMPLETE_FIELD', 'This field contains withheld material and cannot be replaced from this report.');
    }
  }
  return result;
}
