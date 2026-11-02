import { createHash } from 'node:crypto';
import { AccessError, type Repository } from '@citevia/storage';

export function positiveLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000)
    throw new Error(`${name} must be an integer between 1 and 100000.`);
  return value;
}

export function actorFingerprint(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 32);
}

export async function enforceApiLimit(repository: Pick<Repository, 'limitMcpRequests'>,
  subject: string, method: string, now: Date, projectId?: string): Promise<void> {
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const kind = read ? 'read' : 'write';
  const window = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();
  const limit = projectId
    ? positiveLimit(read ? 'API_ACCOUNT_READS_PER_MINUTE' : 'API_ACCOUNT_WRITES_PER_MINUTE', read ? 1200 : 240)
    : positiveLimit(read ? 'API_USER_READS_PER_MINUTE' : 'API_USER_WRITES_PER_MINUTE', read ? 600 : 120);
  const bucket = projectId ? `api:account:${actorFingerprint(projectId)}:${kind}` : `api:user:${actorFingerprint(subject)}:${kind}`;
  if (!await repository.limitMcpRequests(bucket, window, limit))
    throw new AccessError(429, 'RATE_LIMITED', 'Too many requests. Please retry in a minute.');
}

const auditSections = new Set(['settings', 'prompts', 'prompt-metrics', 'runs', 'responses', 'sources',
  'dashboard', 'competitors', 'onboarding', 'brandbook', 'agents', 'social',
  'geo-backlinks', 'website-health', 'blog-performance', 'monitoring', 'traffic']);

/** Do not record query strings, tokens, input bodies or arbitrary untrusted paths. */
export function auditRoute(path: string): string {
  if (path === '/health') return path;
  const project = path.match(/^\/v1\/projects\/[A-Za-z0-9_-]+(?:\/(.*))?$/);
  if (project) {
    const [section, ...resource] = (project[1] || '').split('/');
    const suffix = section ? '/' + (auditSections.has(section) ? section : ':resource') : '';
    return '/v1/projects/:projectId' + suffix + (resource.length ? '/:resource' : '');
  }
  if (/^\/v1\/(?:me|runtime|projects|onboarding\/accounts)$/.test(path)) return path;
  if (path.startsWith('/v1/admin/')) return '/v1/admin/:resource';
  if (path.startsWith('/oauth/')) return '/oauth/:operation';
  if (path.startsWith('/mcp')) return '/mcp/:resource';
  if (path.startsWith('/v1/mcp/')) return '/v1/mcp/:resource';
  if (path === '/v1/traffic/collect' || path === '/v1/traffic/tracker.js') return path;
  return '/other';
}

export function secureResponse(response: Response, request: Request): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (new URL(request.url).protocol === 'https:')
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (response.status === 429 && !response.headers.has('Retry-After')) response.headers.set('Retry-After', '60');
  return response;
}
