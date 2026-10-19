import { randomUUID, createHash } from 'node:crypto';
import { ZodError } from 'zod';
import {
  buildSummary,
  emptyMetrics,
  identifier,
  metricsFromResults,
  nextWeeklyScan,
  promptCreateSchema,
  promptUpdateSchema,
  promptFingerprint,
  sameCohort,
  sameMethod,
  settingsSchema,
  type Analysis,
  type CapturedAnswer,
  type Dashboard,
  type Page,
  type Project,
  type PromptResult,
  type ResponseDetail,
  type RunSummary,
  type ScanRun,
  type SourceRow,
} from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import { runIdFor } from '../../scanner/src/engine.js';
import { brandbookUpdateSchema } from '@citevia/core';
import { createAccounts } from './onboarding.js';

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ApiOptions {
  auth: 'local' | 'aws';
  mode: 'live';
  providerConfigured?: boolean;
  syncSchedule?: (project: Project) => Promise<void>;
  now?: () => Date;
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

export function createApi(runtime: Runtime, options: ApiOptions) {
  const { repository, artifacts, queue } = runtime;
  const now = options.now || (() => new Date());
  async function body(request: Request): Promise<unknown> {
    const raw = await request.text();
    if (raw.length > 150000)
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request is too large');
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON request body');
    }
  }
  async function details(
    result: PromptResult,
    run: ScanRun,
  ): Promise<ResponseDetail> {
    const [answer, analysis] = await Promise.all([
      result.captureKey
        ? artifacts.get<CapturedAnswer>(result.captureKey)
        : null,
      result.analysisKey ? artifacts.get<Analysis>(result.analysisKey) : null,
    ]);
    return { result, run, answer, analysis };
  }
  async function summary(run: ScanRun): Promise<RunSummary> {
    if (run.summaryKey && run.summaryVersion === run.resultVersion) {
      const saved = await artifacts.get<RunSummary>(run.summaryKey);
      if (saved) return saved;
    }
    const results = await repository.listResults(run.projectId, run.id);
    const items: ResponseDetail[] = [];
    // Small batches bound S3 fan-out for unfinished runs.
    for (let i = 0; i < results.length; i += 5)
      items.push(
        ...(await Promise.all(
          results.slice(i, i + 5).map((result) => details(result, run)),
        )),
      );
    return buildSummary(run, results, items);
  }
  function paging(query: URLSearchParams) {
    const raw = query.get('cursor');
    let offset = 0;
    if (raw) {
      try {
        const decoded = Buffer.from(raw, 'base64url').toString();
        if (
          !/^(0|[1-9][0-9]*)$/.test(decoded) ||
          Buffer.from(decoded).toString('base64url') !== raw
        )
          throw new Error('Invalid cursor');
        offset = Number(decoded);
      } catch {
        throw new HttpError(400, 'INVALID_CURSOR', 'Invalid cursor');
      }
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new HttpError(400, 'INVALID_CURSOR', 'Invalid cursor');
    const limit = Number(query.get('limit') || '50');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(
        400,
        'INVALID_LIMIT',
        'Limit must be between 1 and 100',
      );
    return { offset, limit };
  }
  function paginate<T>(items: T[], query: URLSearchParams): Page<T> {
    const { offset, limit } = paging(query);
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      nextCursor:
        offset + limit < items.length
          ? Buffer.from(String(offset + limit)).toString('base64url')
          : null,
    };
  }
  async function persistProject(project: Project, previousVersion: number) {
    if (Buffer.byteLength(JSON.stringify(project), 'utf8') > 300000)
      throw new HttpError(
        400,
        'CONFIG_TOO_LARGE',
        'Project configuration is too large. Shorten prompt text or aliases.',
      );
    if (!(await repository.saveProject(project, previousVersion)))
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'Settings changed. Refresh and try again.',
      );
  }
  return async (
    request: Request,
    identity?: { userId: string },
  ): Promise<Response> => {
    try {
      const url = new URL(request.url),
        query = url.searchParams,
        method = request.method.toUpperCase();
      const path = url.pathname.replace(/\/$/, '');
      if (path === '/health' && method === 'GET')
        return response({ status: 'ok', service: 'citevia-api' });
      let userId = identity?.userId;
      if (options.auth === 'local') {
        if (process.env.AWS_LAMBDA_FUNCTION_NAME)
          throw new HttpError(
            500,
            'INVALID_AUTH_CONFIGURATION',
            'Local authentication is disabled in Lambda',
          );
        if (request.headers.get('authorization') !== 'Bearer local-development')
          throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        userId = 'local-user';
      }
      if (!userId)
        throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (path === '/v1/runtime' && method === 'GET')
        return response({
          providerConfigured: options.providerConfigured !== false,
          mode: 'live',
        });
      if (
        options.providerConfigured === false &&
        method === 'POST' &&
        (path === '/v1/onboarding/accounts' ||
          /\/(runs|onboarding\/retry|retry-failed)$/.test(path))
      )
        throw new HttpError(
          503,
          'OPENAI_NOT_CONFIGURED',
          'Configure OPENAI_API_KEY or OPENAI_SECRET_ARN in .env and restart the local server to enable generation and scans.',
        );
      if (path === '/v1/projects' && method === 'GET') {
        const q = query.get('q') || '';
        if (q.length > 200)
          throw new HttpError(
            400,
            'INVALID_FILTER',
            'Account search must be at most 200 characters',
          );
        return response({
          ...(await repository.listProjectSummaries(userId, {
            ...paging(query),
            query: q,
          })),
          mode: options.mode,
        });
      }
      if (path === '/v1/onboarding/accounts' && method === 'POST') {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
          throw new HttpError(
            400,
            'IDEMPOTENCY_REQUIRED',
            'Supply an Idempotency-Key header',
          );
        try {
          const result = await createAccounts(
            runtime,
            userId,
            key,
            await body(request),
            now(),
            Number(process.env.MAX_ACCOUNTS_PER_OWNER || 100),
          );
          return response(result, result.limitReached ? 207 : 202);
        } catch (error) {
          if ((error as { status?: number }).status === 409)
            throw new HttpError(
              409,
              'IDEMPOTENCY_CONFLICT',
              (error as Error).message,
            );
          throw error;
        }
      }
      const match = path.match(/^\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
      const projectId = identifier.parse(decodeURIComponent(match[1])),
        tail = match[2] || '';
      const member = await repository.getMembership(projectId, userId);
      if (!member) throw new HttpError(404, 'NOT_FOUND', 'Project not found');
      const stored = await repository.getProject(projectId);
      if (!stored) throw new HttpError(404, 'NOT_FOUND', 'Project not found');
      const project = { ...stored, role: member.role };
      if (!['GET', 'HEAD'].includes(method) && member.role !== 'owner')
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Project owner access is required',
        );
      const selectedRun = async (id?: string): Promise<ScanRun> => {
        const runId = id || query.get('runId');
        const run = runId
          ? await repository.getRun(projectId, identifier.parse(runId))
          : (await repository.listRuns(projectId, 1))[0];
        if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'No scan found');
        return run;
      };
      if (tail === 'settings' && method === 'GET') return response(project);
      if (tail === 'onboarding' && method === 'GET')
        return response({
          job: stored.onboardingJobId
            ? await repository.getOnboarding(projectId, stored.onboardingJobId)
            : null,
        });
      if (tail === 'onboarding/retry' && method === 'POST') {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
          throw new HttpError(
            400,
            'IDEMPOTENCY_REQUIRED',
            'Supply an Idempotency-Key header',
          );
        const job = stored.onboardingJobId
          ? await repository.getOnboarding(projectId, stored.onboardingJobId)
          : null;
        if (!job)
          throw new HttpError(404, 'NOT_FOUND', 'Onboarding job not found');
        if (job.retryRequestIds.includes(key)) {
          await queue.send([{ kind: 'onboard', projectId, jobId: job.id }]);
          return response({ job }, 202);
        }
        if (job.status !== 'failed')
          throw new HttpError(
            409,
            'ONBOARDING_ACTIVE',
            'This account is already being set up or is ready',
          );
        if (job.retryRequestIds.length >= 8)
          throw new HttpError(
            400,
            'RETRY_LIMIT',
            'Account setup reached its retry limit. Contact your administrator.',
          );
        const next = {
          ...job,
          status: 'queued' as const,
          attempts: 0,
          version: job.version + 1,
          deadlineAt: new Date(now().getTime() + 86400000).toISOString(),
          retryRequestIds: [...job.retryRequestIds, key],
          error: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        };
        if (!(await repository.saveOnboarding(next, job.version)))
          throw new HttpError(
            409,
            'VERSION_CONFLICT',
            'Account setup changed. Refresh and retry',
          );
        await queue.send([{ kind: 'onboard', projectId, jobId: job.id }]);
        return response({ job: next }, 202);
      }
      if (tail === 'brandbook' && method === 'GET')
        return response({
          brandbook: stored.brandbook || null,
          version: stored.version,
          role: member.role,
        });
      if (tail === 'brandbook' && method === 'PATCH') {
        if (!stored.brandbook)
          throw new HttpError(
            409,
            'BRANDBOOK_MISSING',
            'Complete account setup first',
          );
        const { version, ...input } = brandbookUpdateSchema.parse(
          await body(request),
        );
        if (version !== stored.version)
          throw new HttpError(
            409,
            'VERSION_CONFLICT',
            'The account changed. Refresh before saving',
          );
        const brandbook = {
          ...stored.brandbook,
          ...input,
          version: stored.brandbook.version + 1,
        };
        await persistProject(
          {
            ...stored,
            brandbook,
            brand: {
              ...stored.brand,
              aliases: input.names
                .filter((name) => name !== stored.brand.name)
                .slice(0, 20),
            },
            version: stored.version + 1,
            updatedAt: now().toISOString(),
          },
          stored.version,
        );
        return response({
          brandbook,
          version: stored.version + 1,
          role: member.role,
        });
      }
      if (tail === 'settings' && method === 'PATCH') {
        const input = settingsSchema.parse(await body(request));
        if (input.version !== stored.version)
          throw new HttpError(
            409,
            'VERSION_CONFLICT',
            'Settings changed. Refresh and try again.',
          );
        const next = {
          ...stored,
          ...input,
          version: stored.version + 1,
          updatedAt: now().toISOString(),
          scheduleStatus: 'pending' as const,
        };
        if (
          new Set([next.brand.id, ...next.competitors.map((b) => b.id)])
            .size !==
          next.competitors.length + 1
        )
          throw new HttpError(
            400,
            'DUPLICATE_BRAND',
            'Brand identifiers must be unique',
          );
        await persistProject(next, stored.version);
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            const latest = await repository.getProject(projectId);
            if (!latest) throw new Error('Project missing');
            await options.syncSchedule?.(latest);
            const synced = {
              ...latest,
              scheduleStatus: 'synced' as const,
              version: latest.version + 1,
            };
            if (await repository.saveProject(synced, latest.version))
              return response({ ...synced, role: member.role });
            // A newer settings write won the race. Apply that version to AWS before reporting success.
          }
          throw new Error('Concurrent schedule updates');
        } catch {
          const latest = await repository.getProject(projectId);
          if (latest)
            await repository.saveProject(
              {
                ...latest,
                scheduleStatus: 'error',
                version: latest.version + 1,
              },
              latest.version,
            );
          throw new HttpError(
            503,
            'SCHEDULE_SYNC_FAILED',
            'Settings saved, but the weekly schedule could not be updated. Save again to retry.',
          );
        }
      }
      if (
        /^prompts(?:\/[^/]+)?$/.test(tail) &&
        ['POST', 'PATCH', 'DELETE'].includes(method) &&
        stored.onboardingJobId &&
        !stored.onboardingAppliedJobId
      )
        throw new HttpError(
          409,
          'ONBOARDING_PENDING',
          'Finish account setup in Accounts before changing prompts.',
        );
      if (tail === 'prompts' && method === 'GET')
        return response({ items: stored.prompts, version: stored.version });
      if (tail === 'prompts' && method === 'POST') {
        const input = promptCreateSchema.parse(await body(request));
        const texts = 'texts' in input ? input.texts : [input.text];
        const active = stored.prompts.filter((p) => p.active);
        if (active.length + texts.length > 50)
          throw new HttpError(
            400,
            'PROMPT_LIMIT',
            'A project can have at most 50 active prompts',
          );
        const known = new Set(active.map((p) => promptFingerprint(p.text)));
        for (const text of texts) {
          if (known.has(promptFingerprint(text)))
            throw new HttpError(
              400,
              'DUPLICATE_PROMPT',
              'This prompt is already active',
            );
          known.add(promptFingerprint(text));
        }
        const at = now().toISOString();
        const added = texts.map((text) => ({
          id: `p_${randomUUID().replaceAll('-', '')}`,
          text,
          version: 1,
          active: true,
          branded: !!input.branded,
          ...('stage' in input ? { stage: input.stage } : {}),
          topic: input.topic || undefined,
          createdAt: at,
          updatedAt: at,
        }));
        // Archived prompt history lives in immutable run snapshots; bound config item growth.
        const retained = stored.prompts
          .filter((p) => p.active)
          .concat(stored.prompts.filter((p) => !p.active).slice(-50));
        const next = {
          ...stored,
          prompts: [...retained, ...added],
          version: stored.version + 1,
          updatedAt: at,
        };
        await persistProject(next, stored.version);
        return response({ items: added, version: next.version }, 201);
      }
      const promptMatch = tail.match(/^prompts\/([^/]+)$/);
      if (promptMatch && ['PATCH', 'DELETE'].includes(method)) {
        const id = identifier.parse(promptMatch[1]),
          current = stored.prompts.find((p) => p.id === id);
        if (!current) throw new HttpError(404, 'NOT_FOUND', 'Prompt not found');
        const input =
          method === 'DELETE'
            ? { active: false }
            : promptUpdateSchema.parse(await body(request));
        if ('version' in input && input.version !== current.version)
          throw new HttpError(
            409,
            'VERSION_CONFLICT',
            'This prompt changed. Refresh before saving.',
          );
        const updated = {
          ...current,
          ...input,
          version: current.version + 1,
          updatedAt: now().toISOString(),
        };
        const prompts = stored.prompts.map((p) => (p.id === id ? updated : p));
        if (prompts.filter((p) => p.active).length > 50)
          throw new HttpError(
            400,
            'PROMPT_LIMIT',
            'A project can have at most 50 active prompts',
          );
        if (
          updated.active &&
          prompts.some(
            (p) =>
              p.id !== id &&
              p.active &&
              promptFingerprint(p.text) === promptFingerprint(updated.text),
          )
        )
          throw new HttpError(
            400,
            'DUPLICATE_PROMPT',
            'This prompt is already active',
          );
        await persistProject(
          {
            ...stored,
            prompts,
            version: stored.version + 1,
            updatedAt: now().toISOString(),
          },
          stored.version,
        );
        return response(updated);
      }
      if (tail === 'runs' && method === 'GET')
        return response(paginate(await repository.listRuns(projectId), query));
      if (tail === 'runs' && method === 'POST') {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
          throw new HttpError(
            400,
            'IDEMPOTENCY_REQUIRED',
            'Send a unique Idempotency-Key header (8–100 letters, numbers, hyphens or underscores)',
          );
        if (!stored.prompts.some((p) => p.active))
          throw new HttpError(
            400,
            'NO_PROMPTS',
            'Add at least one active prompt before scanning',
          );
        const message = {
          kind: 'kickoff' as const,
          projectId,
          scheduledAt: now().toISOString(),
          requestId: key,
          trigger: 'manual' as const,
        };
        const runId = runIdFor(message);
        const existing = await repository.getRun(projectId, runId);
        if (!existing && stored.lastManualRequest?.runId !== runId) {
          const pending = stored.lastManualRequest;
          if (pending) {
            const previous = await repository.getRun(projectId, pending.runId);
            if (
              (!previous || ['queued', 'running'].includes(previous.status)) &&
              now().getTime() - Date.parse(pending.requestedAt) < 3 * 3600000
            )
              throw new HttpError(
                409,
                'RUN_ACTIVE',
                'A scan is already queued or running',
              );
          }
          const active = (await repository.listRuns(projectId)).find((r) =>
            ['queued', 'running'].includes(r.status),
          );
          if (active)
            throw new HttpError(409, 'RUN_ACTIVE', 'A scan is already running');
          // Admission happens before SQS dispatch. The same request ID can repair a failed enqueue.
          await persistProject(
            {
              ...stored,
              version: stored.version + 1,
              lastManualRequest: {
                runId,
                requestId: key,
                requestedAt: now().toISOString(),
              },
            },
            stored.version,
          );
        }
        await queue.send([message]);
        return response({ runId }, 202);
      }
      const retryMatch = tail.match(/^runs\/([^/]+)\/retry-failed$/);
      if (retryMatch && method === 'POST') {
        const requestId = request.headers.get('idempotency-key');
        if (!requestId || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
          throw new HttpError(
            400,
            'IDEMPOTENCY_REQUIRED',
            'Send a unique Idempotency-Key header',
          );
        const run = await selectedRun(retryMatch[1]);
        if (['queued', 'running'].includes(run.status))
          throw new HttpError(
            409,
            'RUN_ACTIVE',
            'This scan is already running',
          );
        const failed = (await repository.listResults(projectId, run.id)).filter(
          (r) => ['failed_collection', 'failed_extraction'].includes(r.status),
        );
        if (!failed.length)
          throw new HttpError(
            400,
            'NO_RETRYABLE_RESULTS',
            'No failed prompt jobs to retry',
          );
        if (
          failed.every(
            (r) =>
              (r.retryRequestIds?.length || 0) >= 32 &&
              !r.retryRequestIds?.includes(requestId),
          )
        )
          throw new HttpError(
            400,
            'RETRY_LIMIT',
            'These results reached the retry limit. Start a new scan.',
          );
        await queue.send([
          { kind: 'retry', projectId, runId: run.id, requestId },
        ]);
        return response({ runId: run.id }, 202);
      }
      const runMatch = tail.match(/^runs\/([^/]+)$/);
      if (runMatch && method === 'GET')
        return response(await selectedRun(runMatch[1]));
      if (tail === 'dashboard' && method === 'GET') {
        const runs = await repository.listRuns(projectId, 60);
        const current = query.get('runId')
          ? await selectedRun()
          : runs[0] || null;
        const currentSummary = current ? await summary(current) : null;
        const recent = runs.slice(0, 12);
        const trend = [];
        for (const run of recent.slice().reverse()) {
          const s = await summary(run);
          trend.push({
            runId: run.id,
            date: run.scheduledAt,
            visibility: s.metrics.visibility.value,
            averageRank: s.metrics.averageRank.value,
            status: run.status,
            analyzed: s.metrics.analyzed,
            total: run.totalCount,
            comparable: current
              ? sameCohort(run.snapshot, current.snapshot)
              : false,
          });
        }
        const previous = current
          ? runs.find(
              (r) =>
                r.scheduledAt < current.scheduledAt &&
                ['completed', 'partial'].includes(r.status),
            )
          : null;
        const comparison: Dashboard['comparison'] = {
          visibilityDelta: null,
          previousRunId: previous?.id || null,
          comparableCount: 0,
          reason: previous ? null : 'No previous scan',
        };
        if (current && previous) {
          if (!sameMethod(current.snapshot, previous.snapshot))
            comparison.reason = 'Model, brand or locale settings changed';
          else {
            const [a, b] = await Promise.all([
              repository.listResults(projectId, current.id),
              repository.listResults(projectId, previous.id),
            ]);
            const eligible = a.filter(
              (x) =>
                x.status === 'succeeded' &&
                b.some(
                  (y) =>
                    y.status === 'succeeded' &&
                    y.promptId === x.promptId &&
                    y.prompt.version === x.prompt.version,
                ),
            );
            const ids = new Set(eligible.map((x) => x.promptId));
            const before = b.filter((x) => ids.has(x.promptId));
            const left = metricsFromResults(eligible),
              right = metricsFromResults(before);
            comparison.comparableCount = eligible.length;
            if (
              left.visibility.value !== null &&
              right.visibility.value !== null
            )
              comparison.visibilityDelta =
                left.visibility.value - right.visibility.value;
            comparison.reason =
              eligible.length === current.totalCount
                ? null
                : eligible.length
                  ? `Compared ${eligible.length} unchanged, successfully analyzed prompts`
                  : 'No comparable analyzed prompts';
          }
        }
        const data: Dashboard = {
          project,
          run: current,
          metrics: currentSummary?.metrics || emptyMetrics(),
          trend,
          topSources: currentSummary?.domains.slice(0, 5) || [],
          comparison,
          nextScanAt: project.enabled
            ? nextWeeklyScan(project.timezone, now())
            : null,
          mode: options.mode,
        };
        return response(data);
      }
      if (tail === 'responses' && method === 'GET') {
        const run = await selectedRun();
        let items = await repository.listResults(projectId, run.id);
        const mentioned = query.get('mentioned'),
          sentiment = query.get('sentiment'),
          status = query.get('status'),
          q = query.get('q')?.toLocaleLowerCase(),
          stage = query.get('stage');
        if (stage)
          items = items.filter((result) => result.prompt.stage === stage);
        if (mentioned !== null) {
          if (!['true', 'false'].includes(mentioned))
            throw new HttpError(
              400,
              'INVALID_FILTER',
              'mentioned must be true or false',
            );
          items = items.filter(
            (r) =>
              r.status === 'succeeded' &&
              r.target?.mentioned === (mentioned === 'true'),
          );
        }
        if (sentiment)
          items = items.filter((r) => r.target?.sentiment === sentiment);
        if (status) items = items.filter((r) => r.status === status);
        if (q)
          items = items.filter((r) =>
            r.prompt.text.toLocaleLowerCase().includes(q),
          );
        return response(paginate(items, query));
      }
      const detailMatch = tail.match(/^responses\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        const responseId = decodeURIComponent(detailMatch[1]),
          parts = responseId.split('~');
        if (parts.length !== 2)
          throw new HttpError(404, 'NOT_FOUND', 'Response not found');
        const run = await selectedRun(parts[0]);
        const result = await repository.getResult(
          projectId,
          run.id,
          identifier.parse(parts[1]),
        );
        if (!result || result.responseId !== responseId)
          throw new HttpError(404, 'NOT_FOUND', 'Response not found');
        return response(await details(result, run));
      }
      if (tail === 'sources' && method === 'GET') {
        const run = await selectedRun(),
          data = await summary(run),
          kind = query.get('kind') || 'cited',
          group = query.get('groupBy') || 'domain';
        if (
          !['cited', 'consulted'].includes(kind) ||
          !['domain', 'url'].includes(group)
        )
          throw new HttpError(400, 'INVALID_FILTER', 'Invalid source filter');
        let items: SourceRow[] =
          kind === 'cited'
            ? group === 'domain'
              ? data.domains
              : data.urls
            : group === 'domain'
              ? data.consultedDomains
              : data.consultedUrls;
        const domain = query.get('domain'),
          q = query.get('q')?.toLocaleLowerCase(),
          owned = query.get('owned');
        if (domain) items = items.filter((row) => row.domain === domain);
        if (q)
          items = items.filter((row) =>
            `${row.domain} ${row.url || ''} ${row.title || ''}`
              .toLocaleLowerCase()
              .includes(q),
          );
        if (owned !== null) {
          if (!['true', 'false'].includes(owned))
            throw new HttpError(
              400,
              'INVALID_FILTER',
              'owned must be true or false',
            );
          items = items.filter((row) => row.owned === (owned === 'true'));
        }
        return response(paginate(items, query));
      }
      const sourceMatch = tail.match(/^sources\/([^/]+)\/responses$/);
      if (sourceMatch && method === 'GET') {
        const run = await selectedRun(),
          data = await summary(run);
        const source = [
          ...data.domains,
          ...data.urls,
          ...data.consultedDomains,
          ...data.consultedUrls,
        ].find((row) => row.id === sourceMatch[1]);
        if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source not found');
        const ids = new Set(source.responseIds);
        return response(
          paginate(
            (await repository.listResults(projectId, run.id)).filter((r) =>
              ids.has(r.responseId),
            ),
            query,
          ),
        );
      }
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
    } catch (error) {
      if (error instanceof HttpError)
        return response(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      if (error instanceof ZodError)
        return response(
          {
            error: {
              code: 'INVALID_INPUT',
              message: error.issues
                .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
                .join(';'),
            },
          },
          400,
        );
      if (error instanceof URIError)
        return response(
          { error: { code: 'INVALID_PATH', message: 'Invalid URL encoding' } },
          400,
        );
      const requestId = createHash('sha256')
        .update(randomUUID())
        .digest('hex')
        .slice(0, 12);
      console.error(
        JSON.stringify({
          event: 'api_error',
          requestId,
          type: (error as Error).name,
        }),
      );
      return response(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Request failed. Please try again.',
            requestId,
          },
        },
        500,
      );
    }
  };
}
