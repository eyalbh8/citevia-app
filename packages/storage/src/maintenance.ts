import type { SqlDatabase } from './sql.js';
import { isDeepStrictEqual } from 'node:util';
import type { Analysis, CapturedAnswer } from '@citevia/core';
import type { ArtifactStore } from './contracts.js';

/** Metadata only: no customer answers, credentials, URLs or raw JSON are read. */
export async function collectStorageAudit(db: SqlDatabase) {
  const [tables, indexes, dependencies, statistics] = await Promise.all([
    db.query(`SELECT relname AS name,n_live_tup AS estimated_rows,n_dead_tup AS estimated_dead_rows,
      seq_scan,idx_scan,last_analyze,last_autoanalyze,
      pg_table_size(relid)::text AS table_bytes,pg_indexes_size(relid)::text AS index_bytes,
      pg_total_relation_size(relid)::text AS total_bytes
      FROM pg_stat_user_tables WHERE schemaname=current_schema()
      ORDER BY pg_total_relation_size(relid) DESC,relname`),
    db.query(`SELECT relname AS table_name,indexrelname AS name,idx_scan,
      pg_relation_size(indexrelid)::text AS bytes
      FROM pg_stat_user_indexes WHERE schemaname=current_schema()
      ORDER BY pg_relation_size(indexrelid) DESC,indexrelname`),
    db.query(`SELECT child.relname AS child_table,parent.relname AS parent_table,c.conname AS constraint_name
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
      JOIN pg_class parent ON parent.oid=c.confrelid
      JOIN pg_namespace ns ON ns.oid=child.relnamespace
      WHERE c.contype='f' AND ns.nspname=current_schema()
      ORDER BY child.relname,parent.relname,c.conname`),
    db.query('SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()'),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    statisticsResetAt: statistics.rows[0]?.stats_reset ?? null,
    tables: tables.rows,
    indexes: indexes.rows,
    foreignKeys: dependencies.rows,
    note: 'Row counts and index scans are estimates since the database statistics reset. No table or index is safe to remove solely because its scan count is zero.',
  };
}

export interface ExpiredAuthCleanupOptions {
  /** Preview by default; applying requires an explicit false. Never deletes scan/evidence data. */
  dryRun?: boolean;
  now?: Date;
  /** Maximum deletions per table per invocation. */
  limit?: number;
  /** Retain old rate-limit buckets for this long; at least one day. */
  rateLimitRetentionDays?: number;
}

/** Bounded cleanup for expired authentication state only. */
export async function cleanupExpiredAuthState(db: SqlDatabase, options: ExpiredAuthCleanupOptions = {}) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 500;
  const retentionDays = options.rateLimitRetentionDays ?? 7;
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid cleanup time');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new Error('Cleanup limit must be between 1 and 2000');
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
    throw new Error('Rate-limit retention must be between 1 and 365 days');
  const before = now.toISOString();
  const rateLimitBefore = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  const dryRun = options.dryRun !== false;
  return db.transaction(async tx => {
    const records = await tx.query(dryRun
      ? `SELECT count(*)::int AS count FROM (SELECT 1 FROM citevia_mcp_records
         WHERE expires_at<=$1::timestamptz ORDER BY expires_at LIMIT $2) candidates`
      : `WITH candidates AS (SELECT kind,id FROM citevia_mcp_records
         WHERE expires_at<=$1::timestamptz ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED),
         removed AS (DELETE FROM citevia_mcp_records r USING candidates c
         WHERE r.kind=c.kind AND r.id=c.id RETURNING r.id) SELECT count(*)::int AS count FROM removed`,
      [before, limit]);
    const buckets = await tx.query(dryRun
      ? `SELECT count(*)::int AS count FROM (SELECT 1 FROM citevia_mcp_request_limits
         WHERE window_start<$1::timestamptz ORDER BY window_start LIMIT $2) candidates`
      : `WITH candidates AS (SELECT bucket FROM citevia_mcp_request_limits
         WHERE window_start<$1::timestamptz ORDER BY window_start LIMIT $2 FOR UPDATE SKIP LOCKED),
         removed AS (DELETE FROM citevia_mcp_request_limits r USING candidates c
         WHERE r.bucket=c.bucket RETURNING r.bucket) SELECT count(*)::int AS count FROM removed`,
      [rateLimitBefore, limit]);
    return { dryRun, before, rateLimitBefore, expiredRecords: Number(records.rows[0].count),
      staleRateLimitBuckets: Number(buckets.rows[0].count), limitPerTable: limit };
  });
}

export interface EvidenceCompactionOptions {
  /** Every candidate is verified against readable original artifacts before mutation. */
  dryRun?: boolean;
  limit?: number;
  afterId?: string;
}

/** Remove only verified duplicate raw receipts. Original artifacts and normalized analysis stay intact. */
export async function compactEvidenceDuplicates(db: SqlDatabase, artifacts: ArtifactStore,
  options: EvidenceCompactionOptions = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Compaction limit must be between 1 and 500');
  if (options.afterId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options.afterId))
    throw new Error('Compaction cursor must be a UUID');
  const dryRun = options.dryRun !== false;
  const { rows } = await db.query(`SELECT id,s3_key,response,json_response FROM prompt_responses
    WHERE ($1::uuid IS NULL OR id>$1::uuid)
      AND (json_response ? 'nativeResponse' OR (json_response->'analysis') ? 'raw')
    ORDER BY id LIMIT $2`, [options.afterId || null, limit]);
  const skipped: Record<string, number> = {};
  let verified = 0;
  let compacted = 0;
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const row of rows) {
    const json = row.json_response as Record<string, unknown>;
    const measurement = json.measurement as Record<string, unknown> | undefined;
    const captureKey = measurement?.captureKey;
    const analysisKey = measurement?.analysisKey;
    if (json.analysis !== null && json.analysis !== undefined &&
      (typeof json.analysis !== 'object' || Array.isArray(json.analysis))) {
      skip('invalid_projection');
      continue;
    }
    if (typeof captureKey !== 'string' || !captureKey || captureKey !== row.s3_key ||
      (json.analysis !== null && json.analysis !== undefined && (typeof analysisKey !== 'string' || !analysisKey))) {
      skip('missing_reference');
      continue;
    }
    let capture: CapturedAnswer | null;
    let analysis: Analysis | null;
    try {
      [capture, analysis] = await Promise.all([
        artifacts.get<CapturedAnswer>(captureKey),
        typeof analysisKey === 'string' && analysisKey ? artifacts.get<Analysis>(analysisKey) : null,
      ]);
    } catch {
      skip('artifact_unreadable');
      continue;
    }
    if (!capture || (json.analysis && !analysis)) {
      skip('artifact_missing');
      continue;
    }
    const normalized = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { raw: _raw, ...rest } = value as Record<string, unknown>;
      return rest;
    };
    if (typeof capture.text !== 'string' || row.response !== (capture.text || null) ||
      ('nativeResponse' in json && !isDeepStrictEqual(json.nativeResponse, capture.raw)) ||
      (json.analysis && (!isDeepStrictEqual(normalized(json.analysis), normalized(analysis)) ||
        ('raw' in (json.analysis as object) && !isDeepStrictEqual((json.analysis as Analysis).raw, analysis?.raw))))) {
      skip('artifact_mismatch');
      continue;
    }
    verified++;
    if (dryRun) continue;
    const updated = { ...json };
    delete updated.nativeResponse;
    if (updated.analysis && typeof updated.analysis === 'object') updated.analysis = normalized(updated.analysis);
    const saved = await db.query(`UPDATE prompt_responses SET json_response=$4::jsonb
      WHERE id=$1 AND s3_key=$2 AND json_response=$3::jsonb RETURNING id`,
      [row.id, captureKey, JSON.stringify(json), JSON.stringify(updated)]);
    if (saved.rows.length) compacted++;
    else skip('concurrent_update');
  }
  return { dryRun, scanned: rows.length, verified, compacted, skipped,
    nextCursor: rows.length ? String(rows[rows.length - 1].id) : null, limit };
}

/** Prepare old JSON-only readers for a coordinated rollback. Pause scan writers before applying. */
export async function rehydrateRunManifests(db: SqlDatabase,
  options: { dryRun?: boolean; limit?: number; after?: string } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Rehydration limit must be between 1 and 500');
  let cursor: { projectId: string; id: string } | null = null;
  if (options.after) {
    try {
      cursor = JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor.projectId !== 'string' || !cursor.projectId ||
        typeof cursor.id !== 'string' || !cursor.id) throw new Error();
    } catch { throw new Error('Invalid run rehydration cursor'); }
  }
  const dryRun = options.dryRun !== false;
  const timestamp = (field: string) => `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  return db.transaction(async tx => {
    const { rows } = await tx.query(`SELECT project_id,id,result_version,data,
      (data-'startedAt'-'completedAt'-'summaryKey'-'summaryVersion') || jsonb_strip_nulls(jsonb_build_object(
        'status',status,'resultVersion',result_version,'terminalCount',terminal_count,
        'totalCount',total_count,'succeededCount',succeeded_count,'capturedCount',captured_count,
        'startedAt',${timestamp('started_at')},'completedAt',${timestamp('completed_at')},
        'deadlineAt',COALESCE(${timestamp('deadline_at')},data->>'deadlineAt'),
        'summaryKey',summary_key,'summaryVersion',summary_version)) AS hydrated
      FROM citevia_runs WHERE ($1::text IS NULL OR (project_id,id)>($1::text,$2::text))
      ORDER BY project_id,id LIMIT $3 ${dryRun ? '' : 'FOR UPDATE SKIP LOCKED'}`,
      [cursor?.projectId ?? null, cursor?.id ?? null, limit]);
    const changed = rows.filter(row => !isDeepStrictEqual(row.data, row.hydrated));
    let updated = 0;
    if (!dryRun && changed.length) {
      const saved = await tx.query(`UPDATE citevia_runs run SET data=c.data
        FROM jsonb_to_recordset($1::jsonb) AS c(project_id text,id text,result_version integer,data jsonb)
        WHERE run.project_id=c.project_id AND run.id=c.id AND run.result_version=c.result_version RETURNING run.id`,
        [JSON.stringify(changed.map(row => ({ project_id: row.project_id, id: row.id,
          result_version: row.result_version, data: row.hydrated })))]);
      updated = saved.rows.length;
    }
    const last = rows[rows.length - 1];
    return { dryRun, scanned: rows.length, needsRehydration: changed.length, updated, limit,
      nextCursor: last ? Buffer.from(JSON.stringify({ projectId: last.project_id, id: last.id })).toString('base64url') : null };
  });
}
