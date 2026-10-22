import type { SqlDatabase } from './sql.js';

export type AnalysisBatchState = 'prepared' | 'creating' | 'submission_uncertain' | 'submitted' | 'resolved' | 'processed';
export interface AnalysisBatchRecord {
  id: string;
  projectId: string;
  runId: string;
  version: number;
  status: AnalysisBatchState;
  inputKey: string;
  outputKey?: string;
  inputFileId?: string;
  providerBatchId?: string;
  providerStatus?: string;
  /** Persisted before the paid create request, so ambiguous submissions retain a fixed recovery window. */
  submissionAttemptedAt?: string;
  /** Provider creation time, or the local submission time when recovering older API responses. */
  submittedAt?: string;
  /** Full provider processing window plus import/polling allowance, independent of collection wait. */
  processingDeadlineAt?: string;
  leaseExpiresAt?: string;
  nextPollAt?: string;
  /** Definite create rejections can be retried up to three times; uncertain creates cannot. */
  submitAttempts?: number;
  uploadFailures?: number;
  pollFailures?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}
export interface AnalysisBatchStore {
  get(id: string): Promise<AnalysisBatchRecord | null>;
  open(projectId: string, runId: string): Promise<AnalysisBatchRecord | null>;
  create(record: AnalysisBatchRecord): Promise<boolean>;
  save(record: AnalysisBatchRecord, expectedVersion: number): Promise<boolean>;
}
export class SqlAnalysisBatchStore implements AnalysisBatchStore {
  constructor(private readonly db: SqlDatabase) {}
  async get(id: string): Promise<AnalysisBatchRecord | null> {
    const result = await this.db.query('SELECT data FROM citevia_analysis_batches WHERE id=$1', [id]);
    return result.rows[0]?.data as AnalysisBatchRecord ?? null;
  }
  async open(projectId: string, runId: string): Promise<AnalysisBatchRecord | null> {
    const result = await this.db.query("SELECT data FROM citevia_analysis_batches WHERE project_id=$1 AND run_id=$2 AND status <> 'processed' LIMIT 1", [projectId, runId]);
    return result.rows[0]?.data as AnalysisBatchRecord ?? null;
  }
  async create(record: AnalysisBatchRecord): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO citevia_analysis_batches(id,project_id,run_id,version,status,data,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7)) ON CONFLICT DO NOTHING RETURNING id`,
    [record.id, record.projectId, record.runId, record.version, record.status, JSON.stringify(record), record.expiresAt]);
    return result.rows.length === 1;
  }
  async save(record: AnalysisBatchRecord, expectedVersion: number): Promise<boolean> {
    if (record.version !== expectedVersion + 1) throw new Error('Batch updates require the next version.');
    const result = await this.db.query(`UPDATE citevia_analysis_batches SET version=$3,status=$4,data=$5::jsonb,updated_at=now()
      WHERE id=$1 AND version=$2 RETURNING id`, [record.id, expectedVersion, record.version, record.status, JSON.stringify(record)]);
    return result.rows.length === 1;
  }
}
