import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  aggregateTraffic,
  trafficProvider,
  trafficBrowser,
  trafficDevice,
  trafficChange,
  type TrafficEvent,
  type TrafficFilters,
} from '@citevia/core';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
  type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { publicTrafficRoute } from '../apps/api/src/traffic.js';
import { createApi } from '../apps/api/src/app.js';
import { AuthenticationError } from '../apps/api/src/descope.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

const NOW = new Date('2026-10-21T23:59:59.999Z');
const projectId = 'traffic-account';
const filters: TrafficFilters = {
  period: {
    start: '2026-10-15T00:00:00.000Z',
    end: NOW.toISOString(),
    granularity: 'daily',
    timezone: 'UTC',
  },
  previous: {
    start: '2026-10-08T00:00:00.000Z',
    end: '2026-10-14T23:59:59.999Z',
    granularity: 'daily',
    timezone: 'UTC',
  },
  providers: [],
  countries: [],
};
const event = (overrides: Partial<TrafficEvent> = {}): TrafficEvent => ({
  id: randomUUID(),
  projectId,
  timestamp: '2026-10-20T12:00:00.000Z',
  url: 'https://northstar.example/pricing',
  path: '/pricing',
  referrer: 'https://chatgpt.com',
  provider: 'openai',
  userAgent: 'Mozilla/5.0 Chrome/141.0 Safari/537.36',
  browser: 'Chrome',
  device: 'desktop',
  country: 'US',
  testId: null,
  ...overrides,
});

describe('AI traffic attribution', () => {
  it('matches exact providers and their subdomains without matching lookalike URLs', () => {
    expect(trafficProvider('https://chatgpt.com/c/123')).toBe('openai');
    expect(trafficProvider('https://www.perplexity.ai/search')).toBe(
      'perplexity',
    );
    expect(trafficProvider('https://chatgpt.com.evil.example')).toBeNull();
    expect(
      trafficProvider('https://evil.example/?from=chatgpt.com'),
    ).toBeNull();
    expect(trafficProvider('not a URL', 'anthropic')).toBe('claude');
    expect(trafficProvider('https://www.bing.com')).toBeNull();
    expect(trafficProvider(null, 'deepseek')).toBe('deepseek');
    expect(trafficProvider(null, 'constructor')).toBeNull();
    expect(trafficProvider(null, '__proto__')).toBeNull();
    expect(trafficProvider(null, 'chatgpt.com')).toBe('openai');
    expect(trafficBrowser('Mozilla Chrome/141 Safari/537 Edg/141')).toBe(
      'Edge',
    );
    expect(trafficBrowser('Mozilla Chrome/141 Safari/537 OPR/124')).toBe(
      'Opera',
    );
    expect(trafficDevice('Mozilla Android 14 Tablet')).toBe('tablet');
    expect(trafficDevice('Mozilla iPhone Mobile Safari/605')).toBe('mobile');
    expect(trafficChange(20, 0)).toBeNull();
    expect(trafficChange(0, 0)).toBe(0);
    expect(trafficChange(75, 100)).toBe(-25);
  });
});

describe('public tracker and authenticated reports', () => {
  async function fixture() {
    const repository = new MemoryRepository();
    await repository.saveProject(newProject({ id: projectId }), null);
    await repository.saveProject(
      newProject({ id: 'other-traffic', domain: 'other.example' }),
      null,
    );
    await repository.syncUser(testIdentity('traffic-owner'));
    await repository.syncUser(testIdentity('traffic-viewer'));
    await repository.putMembership({
      projectId,
      userId: 'traffic-owner',
      role: 'owner',
    });
    await repository.putMembership({
      projectId,
      userId: 'traffic-viewer',
      role: 'viewer',
    });
    const runtime = {
      repository,
      queue: new MemoryQueue(),
      artifacts: new MemoryArtifacts(),
    };
    const api = createApi(runtime, { mode: 'live', now: () => NOW });
    const send = (
      body: unknown,
      origin = 'https://northstar.example',
      ua = 'Mozilla Chrome/141 Safari/537',
    ) =>
      publicTrafficRoute(
        runtime,
        new Request('https://api.test/v1/traffic/collect', {
          method: 'POST',
          headers: { origin, 'user-agent': ua, 'Content-Type': 'text/plain' },
          body: JSON.stringify(body),
        }),
        NOW,
        () => 'US',
      );
    const call = (query = '', user = 'traffic-owner', tail = 'traffic') =>
      api(
        new Request(
          `https://api.test/v1/projects/${projectId}/${tail}${query}`,
        ),
        testIdentity(user),
      );
    return { ...runtime, send, call };
  }
  it('collects AI referrals without login, deduplicates events, strips URL queries, excludes test visits and ignores forged classifications', async () => {
    const f = await fixture();
    const id = randomUUID();
    const payload = {
      id,
      projectId,
      url: 'https://northstar.example/pricing?email=private&token=secret',
      referrer: 'https://chatgpt.com/c/private',
      provider: 'claude',
      country: 'FR',
      browser: 'Fake',
    };
    expect((await f.send(payload))?.status).toBe(204);
    expect((await f.send(payload))?.status).toBe(204);
    const testId = randomUUID();
    expect(
      (await f.send({ ...payload, id: randomUUID(), testId }))?.status,
    ).toBe(204);
    const report = await (await f.call()).json();
    expect(report.current).toBe(1);
    expect(
      report.providers.find((p: any) => p.provider === 'openai').visits,
    ).toBe(1);
    expect(report.locations).toEqual([{ label: 'US', visits: 1 }]);
    expect(report.pages).toEqual([{ label: '/pricing', visits: 1 }]);
    expect(report.sources).toEqual([{ label: 'chatgpt.com', visits: 1 }]);
    expect(report.browsers).toEqual([{ label: 'Chrome', visits: 1 }]);
    expect(JSON.stringify(report)).not.toMatch(/private|secret|token|email/);
    const status = await (
      await f.call(`?testId=${testId}`, 'traffic-owner', 'traffic/status')
    ).json();
    expect(status).toMatchObject({ hasEvents: true, testReceived: true });
    const unmatched = await (
      await f.call(`?testId=${randomUUID()}`, 'traffic-owner', 'traffic/status')
    ).json();
    expect(unmatched.testReceived).toBe(false);
  });
  it('validates origins, website domains, body limits and source evidence', async () => {
    const f = await fixture();
    const payload = {
      id: randomUUID(),
      projectId,
      url: 'https://northstar.example/',
      utmSource: 'chatgpt',
    };
    expect((await f.send(payload, 'https://evil.example'))?.status).toBe(403);
    expect(
      (
        await f.send(
          { ...payload, url: 'https://northstar.example.evil.example/' },
          'https://northstar.example.evil.example',
        )
      )?.status,
    ).toBe(403);
    expect((await f.send({ ...payload, url: 'file:///tmp/a' }))?.status).toBe(
      403,
    );
    expect((await f.send({ ...payload, projectId: 'unknown' }))?.status).toBe(
      404,
    );
    expect((await f.send({ ...payload, id: 'invalid' }))?.status).toBe(400);
    expect(
      (await f.send({ ...payload, extra: 'x'.repeat(9000) }))?.status,
    ).toBe(413);
    expect(
      (await f.send({ ...payload, utmSource: 'chatgpt-evil' }))?.status,
    ).toBe(204);
    expect(
      (await f.send(payload, 'https://northstar.example', 'GPTBot'))?.status,
    ).toBe(204);
    expect(
      (
        await f.send({
          ...payload,
          utmSource: undefined,
          referrer: 'https://evil.example/chatgpt',
        })
      )?.status,
    ).toBe(204);
    expect((await f.repository.trafficStatus(projectId)).hasEvents).toBe(false);
    expect(
      (
        await f.send(
          {
            ...payload,
            url: 'https://www.northstar.example/?utm_source=chatgpt',
          },
          'https://www.northstar.example',
        )
      )?.status,
    ).toBe(204);
    expect((await f.repository.trafficStatus(projectId)).hasEvents).toBe(true);
  });
  it('requires account membership for reports, lets viewers read, rejects invalid filters and does not expose raw events', async () => {
    const f = await fixture();
    expect((await f.call('', 'stranger')).status).toBe(404);
    expect((await f.call('', 'traffic-viewer')).status).toBe(200);
    expect((await f.call('?providers=unknown')).status).toBe(400);
    expect((await f.call('?countries=US OR TRUE')).status).toBe(400);
    expect(
      (await f.call('?days=custom&start=2026-02-30&end=2026-03-03')).status,
    ).toBe(400);
    expect(
      (await f.call('?days=custom&start=2026-10-21&end=2026-10-01')).status,
    ).toBe(400);
    expect(
      (await f.call('?testId=anything', 'traffic-owner', 'traffic/status'))
        .status,
    ).toBe(400);
    expect((await f.call('', 'traffic-owner', 'traffic/events')).status).toBe(
      404,
    );
  });
  it('serves the public tracker and collector before the Descope boundary while keeping reports protected', async () => {
    const f = await fixture();
    const authenticate = vi.fn(async () => {
      throw new AuthenticationError(401, 'UNAUTHENTICATED', 'No session');
    });
    const api = createAuthenticatedApi(
      f,
      { authenticate, lookup: vi.fn() } as any,
      { mode: 'live', now: () => NOW },
    );
    const script = await api(
      new Request('https://api.test/v1/traffic/tracker.js'),
    );
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toContain(
      'application/javascript',
    );
    const response = await api(
      new Request('https://api.test/v1/traffic/collect', {
        method: 'POST',
        headers: { origin: 'https://northstar.example' },
        body: JSON.stringify({
          id: randomUUID(),
          projectId,
          url: 'https://northstar.example/',
          utmSource: 'chatgpt',
        }),
      }),
      '8.8.8.8',
    );
    expect(response.status).toBe(204);
    expect(authenticate).not.toHaveBeenCalled();
    const protectedReport = await api(
      new Request(`https://api.test/v1/projects/${projectId}/traffic`),
    );
    expect(protectedReport.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
  });
  it('limits collection independently per account', async () => {
    const f = await fixture();
    vi.spyOn(f.repository, 'limitMcpRequests').mockResolvedValue(false);
    expect(
      (
        await f.send({
          id: randomUUID(),
          projectId,
          url: 'https://northstar.example/',
          utmSource: 'chatgpt',
        })
      )?.status,
    ).toBe(429);
    expect((await f.repository.trafficStatus(projectId)).hasEvents).toBe(false);
  });
});

describe('PostgreSQL traffic aggregation', () => {
  let db: SqlDatabase, repository: PostgresRepository;
  beforeAll(async () => {
    db = await localPostgres();
    repository = new PostgresRepository(db);
    await repository.saveProject(newProject({ id: projectId }), null);
    await repository.saveProject(newProject({ id: 'other-traffic' }), null);
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  it('matches reference aggregation for date, provider and country filters with zero-filled series', async () => {
    const events = [
      event(),
      event({
        country: 'CY',
        provider: 'perplexity',
        referrer: 'https://www.perplexity.ai',
        device: 'mobile',
        browser: 'Safari',
      }),
      event({ country: null, provider: 'claude', referrer: null }),
      event({
        provider: 'deepseek',
        referrer: 'https://chat.deepseek.com',
        path: '/',
      }),
      event({ timestamp: '2026-10-14T23:59:59.999Z' }),
      event({ timestamp: '2026-10-15T00:00:00.000Z' }),
      event({ timestamp: '2026-10-21T23:59:59.999Z' }),
      event({ testId: randomUUID() }),
      event({ projectId: 'other-traffic' }),
      event({ timestamp: '2026-10-07T23:59:59.999Z' }),
    ];
    for (const e of events) await repository.collectTrafficEvent(e);
    await repository.collectTrafficEvent(events[0]);
    for (const selected of [
      filters,
      { ...filters, providers: ['perplexity' as const] },
      { ...filters, countries: ['US'] },
      { ...filters, countries: ['ZZ'] },
      { ...filters, providers: ['claude' as const], countries: ['CY'] },
      {
        ...filters,
        period: {
          ...filters.period,
          start: '2026-10-20T00:00:00.000Z',
          end: '2026-10-20T23:59:59.999Z',
          granularity: 'hourly' as const,
        },
      },
    ]) {
      const actual = await repository.aggregateTraffic(projectId, selected);
      const expected = aggregateTraffic(
        events.filter((e) => e.projectId === projectId),
        selected,
      );
      expect(actual).toEqual(expected);
    }
    const status = await repository.trafficStatus(projectId, events[7].testId!);
    expect(status).toMatchObject({ hasEvents: true, testReceived: true });
    const empty = await repository.trafficStatus('nonexistent');
    expect(empty).toEqual({
      hasEvents: false,
      lastReceivedAt: null,
      testReceived: false,
    });
  });
  it('reads existing iGEO referral rows using the native account ID without counting crawler traffic or spoofed domains', async () => {
    await db.query(
      `INSERT INTO analytics_events(id,account_id,timestamp,url,path,referrer,user_agent,source,browser,device,country)
      SELECT $2,account_id::text,$3,'https://northstar.example/legacy','/legacy',$4,'Mozilla Chrome/141',$5,'Chrome','desktop','US' FROM citevia_projects WHERE id=$1`,
      [
        projectId,
        randomUUID(),
        '2026-10-19T00:00:00Z',
        'https://gemini.google.com',
        'USER',
      ],
    );
    for (const [ref, source] of [
      ['https://chatgpt.com.evil.example', 'USER'],
      ['https://chatgpt.com', 'AI_CRAWLER'],
    ])
      await db.query(
        `INSERT INTO analytics_events(id,account_id,timestamp,url,path,referrer,user_agent,source)
        SELECT $2,account_id::text,$3,'https://northstar.example/bad','/bad',$4,'Bot',$5 FROM citevia_projects WHERE id=$1`,
        [projectId, randomUUID(), '2026-10-19T00:00:00Z', ref, source],
      );
    const report = await repository.aggregateTraffic(projectId, {
      ...filters,
      providers: ['gemini'],
    });
    expect(report.current).toBe(1);
    expect(report.pages).toEqual([{ label: '/legacy', visits: 1 }]);
    const all = await repository.aggregateTraffic(projectId, filters);
    expect(all.pages.some((r) => r.label === '/bad')).toBe(false);
  });
});
