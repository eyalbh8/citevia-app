import {
  citationMeasurement,
  type Analysis,
  type CapturedAnswer,
  type PromptResult,
  type ScanRun,
  type TrackedUrl,
  type TrackingMatch,
} from '@citevia/core';
import { uuidFor, type SqlDatabase, type SqlSession } from './sql.js';
import { AccessError } from './users.js';

async function refreshCounters(
  tx: SqlSession,
  projectId: string,
  ids: string[],
) {
  if (!ids.length) return;
  await tx.query(
    `UPDATE tracked_recommendations tr SET
    total_appearances_after_implementation=COALESCE(a.appearances,0),first_cited_at=a.first_cited,last_cited_at=a.last_cited,
    days_to_first_citation=CASE WHEN a.first_cited IS NULL THEN NULL ELSE GREATEST(0,ROUND(EXTRACT(EPOCH FROM (a.first_cited-COALESCE(tr.published_at,tr.created_at)))/86400))::int END,
    updated_at=now()
    FROM (SELECT u.id,evidence.* FROM citevia_tracked_urls u LEFT JOIN LATERAL (
      SELECT SUM((c.data->>'appearances')::int)::int AS appearances,MIN(cap.captured_at) AS first_cited,MAX(cap.captured_at) AS last_cited
      FROM citevia_tracked_url_matches m
      JOIN citevia_response_citations c ON c.project_id=m.project_id AND c.capture_key=m.capture_key AND c.normalized_url=m.normalized_url
      JOIN citevia_citation_captures cap ON cap.project_id=m.project_id AND cap.capture_key=m.capture_key
      JOIN citevia_runs r ON r.project_id=cap.project_id AND r.id=cap.run_id AND r.status IN ('completed','partial')
      WHERE m.project_id=u.project_id AND m.tracked_url_id=u.id
    ) evidence ON true WHERE u.project_id=$1 AND u.id=ANY($2::uuid[])) a WHERE tr.id=a.id`,
    [projectId, ids],
  );
}
/** Publish compatibility counters in the transaction that makes a scan visible. */
export async function refreshRunCounters(
  tx: SqlSession,
  projectId: string,
  runId: string,
) {
  const rows = await tx.query(
    `SELECT DISTINCT m.tracked_url_id FROM citevia_tracked_url_matches m JOIN citevia_citation_captures c USING(project_id,capture_key) WHERE m.project_id=$1 AND c.run_id=$2`,
    [projectId, runId],
  );
  await refreshCounters(
    tx,
    projectId,
    rows.rows.map((r) => String(r.tracked_url_id)),
  );
}
export async function saveCitationMeasurement(
  tx: SqlSession,
  result: PromptResult,
  run: ScanRun,
  answer: CapturedAnswer | null,
  analysis: Analysis | null,
) {
  const measurement = citationMeasurement(result, run, answer, analysis);
  if (!measurement) return;
  const { capture, evidence } = measurement;
  // Unique capture identity serializes reanalysis from different runs. A failed
  // analysis cannot overwrite a successful one, and older finalizers lose CAS.
  const saved = await tx.query(
    `INSERT INTO citevia_citation_captures(project_id,capture_key,run_id,captured_at,analyzed,analysis_at,result_version,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(project_id,capture_key) DO UPDATE SET
    run_id=excluded.run_id,captured_at=excluded.captured_at,analyzed=excluded.analyzed,analysis_at=excluded.analysis_at,result_version=excluded.result_version,data=excluded.data
    WHERE (excluded.analyzed AND NOT citevia_citation_captures.analyzed) OR
    (excluded.analyzed=citevia_citation_captures.analyzed AND (excluded.analysis_at>citevia_citation_captures.analysis_at OR (excluded.analysis_at=citevia_citation_captures.analysis_at AND excluded.result_version>=citevia_citation_captures.result_version))) RETURNING capture_key`,
    [
      capture.projectId,
      capture.captureKey,
      capture.runId,
      capture.capturedAt,
      capture.analyzed,
      capture.analysisAt,
      capture.resultVersion,
      JSON.stringify(capture),
    ],
  );
  if (!saved.rows.length) return;
  const old = await tx.query(
    `SELECT tracked_url_id FROM citevia_tracked_url_matches WHERE project_id=$1 AND capture_key=$2`,
    [capture.projectId, capture.captureKey],
  );
  const priorIds = old.rows.map((r) => String(r.tracked_url_id));
  await tx.query(
    'DELETE FROM citevia_response_citations WHERE project_id=$1 AND capture_key=$2',
    [capture.projectId, capture.captureKey],
  );
  if (evidence.length) {
    await tx.query(
      `INSERT INTO citevia_response_citations(project_id,capture_key,normalized_url,data)
      SELECT $1,$2,e->>'normalizedUrl',e FROM jsonb_array_elements($3::jsonb) e`,
      [capture.projectId, capture.captureKey, JSON.stringify(evidence)],
    );
    await tx.query(
      `INSERT INTO citevia_tracked_url_matches(project_id,tracked_url_id,capture_key,normalized_url)
      SELECT u.project_id,u.id,c.capture_key,c.normalized_url FROM citevia_tracked_urls u
      JOIN citevia_response_citations c ON c.project_id=u.project_id AND c.normalized_url=u.normalized_url
      WHERE u.project_id=$1 AND c.capture_key=$2 AND ((CASE WHEN u.data ? 'trackingPeriods' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(u.data->'trackingPeriods') p WHERE (p->>'start')::timestamptz<=$3::timestamptz AND (p->>'end' IS NULL OR (p->>'end')::timestamptz>$3::timestamptz)) ELSE u.active AND u.created_at<=$3::timestamptz END) OR u.id=ANY($4::uuid[])) ON CONFLICT DO NOTHING`,
      [capture.projectId, capture.captureKey, capture.capturedAt, priorIds],
    );
  }
  const updated = await tx.query(
    `SELECT tracked_url_id FROM citevia_tracked_url_matches WHERE project_id=$1 AND capture_key=$2`,
    [capture.projectId, capture.captureKey],
  );
  await refreshCounters(tx, capture.projectId, [
    ...new Set([
      ...priorIds,
      ...updated.rows.map((r) => String(r.tracked_url_id)),
    ]),
  ]);
}
export async function listTrackedUrls(
  db: SqlSession,
  projectId: string,
): Promise<TrackedUrl[]> {
  return (
    await db.query(
      'SELECT data FROM citevia_tracked_urls WHERE project_id=$1 ORDER BY created_at DESC,id',
      [projectId],
    )
  ).rows.map((r) => r.data as TrackedUrl);
}
export async function registerTrackedUrl(
  db: SqlDatabase,
  url: TrackedUrl,
): Promise<TrackedUrl> {
  return db.transaction(async (tx) => {
    // Coordinates with saveMeasurement so registration cannot miss an in-flight scan.
    await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [
      url.projectId,
    ]);
    const existing = await tx.query(
      'SELECT data FROM citevia_tracked_urls WHERE project_id=$1 AND normalized_url=$2',
      [url.projectId, url.normalizedUrl],
    );
    if (existing.rows.length) return existing.rows[0].data as TrackedUrl;
    const count = await tx.query(
      'SELECT count(*)::int AS count FROM citevia_tracked_urls WHERE project_id=$1',
      [url.projectId],
    );
    if (Number(count.rows[0].count) >= 500)
      throw new AccessError(
        400,
        'TRACKING_LIMIT',
        'An account can track up to 500 URLs.',
      );
    await tx.query(
      `INSERT INTO tracked_recommendations(id,account_id,urls,title,content_type,published_at,created_at,updated_at) VALUES($1,$2,ARRAY[$3],$4,$5,$6,$7,$7)`,
      [
        url.id,
        uuidFor(url.projectId),
        url.url,
        url.title,
        url.contentType,
        url.publishedAt,
        url.createdAt,
      ],
    );
    await tx.query(
      `INSERT INTO citevia_tracked_urls(project_id,id,normalized_url,active,created_at,version,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        url.projectId,
        url.id,
        url.normalizedUrl,
        url.active,
        url.createdAt,
        url.version,
        JSON.stringify(url),
      ],
    );
    await tx.query(
      `INSERT INTO citevia_tracked_url_matches(project_id,tracked_url_id,capture_key,normalized_url)
      SELECT c.project_id,$2,c.capture_key,c.normalized_url FROM citevia_response_citations c JOIN citevia_citation_captures cap USING(project_id,capture_key)
      WHERE c.project_id=$1 AND c.normalized_url=$3 AND cap.captured_at >= $4::timestamptz ON CONFLICT DO NOTHING`,
      [url.projectId, url.id, url.normalizedUrl, url.createdAt],
    );
    await refreshCounters(tx, url.projectId, [url.id]);
    return url;
  });
}
export async function updateTrackedUrl(
  db: SqlDatabase,
  url: TrackedUrl,
  expected: number,
) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [
      url.projectId,
    ]);
    const updated = await tx.query(
      `UPDATE citevia_tracked_urls SET active=$3,version=$4,data=$5::jsonb WHERE project_id=$1 AND id=$2 AND version=$6 RETURNING id`,
      [
        url.projectId,
        url.id,
        url.active,
        url.version,
        JSON.stringify(url),
        expected,
      ],
    );
    if (!updated.rows.length) return false;
    await tx.query(
      'UPDATE tracked_recommendations SET title=$2,updated_at=$3 WHERE id=$1',
      [url.id, url.title, url.updatedAt],
    );
    return true;
  });
}
export async function listTrackingMatches(
  db: SqlSession,
  projectId: string,
  trackedUrlId?: string,
): Promise<TrackingMatch[]> {
  const rows = await db.query(
    `SELECT m.tracked_url_id,cap.data AS capture,c.data AS evidence FROM citevia_tracked_url_matches m
    JOIN citevia_citation_captures cap ON cap.project_id=m.project_id AND cap.capture_key=m.capture_key
    JOIN citevia_response_citations c ON c.project_id=m.project_id AND c.capture_key=m.capture_key AND c.normalized_url=m.normalized_url
    JOIN citevia_runs r ON r.project_id=cap.project_id AND r.id=cap.run_id
    WHERE m.project_id=$1 AND ($2::uuid IS NULL OR m.tracked_url_id=$2::uuid) AND r.status IN ('completed','partial') ORDER BY cap.captured_at DESC,m.capture_key`,
    [projectId, trackedUrlId || null],
  );
  return rows.rows.map((row) => ({
    trackedUrlId: String(row.tracked_url_id),
    capture: row.capture as TrackingMatch['capture'],
    evidence: row.evidence as TrackingMatch['evidence'],
  }));
}
