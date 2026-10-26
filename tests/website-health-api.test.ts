import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebsiteHealthJob } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, PostgresRepository, type Repository, type SqlDatabase } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi, type ApiOptions } from '../apps/api/src/app.js';
import { websiteHealthRoute } from '../apps/api/src/website-health.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const at = '2026-10-26T09:00:00.000Z';
function job(projectId: string, id: string = randomUUID(), createdAt = at): WebsiteHealthJob {
  return {
    id, projectId, url: 'https://northstar.com/', createdBy: 'health-owner', fingerprint: `fingerprint-${id}`,
    status: 'queued', createdAt, updatedAt: createdAt, version: 1, attempts: 0,
    results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } },
  };
}

describe.each(['memory', 'postgres'] as const)('website health API and storage (%s)', backend => {
  let repository: Repository, db: SqlDatabase | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') {
      db = await localPostgres();
      repository = new PostgresRepository(db);
    } else repository = new MemoryRepository();
    for (const user of ['health-owner', 'health-viewer', 'health-outsider']) await repository.syncUser(testIdentity(user));
  }, 30000);
  afterAll(async () => { await db?.close(); });

  async function fixture(available = true) {
    const project = newProject({ id: `health-${randomUUID()}`, prompts: ['How can teams measure visibility?'] });
    project.brand.domains = ['northstar.com'];
    await repository.saveProject(project, null);
    for (const [userId, role] of [['health-owner', 'owner'], ['health-viewer', 'viewer']] as const)
      await repository.putMembership({ projectId: project.id, userId, role });
    const queue = new MemoryQueue(), artifacts = new MemoryArtifacts(), runtime = { repository, queue, artifacts };
    let clock = new Date(at);
    const options: ApiOptions = { mode: 'live', websiteHealthConfigured: available, cruxConfigured: false, now: () => clock };
    const api = createApi(runtime, options), path = `/v1/projects/${project.id}/website-health/audits`;
    const call = (suffix = '', method = 'GET', body?: unknown, key: string | null = 'health-request-001', user: string | null = 'health-owner') => api(new Request(`https://citevia.test${path}${suffix}`, {
      method, headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'Idempotency-Key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), user ? testIdentity(user) : undefined);
    return { project, runtime, queue, options, call, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
  }

  it('reports configuration, creates both devices and only exposes public audit fields', async () => {
    const f = await fixture(false);
    const empty = await (await f.call()).json();
    expect(empty).toEqual({ items: [], total: 0, nextCursor: null, auditingAvailable: false, cruxAvailable: false, defaultUrl: 'https://northstar.com/' });
    expect((await f.call('', 'POST', { url: 'https://northstar.com' })).status).toBe(503);
    f.options.websiteHealthConfigured = true;
    const created = await f.call('', 'POST', { url: 'https://www.northstar.com/guides#part' });
    expect(created.status).toBe(202);
    const { audit } = await created.json();
    expect(audit).toMatchObject({ projectId: f.project.id, url: 'https://www.northstar.com/guides', status: 'queued', results: { mobile: { status: 'queued' }, desktop: { status: 'queued' } } });
    expect(f.queue.messages).toEqual([{ kind: 'website-health', projectId: f.project.id, auditId: audit.id }]);
    for (const privateField of ['createdBy', 'fingerprint', 'version', 'attempts', 'artifactKeys', 'leaseOwner']) expect(audit).not.toHaveProperty(privateField);
    const detail = await (await f.call(`/${audit.id}`)).json();
    expect(detail.audit).toEqual(audit);
    const page = await (await f.call()).json();
    expect(page.items).toEqual([{ ...audit, summaryOnly: true }]);
    expect(page.total).toBe(1);
  });

  it('allows account viewers to read and rejects writes, outsiders and unauthenticated requests', async () => {
    const f = await fixture();
    const { audit } = await (await f.call('', 'POST', { url: 'https://northstar.com/' })).json();
    expect((await f.call(`/${audit.id}`, 'GET', undefined, null, 'health-viewer')).status).toBe(200);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, 'viewer-request', 'health-viewer')).status).toBe(403);
    expect((await f.call('', 'GET', undefined, null, 'health-outsider')).status).toBe(404);
    expect((await f.call('', 'GET', undefined, null, null)).status).toBe(401);
    const other = await fixture();
    expect((await other.call(`/${audit.id}`)).status).toBe(404);
    expect((await (await other.call()).json()).items).toEqual([]);
    const directDemo = websiteHealthRoute(f.runtime, { ...f.project, role: 'owner', demo: {} as never }, 'health-owner', 'website-health/audits',
      new Request('https://citevia.test', { method: 'POST' }), new Date(at), { auditingAvailable: true, cruxAvailable: false }, async () => ({}));
    await expect(directDemo).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_READ_ONLY' });
  });

  it('validates public URLs, exact account domain boundaries, strict bodies and idempotency headers', async () => {
    const f = await fixture();
    for (const url of [
      'bad-url', 'ftp://northstar.com/file', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/',
      'https://user:password@northstar.com/', 'https://northstar.com:8443/', 'https://northstar.local/',
      'https://northstar.com.evil.com/', 'https://other.com/', 'https://othernorthstar.com/',
    ]) expect((await f.call('', 'POST', { url })).status, url).toBe(400);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/', strategy: 'mobile' })).status).toBe(400);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, null)).status).toBe(400);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, 'short')).status).toBe(400);
    expect((await f.call('', 'POST', { url: 'https://docs.northstar.com/guide' })).status).toBe(202);
  });

  it('never treats a public suffix in account settings as ownership of every website', async () => {
    const f = await fixture();
    f.project.brand.domains = ['com', 'co.uk', 'github.io'];
    f.project.version++;
    await repository.saveProject(f.project, 1);
    for (const url of ['https://other.com/', 'https://other.co.uk/', 'https://other.github.io/'])
      expect((await f.call('', 'POST', { url })).status).toBe(400);
  });

  it('keeps bulky lab and field details out of history while preserving them in detail reads', async () => {
    const f = await fixture();
    const audit = job(f.project.id, 'full-report');
    audit.results.mobile = {
      status: 'completed',
      lab: {
        strategy: 'mobile', requestedUrl: audit.url, finalUrl: audit.url, fetchedAt: at, lighthouseVersion: '13',
        scores: { performance: 85, accessibility: 95, 'best-practices': 100, seo: 90 },
        metrics: [{ id: 'lcp', title: 'LCP', value: 2000, unit: 'ms', displayValue: '2 s', rating: 'good' }],
        issues: [{ id: 'issue', title: 'Reduce scripts', description: 'Some scripts are unused.', category: 'performance', priority: 'high', resources: ['https://northstar.com/script.js'] }],
        warnings: ['A warning'],
      },
      field: { status: 'unavailable', metrics: [], message: 'Insufficient traffic' },
    };
    await repository.reserveWebsiteHealthAudit(audit, null);
    const page = await (await f.call()).json();
    expect(page.items[0].summaryOnly).toBe(true);
    expect(page.items[0].results.mobile.lab).toMatchObject({ scores: audit.results.mobile.lab?.scores, metrics: [], issues: [], warnings: [] });
    expect(page.items[0].results.mobile).not.toHaveProperty('field');
    const detail = await (await f.call(`/${audit.id}`)).json();
    expect(detail.audit.results.mobile).toEqual(audit.results.mobile);
  });

  it('repairs a failed enqueue by replaying the same audit even after configuration becomes unavailable', async () => {
    const f = await fixture();
    const send = vi.spyOn(f.queue, 'send').mockRejectedValueOnce(new Error('temporary queue failure'));
    expect((await f.call('', 'POST', { url: 'https://northstar.com' })).status).toBe(500);
    const accepted = (await repository.listWebsiteHealthAudits(f.project.id, 0, 10)).items[0];
    f.options.websiteHealthConfigured = false;
    const replay = await f.call('', 'POST', { url: 'https://northstar.com/#heading' });
    expect(replay.status).toBe(202);
    expect((await replay.json()).audit.id).toBe(accepted.id);
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.queue.messages).toEqual([{ kind: 'website-health', projectId: f.project.id, auditId: accepted.id }]);
    const conflicting = await f.call('', 'POST', { url: 'https://northstar.com/other' });
    expect(conflicting.status).toBe(409);
    expect((await conflicting.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await repository.listWebsiteHealthAudits(f.project.id, 0, 10)).total).toBe(1);
  });

  it('enforces the active cap and cooldown while allowing the original request to replay', async () => {
    const f = await fixture();
    const { audit } = await (await f.call('', 'POST', { url: 'https://northstar.com/' })).json();
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, 'health-request-002')).status).toBe(429);
    const saved = (await repository.getWebsiteHealthAudit(f.project.id, audit.id))!;
    expect(await repository.saveWebsiteHealthAudit({ ...saved, status: 'completed', version: 2 }, 1)).toBe(true);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' })).status).toBe(200);
    f.advance(59000);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, 'health-request-002')).status).toBe(429);
    f.advance(1000);
    expect((await f.call('', 'POST', { url: 'https://northstar.com/' }, 'health-request-002')).status).toBe(202);
  });

  it('serializes competing reservations, isolates accounts and rejects stale worker updates', async () => {
    const f = await fixture(), first = job(f.project.id, 'first'), second = job(f.project.id, 'second');
    const reservations = await Promise.all([repository.reserveWebsiteHealthAudit(first, null), repository.reserveWebsiteHealthAudit(second, null)]);
    expect(reservations.filter(value => value === 'saved')).toHaveLength(1);
    expect(reservations.filter(value => value === 'limit')).toHaveLength(1);
    const winner = reservations[0] === 'saved' ? first : second;
    expect(await repository.reserveWebsiteHealthAudit(winner, null)).toBe('conflict');
    const updates = await Promise.all([
      repository.saveWebsiteHealthAudit({ ...winner, status: 'completed', version: 2 }, 1),
      repository.saveWebsiteHealthAudit({ ...winner, status: 'failed', version: 2 }, 1),
    ]);
    expect(updates.filter(Boolean)).toHaveLength(1);
    expect((await repository.getWebsiteHealthAudit(f.project.id, winner.id))?.version).toBe(2);
    const other = await fixture();
    expect(await repository.getWebsiteHealthAudit(other.project.id, winner.id)).toBeNull();
    expect(await repository.reserveWebsiteHealthAudit(job(other.project.id, winner.id), null)).toBe('saved');
    expect((await repository.listActiveWebsiteHealthAudits()).filter(item => item.projectId === other.project.id)).toHaveLength(1);
    expect((await repository.listActiveWebsiteHealthAudits()).filter(item => item.projectId === f.project.id)).toHaveLength(0);
  });

  it('paginates history in deterministic order and rejects invalid pagination', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) {
      const audit = job(f.project.id, `audit-${i}`, new Date(Date.parse(at) + i * 60000).toISOString());
      expect(await repository.reserveWebsiteHealthAudit(audit, null)).toBe('saved');
      expect(await repository.saveWebsiteHealthAudit({ ...audit, status: 'completed', version: 2 }, 1)).toBe(true);
    }
    const page = await (await f.call('?limit=2')).json();
    expect(page.items.map((item: WebsiteHealthJob) => item.id)).toEqual(['audit-2', 'audit-1']);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBe('2');
    const last = await (await f.call('?limit=2&cursor=2')).json();
    expect(last.items.map((item: WebsiteHealthJob) => item.id)).toEqual(['audit-0']);
    expect(last.nextCursor).toBeNull();
    for (const query of ['?limit=0', '?limit=51', '?cursor=-1', '?cursor=01', '?cursor=1000001', '?cursor=garbage'])
      expect((await f.call(query)).status).toBe(400);
  });
});
