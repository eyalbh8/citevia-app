import { randomUUID } from 'node:crypto';
import type { SqlDatabase, SqlSession } from './sql.js';

// Absurd Retry-After values must fail closed instead of causing Date to throw.
const MAX_COOLDOWN_AT = Date.parse('9999-12-31T23:59:59.999Z');

export interface ProviderAdmissionPolicy {
  minIntervalMs: number;
  maxConcurrent: number;
  leaseMs: number;
}
export type ProviderAdmission =
  | { admitted: true; leaseId: string }
  | { admitted: false; reason: 'spacing' | 'concurrency' | 'cooldown'; retryAfterMs: number }
  | { admitted: false; reason: 'quota'; blockedScope: string };
export interface ProviderAdmissionStore {
  acquire(scope: string, policy: ProviderAdmissionPolicy, quotaDependency?: string): Promise<ProviderAdmission>;
  complete(scope: string, leaseId: string, failure?: { kind: 'rate_limit' | 'quota'; retryAfterMs?: number }): Promise<void>;
  /** Call only after an operator has resolved provider billing/quota, never as an automatic probe. */
  resetQuota(scope: string): Promise<void>;
}
type AdmissionRow = Record<string, unknown> & {
  next_request_at: Date | string;
  cooldown_until: Date | string;
  quota_blocked_at: Date | string | null;
};
function millis(value: Date | string): number {
  // pg maps PostgreSQL infinity timestamps to numbers; PGlite uses strings.
  if ((value as unknown) === -Infinity || value === '-infinity') return -Infinity;
  return new Date(value).getTime();
}
function validateScope(scope: string): void {
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(scope)) throw new Error('Invalid provider admission scope.');
}
function validatePolicy(policy: ProviderAdmissionPolicy): void {
  if (!Number.isSafeInteger(policy.minIntervalMs) || policy.minIntervalMs < 0 ||
      !Number.isSafeInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 ||
      !Number.isSafeInteger(policy.leaseMs) || policy.leaseMs < 1)
    throw new Error('Invalid provider admission policy.');
}

/** Short transactions serialize admissions across workers, without keeping a connection during inference. */
export class SqlProviderAdmissionStore implements ProviderAdmissionStore {
  constructor(private readonly db: SqlDatabase, private readonly options: { now?: () => Date } = {}) {}

  private async now(tx: SqlSession): Promise<number> {
    if (this.options.now) return this.options.now().getTime();
    const result = await tx.query<{ at: Date | string }>('SELECT clock_timestamp() AS at');
    return millis(result.rows[0].at);
  }

  private async lock(tx: SqlSession, scope: string): Promise<AdmissionRow> {
    await tx.query('INSERT INTO citevia_provider_admission(scope) VALUES($1) ON CONFLICT DO NOTHING', [scope]);
    return (await tx.query<AdmissionRow>(
      'SELECT next_request_at,cooldown_until,quota_blocked_at FROM citevia_provider_admission WHERE scope=$1 FOR UPDATE', [scope],
    )).rows[0];
  }

  async acquire(scope: string, policy: ProviderAdmissionPolicy, quotaDependency?: string): Promise<ProviderAdmission> {
    validateScope(scope);
    if (quotaDependency) validateScope(quotaDependency);
    validatePolicy(policy);
    return this.db.transaction(async tx => {
      // All multi-provider transactions take locks in the same order to avoid deadlocks.
      const rows = new Map<string, AdmissionRow>();
      for (const item of [...new Set([scope, ...(quotaDependency ? [quotaDependency] : [])])].sort())
        rows.set(item, await this.lock(tx, item));
      const now = await this.now(tx), row = rows.get(scope)!;
      await tx.query('DELETE FROM citevia_provider_leases WHERE scope=$1 AND expires_at<=$2', [scope, new Date(now).toISOString()]);
      for (const [blockedScope, state] of rows)
        if (state.quota_blocked_at) return { admitted: false, reason: 'quota', blockedScope };

      const cooldown = millis(row.cooldown_until) - now;
      if (cooldown > 0) return { admitted: false, reason: 'cooldown', retryAfterMs: Math.ceil(cooldown) };
      const spacing = millis(row.next_request_at) - now;
      if (spacing > 0) return { admitted: false, reason: 'spacing', retryAfterMs: Math.ceil(spacing) };
      const leases = await tx.query<{ count: number; expires_at: Date | string | null }>(
        'SELECT count(*)::int AS count,min(expires_at) AS expires_at FROM citevia_provider_leases WHERE scope=$1', [scope],
      );
      if (leases.rows[0].count >= policy.maxConcurrent)
        return { admitted: false, reason: 'concurrency', retryAfterMs: Math.max(1, Math.min(30_000, Math.ceil(millis(leases.rows[0].expires_at!) - now))) };

      const leaseId = randomUUID();
      await tx.query('INSERT INTO citevia_provider_leases(id,scope,expires_at) VALUES($1,$2,$3)',
        [leaseId, scope, new Date(now + policy.leaseMs).toISOString()]);
      await tx.query('UPDATE citevia_provider_admission SET next_request_at=$2,updated_at=$3 WHERE scope=$1',
        [scope, new Date(now + policy.minIntervalMs).toISOString(), new Date(now).toISOString()]);
      return { admitted: true, leaseId };
    });
  }

  async complete(scope: string, leaseId: string, failure?: { kind: 'rate_limit' | 'quota'; retryAfterMs?: number }): Promise<void> {
    validateScope(scope);
    if (failure?.retryAfterMs !== undefined && (!Number.isFinite(failure.retryAfterMs) || failure.retryAfterMs < 0))
      throw new Error('Invalid provider cooldown.');
    await this.db.transaction(async tx => {
      await this.lock(tx, scope);
      const now = await this.now(tx);
      await tx.query('DELETE FROM citevia_provider_leases WHERE id=$1 AND scope=$2', [leaseId, scope]);
      if (failure?.kind === 'quota')
        await tx.query('UPDATE citevia_provider_admission SET quota_blocked_at=coalesce(quota_blocked_at,$2),updated_at=$2 WHERE scope=$1',
          [scope, new Date(now).toISOString()]);
      else if (failure?.kind === 'rate_limit')
        // A later success or shorter Retry-After must never clear another worker's cooldown.
        await tx.query('UPDATE citevia_provider_admission SET cooldown_until=greatest(cooldown_until,$2),updated_at=$3 WHERE scope=$1',
          [scope, new Date(Math.min(MAX_COOLDOWN_AT, now + Math.max(1_000, failure.retryAfterMs ?? 60_000))).toISOString(), new Date(now).toISOString()]);
    });
  }

  async resetQuota(scope: string): Promise<void> {
    validateScope(scope);
    await this.db.transaction(async tx => {
      await this.lock(tx, scope);
      await tx.query("UPDATE citevia_provider_admission SET quota_blocked_at=NULL,cooldown_until='-infinity',updated_at=clock_timestamp() WHERE scope=$1", [scope]);
    });
  }
}
