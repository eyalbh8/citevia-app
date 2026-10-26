import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import { z } from 'zod';
import { identifier, publicWebsiteHealthAudit, type Project, type WebsiteHealthJob, type WebsiteHealthPage } from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';

const fail = (status: number, code: string, message: string): never => { throw new AccessError(status, code, message); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicUrl = z.string().trim().max(2048).url().refine(raw => {
  try {
    const url = new URL(raw), hostname = url.hostname.replace(/\.$/, '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
      !isIP(hostname) && !hostname.startsWith('[') && Boolean(getDomain(hostname, { allowPrivateDomains: true })) &&
      !/(^|\.)(localhost|local|internal|home|arpa|onion|example|invalid|test)$/i.test(hostname);
  } catch { return false; }
}, 'Use a public HTTP(S) website URL without credentials, an IP address or a custom port.').transform(raw => {
  const url = new URL(raw);
  url.hash = '';
  url.hostname = url.hostname.replace(/\.$/, '');
  return url.toString();
});
const auditInput = z.object({ url: publicUrl }).strict();
function domains(project: Project) { return [...(project.brandbook?.domains || []), ...project.brand.domains]; }
function hostname(raw: string): string | null {
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); }
  catch { return null; }
}
function ownedUrl(project: Project, raw: string) {
  const target = hostname(raw);
  return target && domains(project).some(domain => {
    const parsed = publicUrl.safeParse(domain.includes('://') ? domain : `https://${domain}`);
    if (!parsed.success) return false;
    const owned = hostname(parsed.data);
    return owned && (target === owned || target.endsWith(`.${owned}`));
  });
}
function defaultUrl(project: Project): string | null {
  for (const domain of domains(project)) {
    const parsed = publicUrl.safeParse(domain.includes('://') ? domain : `https://${domain}`);
    if (parsed.success) return parsed.data;
  }
  return null;
}
function summaryAudit(job: WebsiteHealthJob) {
  const audit = publicWebsiteHealthAudit(job);
  const results = Object.fromEntries((['mobile', 'desktop'] as const).map(device => {
    const { field: _field, ...result } = audit.results[device];
    return [device, { ...result, ...(result.lab ? { lab: { ...result.lab, metrics: [], issues: [], warnings: [] } } : {}) }];
  })) as WebsiteHealthJob['results'];
  return { ...audit, summaryOnly: true, results };
}

export async function websiteHealthRoute(
  runtime: Runtime, project: Project, userId: string, tail: string, request: Request, now: Date,
  availability: { auditingAvailable: boolean; cruxAvailable: boolean },
  body: (request: Request) => Promise<unknown>,
): Promise<Response | null> {
  const collection = tail === 'website-health/audits', match = tail.match(/^website-health\/audits\/([^/]+)$/);
  if (!collection && !match) return null;
  const method = request.method;
  if (!['GET', 'HEAD'].includes(method) && (project.demo || project.role !== 'owner'))
    return fail(403, project.demo ? 'ACCOUNT_READ_ONLY' : 'FORBIDDEN', project.demo ? 'This account is read-only. Audits are unavailable.' : 'Project owner access is required.');
  const { repository, queue } = runtime;
  const enqueue = async (audit: WebsiteHealthJob) => {
    const active = ['queued', 'running'].includes(audit.status);
    // Replaying an accepted request also repairs an interrupted first queue send.
    if (active) await queue.send([{ kind: 'website-health', projectId: project.id, auditId: audit.id }]);
    return json({ audit: publicWebsiteHealthAudit(audit) }, active ? 202 : 200);
  };
  if (collection && method === 'GET') {
    const params = new URL(request.url).searchParams;
    const cursor = params.get('cursor') || '0', offset = Number(cursor), limit = Number(params.get('limit') || 10);
    if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(offset) || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return fail(400, 'INVALID_PAGE', 'Invalid website health history page.');
    const page = await repository.listWebsiteHealthAudits(project.id, offset, limit);
    const result: WebsiteHealthPage = {
      items: page.items.map(summaryAudit), total: page.total,
      nextCursor: offset + limit < page.total ? String(offset + limit) : null,
      ...availability, defaultUrl: defaultUrl(project),
    };
    return json(result);
  }
  if (collection && method === 'POST') {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) return fail(400, 'IDEMPOTENCY_REQUIRED', 'Supply an Idempotency-Key header.');
    const input = auditInput.parse(await body(request));
    const id = `health_${hash(JSON.stringify([project.id, userId, key])).slice(0, 40)}`, fingerprint = hash(JSON.stringify(input));
    const replay = async (audit: WebsiteHealthJob | null) => {
      if (!audit || audit.fingerprint !== fingerprint)
        return fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different website audit.');
      return enqueue(audit);
    };
    const existing = await repository.getWebsiteHealthAudit(project.id, id);
    if (existing) return replay(existing);
    if (!ownedUrl(project, input.url)) return fail(400, 'WEBSITE_DOMAIN_MISMATCH', 'Choose a URL on this account’s website or one of its subdomains.');
    if (!availability.auditingAvailable) return fail(503, 'WEBSITE_HEALTH_UNAVAILABLE', 'Configure a Google PageSpeed API key before running audits.');
    const at = now.toISOString();
    const audit: WebsiteHealthJob = {
      id, projectId: project.id, createdBy: userId, fingerprint, url: input.url,
      status: 'queued', createdAt: at, updatedAt: at, version: 1, attempts: 0,
      results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } },
    };
    const reserved = await repository.reserveWebsiteHealthAudit(audit, null);
    if (reserved === 'conflict') return replay(await repository.getWebsiteHealthAudit(project.id, id));
    if (reserved === 'limit') return fail(429, 'WEBSITE_HEALTH_LIMIT', 'One audit can run per account at a time. Wait for it to finish and allow at least one minute between new audits.');
    return enqueue(audit);
  }
  if (match && method === 'GET') {
    const audit = await repository.getWebsiteHealthAudit(project.id, identifier.parse(decodeURIComponent(match[1])));
    if (!audit) return fail(404, 'WEBSITE_HEALTH_NOT_FOUND', 'Website audit not found.');
    return json({ audit: publicWebsiteHealthAudit(audit) });
  }
  return null;
}
