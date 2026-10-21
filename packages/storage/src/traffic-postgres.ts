import {
  TRAFFIC_PROVIDERS,
  trafficBuckets,
  type TrafficEvent,
  type TrafficFilters,
  type TrafficAggregate,
  type TrafficProvider,
  type TrafficInstallationReceipt,
} from '@citevia/core';
import type { SqlSession, SqlDatabase } from './sql.js';

export async function collectTrafficEvent(db: SqlSession, event: TrafficEvent) {
  await db.query(
    `INSERT INTO analytics_events(id,account_id,timestamp,url,path,referrer,user_agent,source,browser,device,country,tracker_version,traffic_provider,connection_test_id)
    SELECT $2,p.account_id::text,$3,$4,$5,$6,$7,'USER',$8,$9,$10,'citevia-v1',$11,$12
    FROM citevia_projects p WHERE p.id=$1 ON CONFLICT(id) DO NOTHING`,
    [
      event.projectId,
      event.id,
      event.timestamp,
      event.url,
      event.path,
      event.referrer,
      event.userAgent,
      event.browser,
      event.device,
      event.country,
      event.provider,
      event.testId,
    ],
  );
}
export async function recordTrafficInstallation(
  db: SqlDatabase,
  receipt: TrafficInstallationReceipt,
) {
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO citevia_traffic_installations(project_id,origin,first_seen_at,last_seen_at,tracker_version)
      VALUES($1,$2,$3,$3,$4) ON CONFLICT(project_id,origin) DO UPDATE
      SET last_seen_at=greatest(citevia_traffic_installations.last_seen_at,excluded.last_seen_at), tracker_version=excluded.tracker_version`,
      [
        receipt.projectId,
        receipt.origin,
        receipt.timestamp,
        receipt.trackerVersion,
      ],
    );
    if (receipt.testId)
      await tx.query(
        `INSERT INTO analytics_events(id,account_id,timestamp,url,path,user_agent,source,tracker_version,connection_test_id)
      SELECT $2,p.account_id::text,$3,$4,$5,'','INSTALLATION',$6,$7 FROM citevia_projects p WHERE p.id=$1 ON CONFLICT(id) DO NOTHING`,
        [
          receipt.projectId,
          receipt.id,
          receipt.timestamp,
          receipt.url,
          new URL(receipt.url).pathname,
          receipt.trackerVersion,
          receipt.testId,
        ],
      );
  });
}
export async function trafficStatus(
  db: SqlSession,
  projectId: string,
  testId?: string,
) {
  const [events, installations] = await Promise.all([
    db.query(
      `SELECT
      (SELECT timestamp FROM analytics_events WHERE account_id=p.account_id::text AND source='USER' AND connection_test_id IS NULL ORDER BY timestamp DESC LIMIT 1) AS last,
      EXISTS(SELECT 1 FROM analytics_events WHERE account_id=p.account_id::text AND connection_test_id=$2) AS test_received
      FROM citevia_projects p WHERE p.id=$1`,
      [projectId, testId || null],
    ),
    db.query(
      `SELECT origin,first_seen_at,last_seen_at,tracker_version FROM citevia_traffic_installations WHERE project_id=$1 ORDER BY last_seen_at DESC,origin`,
      [projectId],
    ),
  ]);
  const last = events.rows[0]?.last;
  const sites = installations.rows.map((r) => ({
    origin: String(r.origin),
    firstSeenAt: new Date(r.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
    trackerVersion: String(r.tracker_version),
  }));
  return {
    installed: sites.length > 0 || Boolean(last),
    sites,
    hasEvents: Boolean(last),
    lastReceivedAt:
      [
        ...sites.map((s) => s.lastSeenAt),
        ...(last ? [new Date(last as string).toISOString()] : []),
      ]
        .sort()
        .at(-1) || null,
    testReceived: Boolean(events.rows[0]?.test_received),
  };
}
/** Aggregate in the database; no visitor-level records are returned to the dashboard. */
export async function aggregateTraffic(
  db: SqlSession,
  projectId: string,
  filters: TrafficFilters,
): Promise<TrafficAggregate> {
  const { rows } = await db.query(
    `WITH base AS (
    SELECT e.*, lower(substring(e.referrer from '^https?://([^/:?#]+)')) AS host
    FROM analytics_events e JOIN citevia_projects p ON p.account_id::text=e.account_id
    WHERE p.id=$1 AND e.timestamp >= $2::timestamptz AND e.timestamp <= $4::timestamptz
      AND e.connection_test_id IS NULL AND e.source='USER'
  ), attributed AS (
    SELECT *, coalesce(traffic_provider, CASE
      WHEN host ~ '(^|\\.)(chatgpt\\.com|openai\\.com)$' THEN 'openai'
      WHEN host ~ '(^|\\.)(claude\\.ai|claude\\.com)$' THEN 'claude'
      WHEN host ~ '(^|\\.)perplexity\\.ai$' THEN 'perplexity'
      WHEN host IN ('gemini.google.com','bard.google.com') THEN 'gemini'
      WHEN host ~ '(^|\\.)(copilot\\.microsoft\\.com|copilot\\.com)$' THEN 'copilot'
      WHEN host ~ '(^|\\.)deepseek\\.com$' THEN 'deepseek' END) AS provider,
      CASE WHEN upper(country) ~ '^[A-Z]{2}$' THEN upper(country) ELSE 'ZZ' END AS country_code
    FROM base
  ), selected AS (
    SELECT * FROM attributed WHERE provider=ANY($5::text[]) AND (cardinality($6::text[])=0 OR country_code=ANY($6::text[]))
  ), current AS (SELECT * FROM selected WHERE timestamp >= $3::timestamptz),
  report AS (
    SELECT 'provider' AS kind, provider AS label, '' AS bucket,
      count(*) FILTER (WHERE timestamp >= $3::timestamptz)::int AS visits,
      count(*) FILTER (WHERE timestamp <= $7::timestamptz)::int AS previous
    FROM selected GROUP BY provider
    UNION ALL
    SELECT 'series',provider,to_char(date_trunc($8,timestamp AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),count(*)::int,0 FROM current GROUP BY provider,3
    UNION ALL
    SELECT dim.kind,dim.label,'',count(*)::int,0 FROM current
      CROSS JOIN LATERAL (VALUES
        ('sources',coalesce(host,provider || ' (UTM)')),('pages',path),('locations',country_code),
        ('devices',coalesce(nullif(device,''),'Other')),('browsers',coalesce(nullif(browser,''),'Other'))
      ) AS dim(kind,label) GROUP BY dim.kind,dim.label
    UNION ALL
    SELECT 'country',country_code,'',count(*)::int,0 FROM attributed
      WHERE provider=ANY($5::text[]) AND timestamp >= $3::timestamptz GROUP BY country_code
  ) SELECT * FROM report ORDER BY visits DESC,label`,
    [
      projectId,
      filters.previous.start,
      filters.period.start,
      filters.period.end,
      filters.providers.length ? filters.providers : [...TRAFFIC_PROVIDERS],
      filters.countries,
      filters.previous.end,
      filters.period.granularity === 'hourly' ? 'hour' : 'day',
    ],
  );
  const providers = TRAFFIC_PROVIDERS.filter(
    (p) => !filters.providers.length || filters.providers.includes(p),
  ).map((provider) => {
    const row = rows.find((r) => r.kind === 'provider' && r.label === provider);
    return {
      provider,
      visits: Number(row?.visits || 0),
      previous: Number(row?.previous || 0),
    };
  });
  const series = trafficBuckets(filters.period).map((date) => ({
    date,
    values: {} as Partial<Record<TrafficProvider, number>>,
  }));
  const buckets = new Map(series.map((s) => [s.date, s.values]));
  for (const row of rows.filter((r) => r.kind === 'series')) {
    const bucket = buckets.get(String(row.bucket));
    if (bucket) bucket[row.label as TrafficProvider] = Number(row.visits);
  }
  const breakdown = (kind: string) =>
    rows
      .filter((r) => r.kind === kind)
      .map((r) => ({ label: String(r.label), visits: Number(r.visits) }));
  // Use the same UTM labels as the in-memory reference.
  const sources = breakdown('sources').map((r) => ({
    ...r,
    label: r.label.replace(
      /^(openai|claude|perplexity|gemini|copilot|deepseek) \(UTM\)$/,
      (_, p) =>
        `${({ openai: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', gemini: 'Gemini', copilot: 'Copilot', deepseek: 'DeepSeek' } as Record<string, string>)[p]} (UTM)`,
    ),
  }));
  return {
    current: providers.reduce((s, p) => s + p.visits, 0),
    previous: providers.reduce((s, p) => s + p.previous, 0),
    providers,
    series,
    sources,
    pages: breakdown('pages'),
    locations: breakdown('locations'),
    devices: breakdown('devices'),
    browsers: breakdown('browsers'),
    countries: rows
      .filter((r) => r.kind === 'country')
      .map((r) => String(r.label))
      .sort(),
  };
}
