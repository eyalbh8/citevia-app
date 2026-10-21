import { z } from 'zod';
import {
  TRAFFIC_PROVIDERS,
  trafficProvider,
  trafficBrowser,
  trafficDevice,
  type Project,
  type TrafficProvider,
  type TrafficPeriod,
} from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
import { monitoringPeriod } from './monitoring.js';
import { trafficTracker } from './traffic-tracker.js';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
const fail = (message: string, status = 400): never => {
  throw new AccessError(status, 'TRAFFIC_REQUEST', message);
};
const eventSchema = z.object({
  type: z.enum(['pageview', 'installation']).optional().default('pageview'),
  trackerVersion: z.string().max(32).optional().default('citevia-v1'),
  id: z.string().uuid(),
  projectId: z.string().min(1).max(120),
  url: z.string().url().max(4096),
  referrer: z.string().max(2048).optional().default(''),
  utmSource: z.string().max(100).optional(),
  testId: z.string().uuid().nullable().optional(),
});
function siteUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
export async function publicTrafficRoute(
  runtime: Runtime,
  request: Request,
  now: Date,
  country: () => string | null = () => null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/v1/traffic/tracker.js' && request.method === 'GET')
    return new Response(trafficTracker, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public,max-age=60',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  if (path !== '/v1/traffic/collect') return null;
  if (request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405);
  try {
    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Event is too large' }, 413);
    const parsed = eventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return json({ error: 'Invalid traffic event' }, 400);
    const payload = parsed.data;
    const project = await runtime.repository.getProject(payload.projectId);
    if (!project) return json({ error: 'Unknown website' }, 404);
    const url = siteUrl(payload.url),
      origin = siteUrl(request.headers.get('origin') || '');
    if (!url || !origin || origin.origin !== url.origin)
      return json({ error: 'Website origin does not match this account' }, 403);
    // UA and receipt time come from the request; never accept supplied provider/browser/country fields.
    const ua = (request.headers.get('user-agent') || '').slice(0, 1024);
    if (
      /bot\b|crawler|spider|ChatGPT-User|Perplexity-User|Claude-User/i.test(ua)
    )
      return new Response(null, { status: 204 });
    const windowStart = new Date(
      Math.floor(now.getTime() / 60000) * 60000,
    ).toISOString();
    if (
      !(await runtime.repository.limitMcpRequests(
        `traffic:${project.id}`,
        windowStart,
        3000,
      ))
    )
      return json({ error: 'Too many events' }, 429);
    // A published script can run on any website. Installation receipts never inflate AI referrals.
    await runtime.repository.recordTrafficInstallation({
      id: payload.id,
      projectId: project.id,
      origin: url.origin,
      url: `${url.origin}${url.pathname}`,
      timestamp: now.toISOString(),
      trackerVersion: payload.trackerVersion,
      testId: payload.testId || null,
    });
    if (payload.type === 'installation' || payload.testId)
      return new Response(null, { status: 204 });
    const referrer = siteUrl(payload.referrer);
    const provider = trafficProvider(referrer?.href || null, payload.utmSource);
    if (!provider) return new Response(null, { status: 204 });
    await runtime.repository.collectTrafficEvent({
      id: payload.id,
      projectId: project.id,
      timestamp: now.toISOString(),
      url: `${url.origin}${url.pathname}`,
      path: url.pathname,
      referrer: referrer?.origin || null,
      provider,
      userAgent: ua,
      browser: trafficBrowser(ua),
      device: trafficDevice(ua),
      country: country(),
      testId: payload.testId || null,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof SyntaxError)
      return json({ error: 'Invalid traffic event' }, 400);
    throw error;
  }
}
export async function trafficRoute(
  runtime: Runtime,
  project: Project,
  tail: string,
  request: Request,
  now: Date,
): Promise<Response | null> {
  if (!['traffic', 'traffic/status'].includes(tail)) return null;
  if (request.method !== 'GET')
    return json({ error: 'Method not allowed' }, 405);
  const query = new URL(request.url).searchParams;
  if (tail === 'traffic/status') {
    const testId = query.get('testId') || undefined;
    if (testId && !z.string().uuid().safeParse(testId).success)
      fail('Invalid connection test ID.');
    return json(await runtime.repository.trafficStatus(project.id, testId));
  }
  const period = monitoringPeriod(query, now);
  const duration = Date.parse(period.end) - Date.parse(period.start) + 1;
  const previous: TrafficPeriod = {
    ...period,
    start: new Date(Date.parse(period.start) - duration).toISOString(),
    end: new Date(Date.parse(period.start) - 1).toISOString(),
  };
  const values = (name: string) => [
    ...new Set((query.get(name) || '').split(',').filter(Boolean)),
  ];
  const providers = values('providers');
  if (providers.some((p) => !TRAFFIC_PROVIDERS.includes(p as TrafficProvider)))
    fail('Choose a supported AI provider.');
  const countries = values('countries').map((c) => c.toUpperCase());
  if (countries.length > 250 || countries.some((c) => !/^[A-Z]{2}$/.test(c)))
    fail('Choose valid country codes.');
  const [aggregate, status] = await Promise.all([
    runtime.repository.aggregateTraffic(project.id, {
      period,
      previous,
      providers: providers as TrafficProvider[],
      countries,
    }),
    runtime.repository.trafficStatus(project.id),
  ]);
  return json({ ...aggregate, period, previousPeriod: previous, status });
}
