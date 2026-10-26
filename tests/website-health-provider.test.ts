import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GoogleWebsiteHealthProvider, WebsiteHealthProviderError, websiteHealthAvailability } from '../apps/scanner/src/website-health-provider.js';

const PAGE = 'https://example.com/landing';
const NOW = '2026-10-26T09:00:00.000Z';
function lighthouse() {
  return {
    lighthouseResult: {
      finalUrl: PAGE,
      requestedUrl: PAGE,
      fetchTime: NOW,
      lighthouseVersion: '13.5.0',
      runWarnings: [],
      categories: {
        performance: { score: 0.61, auditRefs: [
          { id: 'largest-contentful-paint', weight: 25 }, { id: 'modern-image-formats', weight: 0 },
          { id: 'render-blocking-insight', weight: 0 }, { id: 'passed', weight: 0 }, { id: 'manual', weight: 0 },
          { id: 'informative', weight: 0 }, { id: 'notApplicable', weight: 0 }, { id: 'error', weight: 0 },
        ] },
        accessibility: { score: 0.9, auditRefs: [{ id: 'image-alt', weight: 10 }] },
        'best-practices': { score: null, auditRefs: [] },
        seo: { score: 1, auditRefs: [] },
      },
      audits: {
        'largest-contentful-paint': { title: 'LCP', description: 'A measurement.', score: 0.2, scoreDisplayMode: 'numeric', numericValue: 4812, displayValue: '4.8 s' },
        'cumulative-layout-shift': { score: 1, numericValue: 0, displayValue: '0' },
        'modern-image-formats': {
          title: 'Use modern images', description: 'Use [efficient formats](https://web.dev/articles/uses-webp-images).', score: 0.5, scoreDisplayMode: 'numeric',
          details: { type: 'opportunity', overallSavingsMs: 400, overallSavingsBytes: 12000, items: [{ url: 'https://example.com/photo.jpg', wastedBytes: 12000 }] },
        },
        'render-blocking-insight': {
          title: 'Render blocking requests', description: 'Defer nonessential scripts.', score: 0.5, scoreDisplayMode: 'metricSavings', metricSavings: { FCP: 700, LCP: 1000, TBT: 200 },
          details: { items: [{ url: 'https://example.com/style.css', node: { selector: 'head > link' } }] },
        },
        'image-alt': { title: 'Images lack alternative text', description: 'Add descriptive alt text.', score: 0, scoreDisplayMode: 'binary', details: { items: [{ node: { selector: 'main > img' } }] } },
        passed: { title: 'Passed', description: 'Not an issue', score: 1, scoreDisplayMode: 'binary' },
        ...Object.fromEntries(['manual', 'informative', 'notApplicable', 'error'].map((mode) => [mode, { title: mode, description: 'Not actionable', score: 0, scoreDisplayMode: mode }])),
      },
    },
  };
}
function crux(url = PAGE) {
  return { record: {
    key: { url, formFactor: 'PHONE' },
    metrics: {
      largest_contentful_paint: { percentiles: { p75: 2500 } },
      interaction_to_next_paint: { percentiles: { p75: 510 } },
      cumulative_layout_shift: { percentiles: { p75: '0.10' } },
    },
    collectionPeriod: { firstDate: { year: 2026, month: 9, day: 28 }, lastDate: { year: 2026, month: 10, day: 25 } },
  } };
}
function provider(fetcher: typeof fetch, options: ConstructorParameters<typeof GoogleWebsiteHealthProvider>[0] = {}) {
  return new GoogleWebsiteHealthProvider({ fetch: fetcher, now: () => new Date(NOW), resolveKey: async () => 'server-secret', ...options });
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Google Website Health provider', () => {
  it('requests all four categories for each device and queries CrUX separately', async () => {
    for (const [device, formFactor] of [['mobile', 'PHONE'], ['desktop', 'DESKTOP']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(Response.json(crux()));
      const result = await provider(fetcher).audit(PAGE, device);
      const psi = new URL(String(fetcher.mock.calls[0][0]));
      expect(psi.origin + psi.pathname).toBe('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
      expect(psi.searchParams.get('url')).toBe(PAGE);
      expect(psi.searchParams.get('strategy')).toBe(device);
      expect(psi.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']);
      expect(psi.searchParams.get('key')).toBe('server-secret');
      const [cruxEndpoint, cruxInit] = fetcher.mock.calls[1];
      expect(new URL(String(cruxEndpoint)).pathname).toBe('/v1/records:queryRecord');
      expect(cruxInit?.method).toBe('POST');
      expect(JSON.parse(String(cruxInit?.body))).toMatchObject({ url: PAGE, formFactor, metrics: expect.arrayContaining(['interaction_to_next_paint']) });
      expect(result.lab.strategy).toBe(device);
      expect(result.lab.scores).toEqual({ performance: 61, accessibility: 90, 'best-practices': null, seo: 100 });
      expect(result.field).toMatchObject({ status: 'available', scope: 'url', url: PAGE, collectionPeriod: { start: '2026-09-28', end: '2026-10-25' } });
      expect(result.raw).toEqual({ pagespeed: lighthouse(), crux: crux() });
    }
  });
  it('preserves missing measurements and real zero values, with device-specific lab and p75 field ratings', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(Response.json(crux()));
    const { lab, field } = await provider(fetcher).audit(PAGE, 'mobile');
    expect(lab.metrics.find((value) => value.id === 'largest-contentful-paint')).toMatchObject({ value: 4812, displayValue: '4.8 s', rating: 'poor' });
    expect(lab.metrics.find((value) => value.id === 'cumulative-layout-shift')).toMatchObject({ value: 0, rating: 'good' });
    expect(lab.metrics.find((value) => value.id === 'total-blocking-time')).toMatchObject({ value: null, displayValue: 'Unavailable', rating: 'unknown' });
    expect(field.metrics.find((value) => value.id === 'cumulative_layout_shift')).toMatchObject({ value: 0.1, unit: 'unitless', rating: 'good' });
    expect(field.metrics.find((value) => value.id === 'interaction_to_next_paint')).toMatchObject({ value: 510, rating: 'poor' });
    expect(field.metrics.find((value) => value.id === 'first_contentful_paint')).toMatchObject({ value: null, rating: 'unknown' });
  });
  it('extracts actionable failures, resources and modern metric savings in stable priority order', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse()));
    const { lab } = await provider(fetcher, { resolveKey: async (service) => service === 'pagespeed' ? 'key' : null }).audit(PAGE, 'mobile');
    expect(lab.issues.map((issue) => issue.id)).toEqual(['render-blocking-insight', 'image-alt', 'modern-image-formats']);
    expect(lab.issues[0]).toMatchObject({ category: 'performance', priority: 'high', savingsMs: 1000, resources: ['https://example.com/style.css', 'head > link'] });
    expect(lab.issues[1]).toMatchObject({ category: 'accessibility', priority: 'high', resources: ['main > img'] });
    expect(lab.issues[2]).toMatchObject({ priority: 'medium', savingsMs: 400, savingsBytes: 12000, description: expect.stringContaining('[efficient formats]') });
  });
  it('bounds untrusted text, resource lists and estimates without stringifying upstream objects', async () => {
    const raw = lighthouse();
    raw.lighthouseResult.audits['modern-image-formats'] = {
      ...raw.lighthouseResult.audits['modern-image-formats'],
      description: 'a'.repeat(10000),
      details: { type: 'opportunity', overallSavingsMs: 10, overallSavingsBytes: 30, items: [
        { url: 'javascript:alert(1)', wastedBytes: 5 }, { url: 'https://user:pass@example.com/private', wastedBytes: 5 },
        ...Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/asset-${i}.jpg`, wastedBytes: 1 })),
      ] },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(raw));
    const { lab } = await provider(fetcher, { resolveKey: async (service) => service === 'pagespeed' ? 'key' : null }).audit(PAGE, 'desktop');
    const issue = lab.issues.find((value) => value.id === 'modern-image-formats')!;
    expect(issue.description.length).toBeLessThanOrEqual(2000);
    expect(issue.resources).toHaveLength(10);
    expect(issue.resources.every((value) => typeof value === 'string' && value.startsWith('https://example.com/asset-'))).toBe(true);
    expect(issue.savingsBytes).toBe(30);
    expect(lab.warnings).toContain('Showing the highest-priority findings; the full Google report may contain additional details.');
  });
  it('caps UTF-8 findings size after sorting, retains the most useful fixes and warns only on truncation', async () => {
    const base = lighthouse();
    const largeAudits = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`issue-${i.toString().padStart(3, '0')}`, {
      title: `Issue ${i}`, description: 'א'.repeat(2000), score: 0.5, scoreDisplayMode: 'metricSavings',
      metricSavings: { LCP: 1000 + i },
      details: { items: Array.from({ length: 10 }, (_, j) => ({ node: { selector: `#item-${j}-${'א'.repeat(970)}` } })) },
    }]));
    const heavy = { lighthouseResult: { ...base.lighthouseResult, audits: largeAudits, categories: {
      ...base.lighthouseResult.categories, performance: { score: 0.5, auditRefs: Object.keys(largeAudits).map(id => ({ id, weight: 0 })) },
    } } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(heavy));
    const { lab, raw } = await provider(fetcher, { resolveKey: async (service) => service === 'pagespeed' ? 'key' : null }).audit(PAGE, 'mobile');
    expect(Buffer.byteLength(JSON.stringify(lab.issues), 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(lab.issues.length).toBeLessThanOrEqual(60);
    expect(lab.issues[0].id).toBe('issue-099');
    expect(lab.issues.at(-1)!.savingsMs).toBeLessThan(lab.issues[0].savingsMs!);
    expect(lab.warnings).toContain('Showing the highest-priority findings; the full Google report may contain additional details.');
    expect(raw).toMatchObject({ pagespeed: heavy });
    const normalFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(base));
    const normal = await provider(normalFetch, { resolveKey: async (service) => service === 'pagespeed' ? 'key' : null }).audit(PAGE, 'mobile');
    expect(normal.lab.warnings).not.toContain('Showing the highest-priority findings; the full Google report may contain additional details.');
  });
  it('falls back from the final redirected page to origin only when CrUX returns 404', async () => {
    const raw = lighthouse();
    raw.lighthouseResult.finalUrl = 'https://www.example.com/final';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(raw)).mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json(crux()));
    const result = await provider(fetcher).audit(PAGE, 'desktop');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ url: 'https://www.example.com/final', formFactor: 'DESKTOP' });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({ origin: 'https://www.example.com', formFactor: 'DESKTOP' });
    expect(result.field).toMatchObject({ status: 'available', scope: 'origin', url: 'https://www.example.com' });
  });
  it('distinguishes no traffic from missing configuration and upstream errors', async () => {
    const noData = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValue(new Response('', { status: 404 }));
    expect((await provider(noData).audit(PAGE, 'mobile')).field).toMatchObject({ status: 'unavailable', metrics: [] });
    expect(noData).toHaveBeenCalledTimes(3);
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse()));
    expect((await provider(missing, { resolveKey: async (service) => service === 'pagespeed' ? 'key' : null }).audit(PAGE, 'mobile')).field.status).toBe('not_configured');
    expect(missing).toHaveBeenCalledOnce();
    const transient = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(new Response('server-secret', { status: 503 }));
    const result = await provider(transient).audit(PAGE, 'mobile');
    expect(result.field).toMatchObject({ status: 'error', message: expect.stringContaining('temporarily unavailable') });
    expect(result.field.message).not.toContain('server-secret');
    expect(transient).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429, 500])('does not hide CrUX HTTP %i behind no-traffic or origin fallback', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(new Response('private upstream details', { status }));
    expect((await provider(fetcher).audit(PAGE, 'mobile')).field.status).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { record: { metrics: {} } }, { record: { metrics: { largest_contentful_paint: { percentiles: { p75: null } } } } }])('does not call malformed successful CrUX data available', async (data) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(Response.json(data));
    expect((await provider(fetcher).audit(PAGE, 'mobile')).field).toMatchObject({ status: 'error', metrics: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps partial CrUX coverage available without manufacturing missing or malformed metrics', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse())).mockResolvedValueOnce(Response.json({ record: {
      key: { url: PAGE, formFactor: 'PHONE' },
      metrics: {
        largest_contentful_paint: { percentiles: { p75: 3000 } },
        interaction_to_next_paint: { percentiles: { p75: '' } },
        cumulative_layout_shift: { percentiles: { p75: '0' } },
        first_contentful_paint: { percentiles: { p75: '1800 ms' } },
      },
      collectionPeriod: { firstDate: { year: 2026, month: 2, day: 30 }, lastDate: { year: 2026, month: 3, day: 20 } },
    } }));
    const { field } = await provider(fetcher).audit(PAGE, 'mobile');
    expect(field.status).toBe('available');
    expect(field).not.toHaveProperty('collectionPeriod');
    expect(field.metrics.map(({ id, value, rating }) => ({ id, value, rating }))).toEqual([
      { id: 'largest_contentful_paint', value: 3000, rating: 'needs-improvement' },
      { id: 'interaction_to_next_paint', value: null, rating: 'unknown' },
      { id: 'cumulative_layout_shift', value: 0, rating: 'good' },
      { id: 'first_contentful_paint', value: null, rating: 'unknown' },
      { id: 'experimental_time_to_first_byte', value: null, rating: 'unknown' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[429, true], [503, true], [403, false], [400, false]])('sanitizes PageSpeed HTTP %i and classifies retryability', async (status, retryable) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('https://secret.example/?key=server-secret', { status }));
    await expect(provider(fetcher).audit(PAGE, 'mobile')).rejects.toMatchObject({ code: `pagespeed_http_${status}`, retryable, message: expect.not.stringContaining('server-secret') });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('discards Lighthouse runtime errors without exposing native messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ lighthouseResult: { runtimeError: { code: 'NO_FCP', message: 'private server-secret' } } }));
    await expect(provider(fetcher).audit(PAGE, 'mobile')).rejects.toMatchObject({ code: 'pagespeed_runtime_error', message: expect.not.stringContaining('server-secret') });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { lighthouseResult: {} }, { lighthouseResult: { categories: { performance: { score: null } }, audits: { test: {} }, finalUrl: PAGE } }])('rejects incomplete successful PageSpeed responses', async (data) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(data));
    await expect(provider(fetcher).audit(PAGE, 'mobile')).rejects.toMatchObject({ code: 'pagespeed_invalid_response' });
  });
  it('bounds timeouts and sanitizes network and credential failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('https://google.example?key=server-secret')), { once: true });
    }));
    await expect(provider(fetcher, { timeoutMs: 5 }).audit(PAGE, 'mobile')).rejects.toMatchObject({ code: 'pagespeed_timeout', retryable: true, message: expect.not.stringContaining('server-secret') });
    expect(() => new GoogleWebsiteHealthProvider({ timeoutMs: 120001 })).toThrow('120000');
    const credentialFailure = provider(fetcher, { resolveKey: async () => { throw new Error('aws private server-secret'); } });
    await expect(credentialFailure.audit(PAGE, 'mobile')).rejects.toMatchObject({ code: 'pagespeed_credentials', message: expect.not.stringContaining('server-secret') });
  });
  it('rejects private, credentialed and custom-port audit URLs before requesting Google', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://192.168.1.2/', 'https://user:pass@example.com/', 'https://example.com:8443/', 'file:///etc/passwd', 'https://site.local/']) {
      await expect(provider(fetcher).audit(url, 'mobile')).rejects.toBeInstanceOf(WebsiteHealthProviderError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires PageSpeed configuration and reports independently configured services', async () => {
    vi.stubEnv('GOOGLE_PAGESPEED_API_KEY', ''); vi.stubEnv('GOOGLE_PAGESPEED_SECRET_ARN', '');
    vi.stubEnv('GOOGLE_CRUX_API_KEY', ''); vi.stubEnv('GOOGLE_CRUX_SECRET_ARN', '');
    expect(websiteHealthAvailability()).toEqual({ auditingAvailable: false, cruxAvailable: false });
    vi.stubEnv('GOOGLE_PAGESPEED_SECRET_ARN', 'arn:aws:secretsmanager:region:account:secret:key');
    expect(websiteHealthAvailability()).toEqual({ auditingAvailable: true, cruxAvailable: false });
    vi.stubEnv('GOOGLE_CRUX_API_KEY', 'crux-key');
    expect(websiteHealthAvailability()).toEqual({ auditingAvailable: true, cruxAvailable: true });
    const fetcher = vi.fn<typeof fetch>();
    await expect(provider(fetcher, { resolveKey: async () => null }).audit(PAGE, 'mobile')).rejects.toMatchObject({ code: 'pagespeed_not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['plain-key', JSON.stringify({ GOOGLE_PAGESPEED_API_KEY: 'structured-key' })])('resolves server-side PageSpeed secrets without requiring a browser credential', async (secret) => {
    vi.stubEnv('GOOGLE_PAGESPEED_API_KEY', '');
    vi.stubEnv('GOOGLE_PAGESPEED_SECRET_ARN', 'arn:aws:secretsmanager:region:account:secret:pagespeed');
    vi.stubEnv('GOOGLE_CRUX_API_KEY', ''); vi.stubEnv('GOOGLE_CRUX_SECRET_ARN', '');
    const send = vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: secret } as never);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse()));
    const { field } = await new GoogleWebsiteHealthProvider({ fetch: fetcher }).audit(PAGE, 'mobile');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toMatchObject({ SecretId: 'arn:aws:secretsmanager:region:account:secret:pagespeed' });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('key')).toBe(secret === 'plain-key' ? 'plain-key' : 'structured-key');
    expect(field.status).toBe('not_configured');
  });
  it('does not treat an invalid configured CrUX secret as missing traffic or echo secret failures', async () => {
    vi.stubEnv('GOOGLE_PAGESPEED_API_KEY', 'server-pagespeed');
    vi.stubEnv('GOOGLE_CRUX_API_KEY', ''); vi.stubEnv('GOOGLE_CRUX_SECRET_ARN', 'arn:aws:secretsmanager:region:account:secret:crux');
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: JSON.stringify({ wrong: 'never-echo-me' }) } as never);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(lighthouse()));
    const { field } = await new GoogleWebsiteHealthProvider({ fetch: fetcher }).audit(PAGE, 'mobile');
    expect(field).toMatchObject({ status: 'error', message: 'The CrUX credentials are invalid.' });
    expect(field.message).not.toContain('never-echo-me');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
