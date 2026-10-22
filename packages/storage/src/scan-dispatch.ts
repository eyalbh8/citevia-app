import { randomUUID } from 'node:crypto';
import type { ScanProvider } from '@citevia/core';
import type { SqlDatabase, SqlSession } from './sql.js';

export interface ScanDispatchJob {
  projectId: string;
  runId: string;
  promptId: string;
  provider: ScanProvider;
  readyAt: string;
}
export interface ScanDispatchReservation extends ScanDispatchJob { token: string }
export interface ScanDispatchPolicy {
  globalLimit: number;
  accountLimit: number;
  providerLimit: number;
  leaseMs: number;
  limit?: number;
}
export interface ScanDispatchStore {
  /** Idempotently save ready work, without revoking existing reservations or shortening a retry delay. */
  enqueue(jobs: ScanDispatchJob[]): Promise<void>;
  /** Atomically reserve a fair, bounded slice before sending its messages to SQS. */
  claim(policy: ScanDispatchPolicy): Promise<ScanDispatchReservation[]>;
  /** Consume a reservation once. Duplicate and expired SQS deliveries must not start work. */
  start(reservation: ScanDispatchReservation, leaseMs: number): Promise<boolean>;
  complete(reservation: ScanDispatchReservation): Promise<void>;
  defer(reservation: ScanDispatchReservation, readyAt: string, provider?: ScanProvider): Promise<void>;
  /** Call only after the run is authoritatively finalized or cancelled; fences any queued deliveries. */
  discardRun(projectId: string, runId: string): Promise<void>;
}
type ClockOptions = { now?: () => Date };
type DispatchRow = Record<string, unknown> & {
  project_id: string; run_id: string; prompt_id: string; provider: ScanProvider;
  ready_at: Date | string; token: string;
};
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
function validatePolicy(policy: ScanDispatchPolicy): void {
  if (![policy.globalLimit, policy.accountLimit, policy.providerLimit, policy.leaseMs,
    policy.limit ?? policy.globalLimit].every(positiveInteger)) throw Error('Invalid scan dispatch policy.');
}
function validateTime(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw Error('Invalid scan dispatch time.');
}
function validateJobs(jobs: ScanDispatchJob[]): void {
  for (const job of jobs) {
    if (![job.projectId, job.runId, job.promptId].every(value => typeof value === 'string' && value.length > 0) ||
      !['openai', 'gemini', 'perplexity'].includes(job.provider)) throw Error('Invalid scan dispatch job.');
    validateTime(job.readyAt);
  }
}
function reservation(row: DispatchRow): ScanDispatchReservation {
  return { projectId: row.project_id, runId: row.run_id, promptId: row.prompt_id,
    provider: row.provider, readyAt: new Date(row.ready_at).toISOString(), token: row.token };
}
const keyParams = (job: ScanDispatchJob) => [job.projectId, job.runId, job.promptId];

/** All claims share one short transaction lock; no connection is held while sending SQS or doing inference. */
export class SqlScanDispatchStore implements ScanDispatchStore {
  constructor(private readonly db: SqlDatabase, private readonly options: ClockOptions = {}) {}
  private async now(tx: SqlSession): Promise<string> {
    if (this.options.now) return this.options.now().toISOString();
    const result = await tx.query<{ at: string | Date }>('SELECT clock_timestamp() AS at');
    return new Date(result.rows[0].at).toISOString();
  }
  private async lock(tx: SqlSession): Promise<void> {
    await tx.query('SELECT id FROM citevia_dispatch_state WHERE id=1 FOR UPDATE');
  }
  async enqueue(jobs: ScanDispatchJob[]): Promise<void> {
    if (!jobs.length) return;
    validateJobs(jobs);
    // One consistent lock order also prevents competing multi-row enqueue/claim transactions deadlocking.
    await this.db.transaction(async tx => {
      await this.lock(tx);
      await tx.query(`INSERT INTO citevia_dispatch_accounts(project_id)
        SELECT DISTINCT project_id FROM jsonb_to_recordset($1::jsonb) AS j(project_id text)
        ON CONFLICT DO NOTHING`, [JSON.stringify(jobs.map(job => ({ project_id: job.projectId })))]);
      // Callers can reconcile the same prompt repeatedly; do not send it twice or pull a cooldown forward.
      const unique = new Map<string, ScanDispatchJob>();
      for (const job of jobs) {
        const key = JSON.stringify(keyParams(job)), existing = unique.get(key);
        if (!existing || Date.parse(existing.readyAt) < Date.parse(job.readyAt)) unique.set(key, job);
      }
      await tx.query(`INSERT INTO citevia_dispatch_jobs(project_id,run_id,prompt_id,provider,ready_at)
        SELECT project_id,run_id,prompt_id,provider,ready_at
        FROM jsonb_to_recordset($1::jsonb) AS j(project_id text,run_id text,prompt_id text,provider text,ready_at timestamptz)
        ON CONFLICT(project_id,run_id,prompt_id) DO UPDATE
        SET ready_at=greatest(citevia_dispatch_jobs.ready_at,EXCLUDED.ready_at),provider=EXCLUDED.provider
        WHERE citevia_dispatch_jobs.state='ready'`, [JSON.stringify([...unique.values()].map(job => ({
          project_id: job.projectId, run_id: job.runId, prompt_id: job.promptId, provider: job.provider, ready_at: job.readyAt,
        })))]);
    });
  }
  async claim(policy: ScanDispatchPolicy): Promise<ScanDispatchReservation[]> {
    validatePolicy(policy);
    return this.db.transaction(async tx => {
      await this.lock(tx);
      const now = await this.now(tx), leaseUntil = new Date(Date.parse(now) + policy.leaseMs).toISOString();
      await tx.query(`UPDATE citevia_dispatch_jobs SET state='ready',token=NULL,lease_until=NULL,
        ready_at=greatest(ready_at,$1) WHERE state IN ('leased','running') AND lease_until<=$1`, [now]);
      const outstanding = await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM citevia_dispatch_jobs WHERE state IN ('leased','running')");
      const remaining = Math.max(0, Math.min(policy.limit ?? policy.globalLimit, policy.globalLimit - outstanding.rows[0].count));
      const claimed: ScanDispatchReservation[] = [];
      for (let index = 0; index < remaining; index++) {
        const candidate = await tx.query<DispatchRow>(`SELECT j.project_id,j.run_id,j.prompt_id,j.provider,j.ready_at
          FROM citevia_dispatch_jobs j JOIN citevia_dispatch_accounts a ON a.project_id=j.project_id
          WHERE j.state='ready' AND j.ready_at<=$1
            AND NOT EXISTS(SELECT 1 FROM citevia_provider_admission admission
              WHERE admission.scope=j.provider AND admission.cooldown_until>$1)
            AND (SELECT count(*) FROM citevia_dispatch_jobs active
              WHERE active.project_id=j.project_id AND active.state IN ('leased','running'))<$2
            AND (SELECT count(*) FROM citevia_dispatch_jobs active
              WHERE active.provider=j.provider AND active.state IN ('leased','running'))<$3
          ORDER BY a.last_turn,
            (SELECT count(*) FROM citevia_dispatch_jobs active WHERE active.project_id=j.project_id
              AND active.provider=j.provider AND active.state IN ('leased','running')),
            j.ready_at,j.created_at,j.project_id,j.run_id,j.prompt_id LIMIT 1`,
        [now, policy.accountLimit, policy.providerLimit]);
        if (!candidate.rows.length) break;
        const row = candidate.rows[0], token = randomUUID();
        await tx.query(`UPDATE citevia_dispatch_jobs SET state='leased',token=$4,lease_until=$5
          WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3`,
        [row.project_id, row.run_id, row.prompt_id, token, leaseUntil]);
        await tx.query('UPDATE citevia_dispatch_state SET sequence=sequence+1 WHERE id=1');
        await tx.query(`UPDATE citevia_dispatch_accounts SET last_turn=(SELECT sequence FROM citevia_dispatch_state WHERE id=1)
          WHERE project_id=$1`, [row.project_id]);
        claimed.push(reservation({ ...row, token }));
      }
      return claimed;
    });
  }
  async start(job: ScanDispatchReservation, leaseMs: number): Promise<boolean> {
    if (!positiveInteger(leaseMs)) throw Error('Invalid scan dispatch lease.');
    const now = await this.now(this.db), leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = await this.db.query(`UPDATE citevia_dispatch_jobs SET state='running',lease_until=$6
      WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3 AND token=$4 AND state='leased' AND lease_until>$5 RETURNING token`,
    [...keyParams(job), job.token, now, leaseUntil]);
    return result.rows.length === 1;
  }
  async complete(job: ScanDispatchReservation): Promise<void> {
    await this.db.query(`DELETE FROM citevia_dispatch_jobs
      WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3 AND token=$4`, [...keyParams(job), job.token]);
  }
  async defer(job: ScanDispatchReservation, readyAt: string, provider?: ScanProvider): Promise<void> {
    validateTime(readyAt);
    if (provider && !['openai', 'gemini', 'perplexity'].includes(provider)) throw Error('Invalid scan dispatch provider.');
    await this.db.query(`UPDATE citevia_dispatch_jobs SET state='ready',token=NULL,lease_until=NULL,ready_at=$5,
      provider=coalesce($6,provider)
      WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3 AND token=$4`, [...keyParams(job), job.token, readyAt, provider ?? null]);
  }
  async discardRun(projectId: string, runId: string): Promise<void> {
    await this.db.query('DELETE FROM citevia_dispatch_jobs WHERE project_id=$1 AND run_id=$2', [projectId, runId]);
  }
}

interface MemoryJob extends ScanDispatchJob { state: 'ready' | 'leased' | 'running'; token?: string; leaseUntil?: number; order: number }
const jobKey = (job: ScanDispatchJob) => JSON.stringify(keyParams(job));
/** Deterministic adapter for local development and scanner tests; production uses SQL persistence. */
export class MemoryScanDispatchStore implements ScanDispatchStore {
  private readonly jobs = new Map<string, MemoryJob>();
  private readonly turns = new Map<string, number>();
  private sequence = 0;
  private order = 0;
  constructor(private readonly options: ClockOptions = {}) {}
  private now() { return (this.options.now?.() ?? new Date()).getTime(); }
  async enqueue(jobs: ScanDispatchJob[]): Promise<void> {
    validateJobs(jobs);
    for (const job of jobs) {
      const key = jobKey(job), existing = this.jobs.get(key);
      if (!this.turns.has(job.projectId)) this.turns.set(job.projectId, 0);
      if (!existing) this.jobs.set(key, { ...job, state: 'ready', order: this.order++ });
      else if (existing.state === 'ready') {
        if (Date.parse(job.readyAt) > Date.parse(existing.readyAt)) existing.readyAt = job.readyAt;
        existing.provider = job.provider;
      }
    }
  }
  async claim(policy: ScanDispatchPolicy): Promise<ScanDispatchReservation[]> {
    validatePolicy(policy);
    const now = this.now();
    for (const job of this.jobs.values()) if (job.state !== 'ready' && job.leaseUntil! <= now) {
      job.state = 'ready'; delete job.token; delete job.leaseUntil;
      job.readyAt = new Date(Math.max(Date.parse(job.readyAt), now)).toISOString();
    }
    const active = [...this.jobs.values()].filter(job => job.state !== 'ready');
    const claimed: ScanDispatchReservation[] = [];
    const remaining = Math.max(0, Math.min(policy.limit ?? policy.globalLimit, policy.globalLimit - active.length));
    for (let index = 0; index < remaining; index++) {
      const candidate = [...this.jobs.values()].filter(job => job.state === 'ready' && Date.parse(job.readyAt) <= now &&
        active.filter(other => other.projectId === job.projectId).length < policy.accountLimit &&
        active.filter(other => other.provider === job.provider).length < policy.providerLimit)
        .sort((a, b) => this.turns.get(a.projectId)! - this.turns.get(b.projectId)! ||
          active.filter(other => other.projectId === a.projectId && other.provider === a.provider).length -
          active.filter(other => other.projectId === b.projectId && other.provider === b.provider).length || Date.parse(a.readyAt) - Date.parse(b.readyAt) ||
          a.order - b.order || a.projectId.localeCompare(b.projectId) || a.runId.localeCompare(b.runId) || a.promptId.localeCompare(b.promptId))[0];
      if (!candidate) break;
      candidate.state = 'leased'; candidate.token = randomUUID(); candidate.leaseUntil = now + policy.leaseMs;
      this.turns.set(candidate.projectId, ++this.sequence); active.push(candidate);
      claimed.push({ projectId: candidate.projectId, runId: candidate.runId, promptId: candidate.promptId,
        provider: candidate.provider, readyAt: candidate.readyAt, token: candidate.token });
    }
    return claimed;
  }
  async start(job: ScanDispatchReservation, leaseMs: number): Promise<boolean> {
    if (!positiveInteger(leaseMs)) throw Error('Invalid scan dispatch lease.');
    const saved = this.jobs.get(jobKey(job)), now = this.now();
    if (!saved || saved.state !== 'leased' || saved.token !== job.token || saved.leaseUntil! <= now) return false;
    saved.state = 'running'; saved.leaseUntil = now + leaseMs;
    return true;
  }
  async complete(job: ScanDispatchReservation): Promise<void> {
    if (this.jobs.get(jobKey(job))?.token === job.token) this.jobs.delete(jobKey(job));
  }
  async defer(job: ScanDispatchReservation, readyAt: string, provider?: ScanProvider): Promise<void> {
    validateTime(readyAt);
    if (provider && !['openai', 'gemini', 'perplexity'].includes(provider)) throw Error('Invalid scan dispatch provider.');
    const saved = this.jobs.get(jobKey(job));
    if (saved?.token !== job.token) return;
    saved.state = 'ready'; saved.readyAt = readyAt; delete saved.token; delete saved.leaseUntil;
    if (provider) saved.provider = provider;
  }
  async discardRun(projectId: string, runId: string): Promise<void> {
    for (const [key, job] of this.jobs) if (job.projectId === projectId && job.runId === runId) this.jobs.delete(key);
  }
}
