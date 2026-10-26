import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  onboardingInputSchema,
  type WebsiteHealthCategory,
  type WebsiteHealthDevice,
  type WebsiteHealthFieldResult,
  type WebsiteHealthIssue,
  type WebsiteHealthLabResult,
  type WebsiteHealthMetric,
  type WebsiteHealthRating,
} from '@citevia/core';

type JsonObject = Record<string, unknown>;
type GoogleService = 'pagespeed' | 'crux';
const CATEGORIES: WebsiteHealthCategory[] = ['performance', 'accessibility', 'best-practices', 'seo'];
const CATEGORY_PARAMETERS = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'];
const MAX_ISSUES = 60;
const MAX_ISSUE_BYTES = 256 * 1024;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const score = (value: unknown): number | undefined => {
  const number = finite(value);
  return number !== undefined && number <= 1 ? number : undefined;
};
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, limit) : '';

/** Only sanitized messages from this class may be shown to customers or logged. */
export class WebsiteHealthProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'WebsiteHealthProviderError';
  }
}

export interface GoogleWebsiteHealthOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  resolveKey?: (service: GoogleService) => Promise<string | null>;
}

export function websiteHealthAvailability(): { auditingAvailable: boolean; cruxAvailable: boolean } {
  const configured = (prefix: string) => !!(
    process.env[`${prefix}_API_KEY`]?.trim() || process.env[`${prefix}_SECRET_ARN`]?.trim()
  );
  return { auditingAvailable: configured('GOOGLE_PAGESPEED'), cruxAvailable: configured('GOOGLE_CRUX') };
}

async function googleApiKey(service: GoogleService): Promise<string | null> {
  const prefix = service === 'pagespeed' ? 'GOOGLE_PAGESPEED' : 'GOOGLE_CRUX';
  const field = `${prefix}_API_KEY`;
  const direct = process.env[field]?.trim();
  if (direct) return direct;
  const arn = process.env[`${prefix}_SECRET_ARN`]?.trim();
  if (!arn) return null;
  try {
    const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    if (!secret.SecretString) throw new Error();
    try {
      const parsed = object(JSON.parse(secret.SecretString));
      const value = typeof parsed?.[field] === 'string' ? String(parsed[field]).trim() : '';
      if (value) return value;
    } catch {
      // Secrets may contain a plain key, matching the existing provider secret convention.
      if (!/^[\s]*[\[{]/.test(secret.SecretString)) return secret.SecretString.trim() || null;
    }
  } catch {
    throw new WebsiteHealthProviderError(`${service}_credentials`, `The ${service === 'pagespeed' ? 'PageSpeed' : 'CrUX'} credentials could not be loaded.`);
  }
  throw new WebsiteHealthProviderError(`${service}_credentials`, `The ${service === 'pagespeed' ? 'PageSpeed' : 'CrUX'} credentials are invalid.`);
}

function publicUrl(value: unknown): string | undefined {
  const parsed = onboardingInputSchema.shape.website.safeParse(value);
  if (!parsed.success) return undefined;
  const url = new URL(parsed.data);
  url.hash = '';
  return url.href;
}

interface MetricSpec {
  id: string;
  title: string;
  unit: 'ms' | 'unitless';
  good: number;
  poor: number;
}
const LAB_METRICS: MetricSpec[] = [
  { id: 'largest-contentful-paint', title: 'Largest Contentful Paint (LCP)', unit: 'ms', good: 2500, poor: 4000 },
  { id: 'first-contentful-paint', title: 'First Contentful Paint (FCP)', unit: 'ms', good: 1800, poor: 3000 },
  { id: 'cumulative-layout-shift', title: 'Cumulative Layout Shift (CLS)', unit: 'unitless', good: 0.1, poor: 0.25 },
  { id: 'total-blocking-time', title: 'Total Blocking Time (TBT)', unit: 'ms', good: 200, poor: 600 },
  { id: 'speed-index', title: 'Speed Index', unit: 'ms', good: 3400, poor: 5800 },
];
const FIELD_METRICS: MetricSpec[] = [
  { id: 'largest_contentful_paint', title: 'Largest Contentful Paint (LCP)', unit: 'ms', good: 2500, poor: 4000 },
  { id: 'interaction_to_next_paint', title: 'Interaction to Next Paint (INP)', unit: 'ms', good: 200, poor: 500 },
  { id: 'cumulative_layout_shift', title: 'Cumulative Layout Shift (CLS)', unit: 'unitless', good: 0.1, poor: 0.25 },
  { id: 'first_contentful_paint', title: 'First Contentful Paint (FCP)', unit: 'ms', good: 1800, poor: 3000 },
  { id: 'experimental_time_to_first_byte', title: 'Time to First Byte (TTFB)', unit: 'ms', good: 800, poor: 1800 },
];
function rating(value: number | null, spec: MetricSpec): WebsiteHealthRating {
  return value === null ? 'unknown' : value <= spec.good ? 'good' : value <= spec.poor ? 'needs-improvement' : 'poor';
}
function metric(spec: MetricSpec, value: number | undefined, display?: unknown, auditScore?: unknown): WebsiteHealthMetric {
  const normalized = value ?? null;
  const normalizedScore = score(auditScore);
  return {
    id: spec.id, title: spec.title, value: normalized, unit: spec.unit,
    displayValue: normalized === null ? 'Unavailable' : text(display, 200) || (spec.unit === 'ms' ? `${Math.round(normalized).toLocaleString('en-US')} ms` : String(normalized)),
    rating: normalized === null ? 'unknown' : normalizedScore !== undefined
      ? normalizedScore >= 0.9 ? 'good' : normalizedScore >= 0.5 ? 'needs-improvement' : 'poor'
      : rating(normalized, spec),
  };
}

function resourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function resources(details: unknown): { values: string[]; truncated: boolean } {
  const result = new Set<string>();
  let inspected = 0, truncated = false;
  const add = (value: string) => {
    if (result.has(value)) return;
    if (result.size >= 10 || value.length > 1000) { truncated = true; return; }
    result.add(value);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || inspected++ > 250) { if (value && typeof value === 'object') truncated = true; return; }
    if (Array.isArray(value)) {
      if (value.length > 50) truncated = true;
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    const item = object(value);
    if (!item) return;
    const url = resourceUrl(item.url);
    if (url) add(url);
    else if (typeof item.url === 'string' && item.url.length > 2048) truncated = true;
    const selector = text(item.selector, 1000).trim();
    if (typeof item.selector === 'string' && item.selector.length > 1000) truncated = true;
    if (selector) add(selector);
    if (Object.keys(item).length > 30) truncated = true;
    for (const [key, nested] of Object.entries(item).slice(0, 30)) {
      if (key !== 'url' && key !== 'selector') visit(nested, depth + 1);
    }
  };
  visit(details, 0);
  return { values: [...result], truncated };
}
function savings(audit: JsonObject): Pick<WebsiteHealthIssue, 'savingsMs' | 'savingsBytes'> {
  const details = object(audit.details);
  const metricSavings = object(audit.metricSavings);
  const times = [finite(details?.overallSavingsMs), ...['FCP', 'LCP', 'TBT', 'INP'].map((key) => finite(metricSavings?.[key]))]
    .filter((value): value is number => value !== undefined && value > 0);
  const overallBytes = finite(details?.overallSavingsBytes);
  // Sum wastedBytes only for top-level resource rows; nested subitems can duplicate them.
  const itemBytes = Array.isArray(details?.items) ? details.items.reduce<number>((total, item) => total + (finite(object(item)?.wastedBytes) ?? 0), 0) : 0;
  const bytes = overallBytes ?? itemBytes;
  return { ...(times.length ? { savingsMs: Math.round(Math.max(...times)) } : {}), ...(bytes > 0 ? { savingsBytes: Math.round(bytes) } : {}) };
}
function issues(audits: JsonObject, categories: JsonObject): { values: WebsiteHealthIssue[]; truncated: boolean } {
  const byAudit = new Map<string, WebsiteHealthCategory>();
  for (const category of CATEGORIES) {
    const refs = object(categories[category])?.auditRefs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      const id = object(ref)?.id;
      if (typeof id === 'string' && !byAudit.has(id)) byAudit.set(id, category);
    }
  }
  const measurementIds = new Set(LAB_METRICS.map((spec) => spec.id));
  const result: WebsiteHealthIssue[] = [];
  let truncated = false;
  for (const [id, category] of byAudit) {
    const audit = object(audits[id]);
    if (!audit || measurementIds.has(id)) continue;
    const auditScore = score(audit.score);
    if (auditScore === undefined || auditScore >= 1 || !['binary', 'numeric', 'metricSavings'].includes(String(audit.scoreDisplayMode))) continue;
    const title = text(audit.title, 300).trim();
    const descriptionParts = [text(audit.description, 2001), text(audit.explanation, 2001)].filter(Boolean).join('\n\n');
    const description = descriptionParts.slice(0, 2000);
    if (!title || !description) continue;
    const estimates = savings(audit);
    const priority = (estimates.savingsMs ?? 0) >= 500 || (estimates.savingsBytes ?? 0) >= 100_000 || auditScore < 0.5
      ? 'high' : auditScore < 0.9 ? 'medium' : 'low';
    const affected = resources(audit.details);
    if (descriptionParts.length > 2000 || affected.truncated || (typeof audit.title === 'string' && audit.title.length > 300) || id.length > 150) truncated = true;
    result.push({ id: text(id, 150), category, title, description, priority, ...estimates, resources: affected.values });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  result.sort((a, b) => rank[a.priority] - rank[b.priority] || (b.savingsMs ?? 0) - (a.savingsMs ?? 0)
    || (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0) || a.id.localeCompare(b.id));
  const values: WebsiteHealthIssue[] = [];
  let bytes = 2;
  for (const issue of result) {
    const size = Buffer.byteLength(JSON.stringify(issue), 'utf8') + 1;
    if (values.length >= MAX_ISSUES || bytes + size > MAX_ISSUE_BYTES) { truncated = true; break; }
    values.push(issue);
    bytes += size;
  }
  return { values, truncated };
}

function labResult(raw: unknown, url: string, device: WebsiteHealthDevice, now: Date): WebsiteHealthLabResult {
  const lighthouse = object(object(raw)?.lighthouseResult);
  if (object(lighthouse?.runtimeError) && Object.keys(object(lighthouse?.runtimeError)!).length) {
    throw new WebsiteHealthProviderError('pagespeed_runtime_error', 'PageSpeed could not complete the page audit. Check that the page is publicly accessible and try again.', true);
  }
  const audits = object(lighthouse?.audits);
  const categories = object(lighthouse?.categories);
  const finalUrl = publicUrl(lighthouse?.finalUrl);
  if (!lighthouse || !audits || !Object.keys(audits).length || !categories || !finalUrl
      || !CATEGORIES.some((category) => score(object(categories[category])?.score) !== undefined)) {
    throw new WebsiteHealthProviderError('pagespeed_invalid_response', 'PageSpeed returned an incomplete audit result. Please try again.', true);
  }
  const scores = Object.fromEntries(CATEGORIES.map((category) => {
    const value = score(object(categories[category])?.score);
    return [category, value === undefined ? null : Math.round(value * 100)];
  })) as WebsiteHealthLabResult['scores'];
  const fetchTime = typeof lighthouse.fetchTime === 'string' ? Date.parse(lighthouse.fetchTime) : NaN;
  const warnings = Array.isArray(lighthouse.runWarnings) ? lighthouse.runWarnings.filter((value): value is string => typeof value === 'string').slice(0, 20).map((value) => text(value, 500)) : [];
  if (CATEGORIES.some((category) => scores[category] === null)) warnings.push('Some category scores were not available in this audit.');
  const findings = issues(audits, categories);
  if (findings.truncated) warnings.push('Showing the highest-priority findings; the full Google report may contain additional details.');
  return {
    strategy: device, requestedUrl: url, finalUrl,
    fetchedAt: Number.isFinite(fetchTime) ? new Date(fetchTime).toISOString() : now.toISOString(),
    lighthouseVersion: text(lighthouse.lighthouseVersion, 50), scores,
    metrics: LAB_METRICS.map((spec) => { const audit = object(audits[spec.id]); return metric(spec, finite(audit?.numericValue), audit?.displayValue, audit?.score); }),
    issues: findings.values, warnings,
  };
}
function collectionDate(value: unknown): string | undefined {
  const date = object(value);
  const year = finite(date?.year), month = finite(date?.month), day = finite(date?.day);
  if (year === undefined || month === undefined || day === undefined || ![year, month, day].every(Number.isInteger)) return undefined;
  const result = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(result) ? result : undefined;
}
function fieldResult(raw: unknown, url: string, scope: 'url' | 'origin'): WebsiteHealthFieldResult {
  const record = object(object(raw)?.record);
  const sourceMetrics = object(record?.metrics);
  if (!record || !sourceMetrics) throw new WebsiteHealthProviderError('crux_invalid_response', 'CrUX returned an incomplete real-user data result.', true);
  const metrics = FIELD_METRICS.map((spec) => {
    const p75 = object(object(sourceMetrics[spec.id])?.percentiles)?.p75;
    const number = typeof p75 === 'string' && /^\d+(?:\.\d+)?$/.test(p75) ? finite(Number(p75)) : finite(p75);
    return metric(spec, number);
  });
  if (!metrics.some((value) => value.value !== null)) throw new WebsiteHealthProviderError('crux_invalid_response', 'CrUX returned no usable real-user measurements.', true);
  const period = object(record.collectionPeriod);
  const start = collectionDate(period?.firstDate), end = collectionDate(period?.lastDate);
  return { status: 'available', scope, url, metrics, ...(start && end && start <= end ? { collectionPeriod: { start, end } } : {}) };
}

export class GoogleWebsiteHealthProvider {
  constructor(private readonly options: GoogleWebsiteHealthOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 120_000)) {
      throw new Error('Website health request timeout must be between 1 and 120000 milliseconds.');
    }
  }
  private async key(service: GoogleService): Promise<string | null> {
    try { return (await (this.options.resolveKey ?? googleApiKey)(service))?.trim() || null; }
    catch (error) {
      if (error instanceof WebsiteHealthProviderError) throw error;
      throw new WebsiteHealthProviderError(`${service}_credentials`, `The ${service === 'pagespeed' ? 'PageSpeed' : 'CrUX'} credentials could not be loaded.`);
    }
  }
  private async request(service: GoogleService, endpoint: string, init: RequestInit, allowNotFound = false): Promise<unknown | undefined> {
    const label = service === 'pagespeed' ? 'PageSpeed' : 'CrUX';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? (service === 'pagespeed' ? 120_000 : 15_000));
    try {
      const response = await (this.options.fetch ?? fetch)(endpoint, { ...init, signal: controller.signal });
      if (allowNotFound && response.status === 404) return undefined;
      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        const message = response.status === 429 ? `${label} request limit reached. Please try again later.`
          : response.status === 401 || response.status === 403 ? `${label} credentials were rejected. Ask your administrator to check the API configuration.`
            : retryable ? `${label} is temporarily unavailable. Please try again later.` : `${label} could not audit this page. Check the URL and API configuration.`;
        throw new WebsiteHealthProviderError(`${service}_http_${response.status}`, message, retryable);
      }
      try { return await response.json(); }
      catch { throw new WebsiteHealthProviderError(`${service}_invalid_json`, `${label} returned an invalid response. Please try again.`, true); }
    } catch (error) {
      if (error instanceof WebsiteHealthProviderError) throw error;
      throw new WebsiteHealthProviderError(`${service}_${controller.signal.aborted ? 'timeout' : 'network'}`, `${label} request ${controller.signal.aborted ? 'timed out' : 'could not be completed'}. Please try again.`, true);
    } finally { clearTimeout(timer); }
  }
  private async crux(url: string, device: WebsiteHealthDevice): Promise<{ field: WebsiteHealthFieldResult; raw: unknown }> {
    try {
      const key = await this.key('crux');
      if (!key) return { field: { status: 'not_configured', metrics: [], message: 'Real-user data is not configured. An administrator can enable the Google CrUX API.' }, raw: null };
      const endpoint = new URL('https://chromeuxreport.googleapis.com/v1/records:queryRecord');
      endpoint.searchParams.set('key', key);
      const query = (scope: 'url' | 'origin', target: string) => this.request('crux', endpoint.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [scope]: target, formFactor: device === 'mobile' ? 'PHONE' : 'DESKTOP', metrics: FIELD_METRICS.map((spec) => spec.id) }),
      }, true);
      const pageRaw = await query('url', url);
      if (pageRaw !== undefined) return { field: fieldResult(pageRaw, url, 'url'), raw: pageRaw };
      const origin = new URL(url).origin;
      const originRaw = await query('origin', origin);
      if (originRaw !== undefined) return { field: fieldResult(originRaw, origin, 'origin'), raw: originRaw };
      return { field: { status: 'unavailable', metrics: [], message: 'Google has insufficient eligible real-user data for this page and origin on this device.' }, raw: null };
    } catch (error) {
      return { field: { status: 'error', metrics: [], message: error instanceof WebsiteHealthProviderError ? error.message : 'Real-user data could not be loaded. Please try again later.' }, raw: null };
    }
  }
  async audit(url: string, device: WebsiteHealthDevice): Promise<{ lab: WebsiteHealthLabResult; field: WebsiteHealthFieldResult; raw: unknown }> {
    const normalized = publicUrl(url);
    if (!normalized || !['mobile', 'desktop'].includes(device)) throw new WebsiteHealthProviderError('invalid_audit_input', 'Use a public website URL and a mobile or desktop device.');
    const key = await this.key('pagespeed');
    if (!key) throw new WebsiteHealthProviderError('pagespeed_not_configured', 'PageSpeed is not configured. Ask your administrator to configure the Google PageSpeed API.');
    const endpoint = new URL('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', normalized);
    endpoint.searchParams.set('strategy', device);
    endpoint.searchParams.set('locale', 'en');
    endpoint.searchParams.set('key', key);
    for (const category of CATEGORY_PARAMETERS) endpoint.searchParams.append('category', category);
    const pagespeedRaw = await this.request('pagespeed', endpoint.href, { method: 'GET' });
    const lab = labResult(pagespeedRaw, normalized, device, this.options.now?.() ?? new Date());
    // Query the navigable final page, which matters for CrUX URL and origin coverage after redirects.
    const { field, raw: cruxRaw } = await this.crux(lab.finalUrl, device);
    return { lab, field, raw: { pagespeed: pagespeedRaw, crux: cruxRaw } };
  }
}
