import type { Usage } from '@citevia/core';
import type { SqlDatabase } from './sql.js';
import type { ArtifactStore } from './contracts.js';

export interface ProviderCallIntent {
  id: string;
  projectId?: string;
  runId?: string;
  promptId?: string;
  attempt?: number;
  stage: string;
  provider: string;
  model: string;
  mode: 'realtime' | 'batch';
  createdAt: string;
  /** Conservative reservation; null means the model/tools are not priced. */
  reservedUsd: number | null;
  priceVersion: string;
}
export interface ProviderCallOutcome {
  status: 'succeeded' | 'failed' | 'uncertain';
  completedAt: string;
  model?: string;
  requestId?: string | null;
  usage?: Usage;
  estimatedUsd: number | null;
  errorCode?: string;
}
export interface CallLedger {
  reserve(intent: ProviderCallIntent, monthlyBudgetUsd?: number, globalMonthlyBudgetUsd?: number): Promise<void>;
  settle(callId: string, outcome: ProviderCallOutcome): Promise<void>;
}
export class CostBudgetError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string) { super(message); }
}

/** Append-only metadata, never prompts, answers, credentials or provider error bodies. */
export class PostgresCallLedger implements CallLedger {
  private readonly staged = new Set<string>();
  constructor(private readonly db: SqlDatabase, private readonly fallbackArtifacts?: ArtifactStore) {}
  async reserve(intent: ProviderCallIntent, monthlyBudgetUsd = 0, globalMonthlyBudgetUsd = 0): Promise<void> {
    if (intent.reservedUsd !== null && (!Number.isFinite(intent.reservedUsd) || intent.reservedUsd < 0))
      throw new CostBudgetError('cost_reservation_invalid', 'Provider cost reservation must be nonnegative.');
    try { await this.db.transaction(async tx => {
      if (![monthlyBudgetUsd, globalMonthlyBudgetUsd].every(value => Number.isFinite(value) && value >= 0))
        throw new CostBudgetError('cost_budget_invalid', 'Provider budgets must be nonnegative numbers.');
      if (globalMonthlyBudgetUsd > 0) {
        if (intent.reservedUsd === null) throw new CostBudgetError('cost_unpriced_request', 'A priced request is required when a global cost budget is enabled.');
        // All workers take this lock before account locks, preventing cross-account overspend/deadlocks.
        await tx.query('SELECT pg_advisory_xact_lock(719340205)');
        const { rows } = await tx.query(
          `SELECT coalesce(sum(coalesce((outcome.data->>'estimatedUsd')::numeric,
                     (reservation.data->>'reservedUsd')::numeric)),0) AS spent
           FROM citevia_cost_events reservation
           LEFT JOIN citevia_cost_events outcome ON outcome.call_id=reservation.call_id AND outcome.phase='outcome'
           WHERE reservation.phase='reservation'
             AND reservation.created_at >= date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND reservation.created_at < (date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
             AND reservation.call_id<>$2`, [intent.createdAt, intent.id]);
        if (Number(rows[0].spent) + intent.reservedUsd > globalMonthlyBudgetUsd)
          throw new CostBudgetError('cost_global_budget_exceeded', 'The service has reached its configured monthly estimated provider budget.');
      }
      if (monthlyBudgetUsd > 0) {
        if (!intent.projectId || intent.reservedUsd === null)
          throw new CostBudgetError('cost_unpriced_request', 'A priced account-scoped request is required when a cost budget is enabled.');
        // All concurrent admissions for this account serialize before summing reservations.
        const account = await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [intent.projectId]);
        if (!account.rows.length) throw new CostBudgetError('cost_account_missing', 'The provider budget account was not found.');
        const { rows } = await tx.query(
          `SELECT coalesce(sum(coalesce((outcome.data->>'estimatedUsd')::numeric,
                     (reservation.data->>'reservedUsd')::numeric)),0) AS spent
           FROM citevia_cost_events reservation
           LEFT JOIN citevia_cost_events outcome ON outcome.call_id=reservation.call_id AND outcome.phase='outcome'
           WHERE reservation.phase='reservation' AND reservation.project_id=$1
             AND reservation.created_at >= date_trunc('month',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND reservation.created_at < (date_trunc('month',$2::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
             AND reservation.call_id<>$3`, [intent.projectId, intent.createdAt, intent.id]);
        if (Number(rows[0].spent) + intent.reservedUsd > monthlyBudgetUsd)
          throw new CostBudgetError('cost_budget_exceeded', 'The account has reached its configured monthly estimated provider budget.');
      }
      await tx.query(
        `INSERT INTO citevia_cost_events(call_id,phase,project_id,created_at,data)
         VALUES($1,'reservation',$2,$3,$4::jsonb) ON CONFLICT(call_id,phase) DO NOTHING`,
        [intent.id, intent.projectId || null, intent.createdAt, JSON.stringify(intent)]);
    }); } catch(error) {
      // During the additive deploy, old workers may still run before013. Preserve
      // attempt metadata in the private evidence store rather than failing scans.
      // Configured budgets require the SQL admission lock and therefore fail closed.
      if ((error as {code?:string}).code !== '42P01' || !this.fallbackArtifacts || monthlyBudgetUsd>0 || globalMonthlyBudgetUsd>0) throw error;
      await this.fallbackArtifacts.put(`provider-costs/${intent.id}/reservation.json`,intent);
      this.staged.add(intent.id);
    }
  }
  async settle(callId: string, outcome: ProviderCallOutcome): Promise<void> {
    if(this.staged.has(callId)) {
      await this.fallbackArtifacts!.put(`provider-costs/${callId}/outcome.json`,outcome);
      this.staged.delete(callId);
      return;
    }
    await this.db.query(
      `INSERT INTO citevia_cost_events(call_id,phase,project_id,created_at,data)
       SELECT call_id,'outcome',project_id,$2,$3::jsonb FROM citevia_cost_events
       WHERE call_id=$1 AND phase='reservation' ON CONFLICT(call_id,phase) DO NOTHING`,
      [callId, outcome.completedAt, JSON.stringify(outcome)]);
  }
}

export class MemoryCallLedger implements CallLedger {
  readonly calls = new Map<string, { intent: ProviderCallIntent; outcome?: ProviderCallOutcome }>();
  async reserve(intent: ProviderCallIntent, monthlyBudgetUsd = 0, globalMonthlyBudgetUsd = 0): Promise<void> {
    if (intent.reservedUsd !== null && (!Number.isFinite(intent.reservedUsd) || intent.reservedUsd < 0))
      throw new CostBudgetError('cost_reservation_invalid', 'Provider cost reservation must be nonnegative.');
    if (this.calls.has(intent.id)) return;
    if (![monthlyBudgetUsd, globalMonthlyBudgetUsd].every(value => Number.isFinite(value) && value >= 0))
      throw new CostBudgetError('cost_budget_invalid', 'Provider budgets must be nonnegative numbers.');
    if (globalMonthlyBudgetUsd > 0) {
      if (intent.reservedUsd === null) throw new CostBudgetError('cost_unpriced_request', 'A priced request is required when a global cost budget is enabled.');
      const spent = [...this.calls.values()].filter(c => c.intent.createdAt.startsWith(intent.createdAt.slice(0, 7)))
        .reduce((sum, c) => sum + (c.outcome?.estimatedUsd ?? c.intent.reservedUsd ?? 0), 0);
      if (spent + intent.reservedUsd > globalMonthlyBudgetUsd)
        throw new CostBudgetError('cost_global_budget_exceeded', 'The service has reached its configured monthly estimated provider budget.');
    }
    if (monthlyBudgetUsd > 0) {
      if (!intent.projectId || intent.reservedUsd === null) throw new CostBudgetError('cost_unpriced_request', 'A priced account-scoped request is required when a cost budget is enabled.');
      const month = intent.createdAt.slice(0, 7);
      const spent = [...this.calls.values()].filter(c => c.intent.projectId === intent.projectId && c.intent.createdAt.startsWith(month))
        .reduce((sum,c) => sum + (c.outcome?.estimatedUsd ?? c.intent.reservedUsd ?? 0), 0);
      if (spent + intent.reservedUsd > monthlyBudgetUsd) throw new CostBudgetError('cost_budget_exceeded', 'The account has reached its configured monthly estimated provider budget.');
    }
    this.calls.set(intent.id, { intent: structuredClone(intent) });
  }
  async settle(callId: string, outcome: ProviderCallOutcome): Promise<void> {
    const call = this.calls.get(callId);
    if (call && !call.outcome) call.outcome = structuredClone(outcome);
  }
}

/** Estimates and unresolved reservations are separate; neither is a provider invoice. */
export async function summarizeProviderCosts(db: SqlDatabase, options: { start: string; end: string; projectId?: string }) {
  if (!Number.isFinite(Date.parse(options.start)) || !Number.isFinite(Date.parse(options.end)) || Date.parse(options.start)>=Date.parse(options.end))
    throw new Error('Cost report needs a valid start before its exclusive end.');
  const {rows} = await db.query(`SELECT reservation.project_id,
    reservation.data->>'provider' AS provider,reservation.data->>'model' AS requested_model,
    reservation.data->>'stage' AS stage,reservation.data->>'mode' AS mode,
    count(*)::int AS attempts,
    count(*) FILTER(WHERE outcome.data->>'status'='succeeded')::int AS succeeded,
    count(*) FILTER(WHERE outcome.call_id IS NULL OR outcome.data->>'status'='uncertain')::int AS unresolved,
    count(*) FILTER(WHERE outcome.data->>'estimatedUsd' IS NULL AND reservation.data->>'reservedUsd' IS NULL)::int AS unpriced,
    coalesce(sum((outcome.data->>'estimatedUsd')::numeric),0)::text AS estimated_completed_usd,
    coalesce(sum(CASE WHEN outcome.data->>'estimatedUsd' IS NULL THEN (reservation.data->>'reservedUsd')::numeric ELSE 0 END),0)::text AS outstanding_reserved_usd,
    coalesce(sum((outcome.data->'usage'->>'inputTokens')::bigint),0)::text AS input_tokens,
    coalesce(sum((outcome.data->'usage'->>'outputTokens')::bigint),0)::text AS output_tokens,
    coalesce(sum((outcome.data->'usage'->>'cachedInputTokens')::bigint),0)::text AS cached_input_tokens,
    coalesce(sum((outcome.data->'usage'->>'reasoningTokens')::bigint),0)::text AS reasoning_tokens,
    coalesce(sum((outcome.data->'usage'->>'imageInputTokens')::bigint),0)::text AS image_input_tokens
    FROM citevia_cost_events reservation LEFT JOIN citevia_cost_events outcome
      ON outcome.call_id=reservation.call_id AND outcome.phase='outcome'
    WHERE reservation.phase='reservation' AND reservation.created_at >= $1::timestamptz
      AND reservation.created_at < $2::timestamptz AND ($3::text IS NULL OR reservation.project_id=$3)
    GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`, [options.start,options.end,options.projectId || null]);
  return {start:options.start,endExclusive:options.end,projectId:options.projectId,rows,
    note:'Estimated completed charges and outstanding reservations are not billed totals. Unpriced or uncertain calls require invoice reconciliation. Google search estimates exclude free credits.'};
}


/** Policy reconciliation only: shared infrastructure allocations must be supplied explicitly. */
export function accountCostPolicyReport(report: Awaited<ReturnType<typeof summarizeProviderCosts>>, policy: {
  accountMonthlyBudgetUsd: number; infrastructureReserveUsd: number; aiMonthlyBudgetUsd: number;
  allocatedNonAiUsd?: Record<string, number>;
}) {
  const { accountMonthlyBudgetUsd: total, infrastructureReserveUsd: reserve, aiMonthlyBudgetUsd: ai } = policy;
  if (![total, reserve, ai].every(n => Number.isFinite(n) && n >= 0) || total <= reserve)
    throw new Error('Account budget must exceed a nonnegative infrastructure reserve; AI budget must be nonnegative.');
  for (const value of Object.values(policy.allocatedNonAiUsd ?? {}))
    if (!Number.isFinite(value) || value < 0) throw new Error('Non-AI allocations must be nonnegative amounts in USD.');
  const start = new Date(report.start), end = new Date(report.endExclusive);
  const calendarMonth = start.toISOString() === new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)).toISOString() &&
    end.toISOString() === new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
  const effectiveAi = ai > 0 ? Math.min(ai, total - reserve) : total - reserve;
  const accounts = new Map<string | null, { projectId: string | null; aiCompletedEstimatedUsd: number; aiOutstandingReservedUsd: number; aiUnpricedCalls: number; aiUnresolvedCalls: number }>();
  for (const row of report.rows) {
    const projectId = typeof row.project_id === 'string' ? row.project_id : null;
    const account = accounts.get(projectId) ?? { projectId, aiCompletedEstimatedUsd: 0, aiOutstandingReservedUsd: 0, aiUnpricedCalls: 0, aiUnresolvedCalls: 0 };
    account.aiCompletedEstimatedUsd += Number(row.estimated_completed_usd);
    account.aiOutstandingReservedUsd += Number(row.outstanding_reserved_usd);
    account.aiUnpricedCalls += Number(row.unpriced); account.aiUnresolvedCalls += Number(row.unresolved);
    accounts.set(projectId, account);
  }
  for (const projectId of new Set([...Object.keys(policy.allocatedNonAiUsd ?? {}), ...(report.projectId ? [report.projectId] : [])]))
    if (!accounts.has(projectId)) accounts.set(projectId, { projectId, aiCompletedEstimatedUsd: 0, aiOutstandingReservedUsd: 0, aiUnpricedCalls: 0, aiUnresolvedCalls: 0 });
  return { calendarMonth, accountMonthlyBudgetUsd: total, infrastructureReserveUsd: reserve, effectiveAiMonthlyBudgetUsd: effectiveAi,
    accounts: [...accounts.values()].map(account => {
      const committed = account.aiCompletedEstimatedUsd + account.aiOutstandingReservedUsd;
      const allocation = account.projectId === null ? undefined : policy.allocatedNonAiUsd?.[account.projectId];
      const known = allocation !== undefined && account.aiUnpricedCalls === 0;
      return { ...account, aiAdmissionCommittedUsd: committed,
        remainingMonthlyAiAdmissionUsd: calendarMonth && account.projectId !== null ? Math.max(0, effectiveAi - committed) : null,
        allocatedNonAiUsd: allocation ?? null,
        estimatedTotalIncludingPendingUsd: known ? committed + allocation : null,
        estimatedPolicyOverageUsd: known ? Math.max(0, committed + allocation - total) : null,
        allInInvoiceComplianceVerified: false };
    }),
    note: 'AI charges are estimates or provider-reported costs; pending holds are not invoices. The infrastructure reserve is an allocation policy, not measured expenditure. All-in totals require explicit non-AI allocations and remain estimates; reconcile provider, database, storage and API invoices. Remaining monthly admission is shown only for a full UTC calendar month.' };
}
