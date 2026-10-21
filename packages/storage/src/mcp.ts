import type { SqlDatabase } from './sql.js';
import { AccessError } from './users.js';

/** A credential belongs to one identity; a null project is an explicit global grant. */
export interface McpConnection {
  id: string;
  userId: string;
  projectId: string | null;
  name: string;
  tokenHash: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  kind: 'api_key' | 'oauth';
}

export interface McpRecord {
  /** Token records use a cryptographic hash here, never the bearer token. */
  id: string;
  kind: 'client' | 'code' | 'refresh' | 'access' | 'consent';
  data: Record<string, unknown>;
  expiresAt: string | null;
}

export interface McpRepository {
  createMcpConnection(connection: McpConnection): Promise<void>;
  listMcpConnections(userId: string, projectId: string | null): Promise<McpConnection[]>;
  getMcpConnectionByHash(hash: string): Promise<McpConnection | null>;
  getMcpConnection(id: string): Promise<McpConnection | null>;
  revokeMcpConnection(id: string, userId: string, now: string): Promise<boolean>;
  touchMcpConnection(id: string, now: string): Promise<void>;
  putMcpRecord(record: McpRecord): Promise<void>;
  getMcpRecord(kind: McpRecord['kind'], id: string): Promise<McpRecord | null>;
  /** Consumes a live record once. Refresh records retain a consumed tombstone for replay detection. */
  consumeMcpRecord(kind: McpRecord['kind'], id: string, now: string): Promise<McpRecord | null>;
  limitMcpRequests(bucket: string, windowStart: string, limit: number): Promise<boolean>;
}

export const MCP_CONNECTION_LIMIT = 20;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown): string | null => value == null ? null : iso(value);
const connectionFromRow = (row: Record<string, unknown>): McpConnection => ({
  id: String(row.id), userId: String(row.user_id),
  projectId: row.project_id == null ? null : String(row.project_id),
  name: String(row.name), tokenHash: String(row.token_hash), keyPrefix: String(row.key_prefix),
  createdAt: iso(row.created_at), expiresAt: nullableIso(row.expires_at),
  lastUsedAt: nullableIso(row.last_used_at), revokedAt: nullableIso(row.revoked_at),
  kind: row.kind as McpConnection['kind'],
});
const recordFromRow = (row: Record<string, unknown>): McpRecord => ({
  id: String(row.id), kind: row.kind as McpRecord['kind'],
  data: row.data as Record<string, unknown>, expiresAt: nullableIso(row.expires_at),
});

export async function createMcpConnection(db: SqlDatabase, connection: McpConnection): Promise<void> {
  try {
    await db.transaction(async tx => {
      // Serialize creation for precisely this identity and scope across every API worker.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `citevia:mcp:${JSON.stringify([connection.userId, connection.projectId])}`,
      ]);
      const { rows } = await tx.query(
        `SELECT count(*)::int AS count FROM citevia_mcp_connections
        WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2::text
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3::timestamptz)`,
        [connection.userId, connection.projectId, connection.createdAt],
      );
      if (Number(rows[0].count) >= MCP_CONNECTION_LIMIT)
        throw new AccessError(409, 'MCP_CONNECTION_LIMIT', 'Revoke an existing MCP connection before creating another.');
      await tx.query(
        `INSERT INTO citevia_mcp_connections
          (id,user_id,project_id,name,token_hash,key_prefix,created_at,expires_at,last_used_at,revoked_at,kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [connection.id, connection.userId, connection.projectId, connection.name,
          connection.tokenHash, connection.keyPrefix, connection.createdAt, connection.expiresAt,
          connection.lastUsedAt, connection.revokedAt, connection.kind],
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new AccessError(409, 'MCP_CONNECTION_EXISTS', 'This MCP credential already exists.');
    throw error;
  }
}

export async function listMcpConnections(db: SqlDatabase, userId: string, projectId: string | null) {
  const { rows } = await db.query(
    `SELECT * FROM citevia_mcp_connections WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2::text
    ORDER BY created_at DESC,id`, [userId, projectId],
  );
  return rows.map(connectionFromRow);
}
export async function getMcpConnectionByHash(db: SqlDatabase, hash: string) {
  const { rows } = await db.query('SELECT * FROM citevia_mcp_connections WHERE token_hash=$1', [hash]);
  return rows[0] ? connectionFromRow(rows[0]) : null;
}
export async function getMcpConnection(db: SqlDatabase, id: string) {
  const { rows } = await db.query('SELECT * FROM citevia_mcp_connections WHERE id=$1', [id]);
  return rows[0] ? connectionFromRow(rows[0]) : null;
}
export async function revokeMcpConnection(db: SqlDatabase, id: string, userId: string, now: string) {
  const { rows } = await db.query(
    `UPDATE citevia_mcp_connections SET revoked_at=$3
    WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`, [id, userId, now],
  );
  return rows.length === 1;
}
export async function touchMcpConnection(db: SqlDatabase, id: string, now: string): Promise<void> {
  await db.query(
    `UPDATE citevia_mcp_connections SET last_used_at=$2
    WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2::timestamptz)
      AND (last_used_at IS NULL OR last_used_at<$2::timestamptz)`, [id, now],
  );
}
export async function putMcpRecord(db: SqlDatabase, record: McpRecord): Promise<void> {
  await db.query(
    `INSERT INTO citevia_mcp_records(kind,id,data,expires_at) VALUES($1,$2,$3::jsonb,$4)
    ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at`,
    [record.kind, record.id, JSON.stringify(record.data), record.expiresAt],
  );
}
export async function getMcpRecord(db: SqlDatabase, kind: McpRecord['kind'], id: string) {
  const { rows } = await db.query('SELECT * FROM citevia_mcp_records WHERE kind=$1 AND id=$2', [kind, id]);
  return rows[0] ? recordFromRow(rows[0]) : null;
}
export async function consumeMcpRecord(db: SqlDatabase, kind: McpRecord['kind'], id: string, now: string) {
  if (kind === 'refresh') {
    const { rows } = await db.query(
      `UPDATE citevia_mcp_records SET data=data || '{"consumed":true}'::jsonb
      WHERE kind='refresh' AND id=$1 AND data->'consumed' IS DISTINCT FROM 'true'::jsonb
        AND (expires_at IS NULL OR expires_at>$2::timestamptz)
      RETURNING kind,id,data-'consumed' AS data,expires_at`, [id, now],
    );
    return rows[0] ? recordFromRow(rows[0]) : null;
  }
  const { rows } = await db.query(
    `WITH consumed AS (DELETE FROM citevia_mcp_records WHERE kind=$1 AND id=$2 RETURNING *)
    SELECT * FROM consumed WHERE expires_at IS NULL OR expires_at>$3::timestamptz`, [kind, id, now],
  );
  return rows[0] ? recordFromRow(rows[0]) : null;
}
export async function limitMcpRequests(db: SqlDatabase, bucket: string, windowStart: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) return false;
  const { rows } = await db.query(
    `INSERT INTO citevia_mcp_request_limits(bucket,window_start,request_count) VALUES($1,$2,1)
    ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,
      request_count=CASE WHEN citevia_mcp_request_limits.window_start<excluded.window_start
        THEN 1 ELSE citevia_mcp_request_limits.request_count+1 END
    WHERE citevia_mcp_request_limits.window_start<excluded.window_start
      OR (citevia_mcp_request_limits.window_start=excluded.window_start AND citevia_mcp_request_limits.request_count<$3)
    RETURNING bucket`, [bucket, windowStart, limit],
  );
  return rows.length === 1;
}
