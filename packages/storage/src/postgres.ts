import * as traffic from './traffic-postgres.js';
import * as agents from './agents-postgres.js';
import {
  isTerminal,
  projectProviders,
  snapshotProvider,
  brandRank,
  brandSentimentScore,
  reportingCompanies,
  reportingCitations,
  type Analysis,
  type CapturedAnswer,
  type Citation,
  type Membership,
  type OnboardingJob,
  type Project,
  type PromptResult,
  type ScanRun,
  type TrackedUrl,
  type TrafficEvent,
  type TrafficFilters,
} from '@citevia/core';
import * as tracking from './tracking-postgres.js';
import * as mcp from './mcp.js';
import type { Repository, SavedAnalysis, SavedAnalysisRef } from './contracts.js';
import { uuidFor, type SqlDatabase, type SqlSession } from './sql.js';
import { AccessError, PostgresUsers } from './users.js';

const data = <T>(rows: Record<string, unknown>[]): T | null =>
  rows.length ? (rows[0].data as T) : null;
export class PostgresRepository extends PostgresUsers implements Repository {
  reserveAgentImage(post: import('@citevia/core').AgentPostJob, image?: import('@citevia/core').AgentImage) { return agents.reserveAgentImage(this.db, post, image); }
  getAgentPost(projectId: string, postId: string) { return agents.getAgentPost(this.db, projectId, postId); }
  listAgentPosts(projectId: string, offset: number, limit: number) { return agents.listAgentPosts(this.db, projectId, offset, limit); }
  listActiveAgentPosts() { return agents.listActiveAgentPosts(this.db); }
  reserveAgentPost(post: import('@citevia/core').AgentPostJob, expectedVersion: number | null) { return agents.reserveAgentPost(this.db, post, expectedVersion); }
  saveAgentPost(post: import('@citevia/core').AgentPostJob, expectedVersion: number) { return agents.saveAgentPost(this.db, post, expectedVersion); }
  constructor(db: SqlDatabase) {
    super(db);
  }
  recordTrafficInstallation(receipt: import('@citevia/core').TrafficInstallationReceipt) { return traffic.recordTrafficInstallation(this.db, receipt); }
  collectTrafficEvent(event: TrafficEvent) { return traffic.collectTrafficEvent(this.db, event); }
  trafficStatus(projectId: string, testId?: string) { return traffic.trafficStatus(this.db, projectId, testId); }
  aggregateTraffic(projectId: string, filters: TrafficFilters) { return traffic.aggregateTraffic(this.db, projectId, filters); }
  createMcpConnection(connection: mcp.McpConnection) { return mcp.createMcpConnection(this.db, connection); }
  listMcpConnections(userId: string, projectId: string | null) { return mcp.listMcpConnections(this.db, userId, projectId); }
  getMcpConnectionByHash(hash: string) { return mcp.getMcpConnectionByHash(this.db, hash); }
  getMcpConnection(id: string) { return mcp.getMcpConnection(this.db, id); }
  revokeMcpConnection(id: string, userId: string, now: string) { return mcp.revokeMcpConnection(this.db, id, userId, now); }
  touchMcpConnection(id: string, now: string) { return mcp.touchMcpConnection(this.db, id, now); }
  putMcpRecord(record: mcp.McpRecord) { return mcp.putMcpRecord(this.db, record); }
  getMcpRecord(kind: mcp.McpRecord['kind'], id: string) { return mcp.getMcpRecord(this.db, kind, id); }
  consumeMcpRecord(kind: mcp.McpRecord['kind'], id: string, now: string) { return mcp.consumeMcpRecord(this.db, kind, id, now); }
  limitMcpRequests(bucket: string, windowStart: string, limit: number) { return mcp.limitMcpRequests(this.db, bucket, windowStart, limit); }
  async listSavedAnalyses(
    projectId: string,
    refs: SavedAnalysisRef[],
  ): Promise<SavedAnalysis[]> {
    const found = new Map<string, SavedAnalysis>();
    for (let index = 0; index < refs.length; index += 500) {
      const requested = refs.slice(index, index + 500).map((ref) => ({
        response_id: ref.responseId,
        native_id: uuidFor(`${projectId}:response:${ref.responseId}`),
        capture_key: ref.captureKey,
        analysis_key: ref.analysisKey || null,
      }));
      const { rows } = await this.db.query(
        `SELECT requested.response_id, response.json_response->'analysis' AS analysis
        FROM jsonb_to_recordset($2::jsonb) AS requested(response_id text,native_id uuid,capture_key text,analysis_key text)
        JOIN prompt_responses response ON response.id=requested.native_id
        JOIN citevia_projects project ON project.id=$1 AND project.account_id=response.account_id
        JOIN citevia_runs run ON run.project_id=project.id AND run.scan_id=response.scan_id
        JOIN citevia_prompt_results result ON result.project_id=project.id AND result.run_id=run.id AND result.data->>'responseId'=requested.response_id
        WHERE response.s3_key=requested.capture_key
          AND result.data->>'captureKey'=requested.capture_key
          AND result.data->>'analysisKey' IS NOT DISTINCT FROM requested.analysis_key
          AND response.json_response ? 'analysis'
          AND (NOT (response.json_response ? 'measurement') OR (
            response.json_response->'measurement'->>'responseId'=requested.response_id
            AND response.json_response->'measurement'->>'captureKey'=requested.capture_key
            AND response.json_response->'measurement'->>'analysisKey' IS NOT DISTINCT FROM requested.analysis_key
            AND (response.json_response->'measurement'->>'version')::integer=result.version
          ))`,
        [projectId, JSON.stringify(requested)],
      );
      for (const row of rows) found.set(String(row.response_id), {
        responseId: String(row.response_id),
        analysis: row.analysis as Analysis | null,
      });
    }
    return [...found.values()];
  }
  async listNativeCitations(projectId: string, captureKeys: string[]) {
    const keys = [...new Set(captureKeys)];
    const citations: { captureKey: string; citations: Citation[] }[] = [];
    for (let index = 0; index < keys.length; index += 500) {
      const { rows } = await this.db.query(
        `SELECT cap.capture_key,
          COALESCE(jsonb_agg(c.data->'citations') FILTER (WHERE c.normalized_url IS NOT NULL),'[]'::jsonb) AS citations
        FROM citevia_citation_captures cap
        LEFT JOIN citevia_response_citations c ON c.project_id=cap.project_id AND c.capture_key=cap.capture_key
        WHERE cap.project_id=$1 AND cap.capture_key=ANY($2::text[])
        GROUP BY cap.capture_key`,
        [projectId, keys.slice(index, index + 500)],
      );
      citations.push(...rows.map(row => ({
        captureKey: String(row.capture_key),
        citations: (row.citations as Citation[][]).flat(),
      })));
    }
    return citations;
  }
  listTrackedUrls(projectId: string) { return tracking.listTrackedUrls(this.db,projectId); }
  registerTrackedUrl(url: TrackedUrl) { return tracking.registerTrackedUrl(this.db,url); }
  updateTrackedUrl(url: TrackedUrl, expectedVersion: number) { return tracking.updateTrackedUrl(this.db,url,expectedVersion); }
  listTrackingMatches(projectId: string, trackedUrlId?: string) { return tracking.listTrackingMatches(this.db,projectId,trackedUrlId); }
  async listProjectSummaries(
    userId: string,
    options: { offset: number; limit: number; query?: string },
  ) {
    const admin = `EXISTS(SELECT 1 FROM citevia_identities ai JOIN users au ON au.id=ai.user_id WHERE ai.subject=$1 AND ai.provider='descope' AND au.is_system_admin AND NOT ai.disabled)`;
    const from = `FROM citevia_projects p JOIN accounts a ON a.id=p.account_id LEFT JOIN user_accounts ua ON ua.account_id=p.account_id AND ua.user_id=(SELECT user_id FROM citevia_identities WHERE subject=$1) WHERE (ua.user_id IS NOT NULL OR ${admin}) AND ($2='' OR a.title ILIKE '%'||$2||'%' OR array_to_string(a.domains,' ') ILIKE '%'||$2||'%')`;
    const args = [userId, options.query || ''];
    const total = Number(
      (await this.db.query(`SELECT count(*)::int AS count ${from}`, args))
        .rows[0].count,
    );
    // Select a small metadata page before reading the larger JSON workflow documents.
    const { rows } = await this.db.query(
      `WITH selected AS (SELECT p.id,CASE WHEN ${admin} THEN ARRAY['OWNER'] ELSE ua.roles END AS roles ${from} ORDER BY a.created_at DESC,p.id LIMIT $3 OFFSET $4)
      SELECT p.data-'prompts'-'brandbook' AS data,s.roles,
        (SELECT count(*)::int FROM prompts WHERE account_id=p.account_id AND is_active=true) AS prompt_count,
        CASE WHEN j.id IS NOT NULL THEN jsonb_build_object('status',j.status,'step',j.data->>'step','error',j.data->'error','firstRunId',j.data->'firstRunId') ELSE NULL END AS job
      FROM selected s JOIN citevia_projects p ON p.id=s.id LEFT JOIN citevia_onboarding_jobs j ON j.project_id=p.id AND j.id=p.data->>'onboardingJobId'
      JOIN accounts a ON a.id=p.account_id ORDER BY a.created_at DESC,p.id`,
      [...args, options.limit, options.offset],
    );
    return {
      items: rows.map((row) => ({
        ...(row.data as Project),
        prompts: [],
        role: (row.roles as string[]).includes('OWNER')
          ? ('owner' as const)
          : ('viewer' as const),
        activePromptCount: Number(row.prompt_count),
        onboardingSummary: row.job as Project['onboardingSummary'],
      })),
      total,
      nextCursor:
        options.offset + options.limit < total
          ? Buffer.from(String(options.offset + options.limit)).toString(
              'base64url',
            )
          : null,
    };
  }
  async getProject(id: string) {
    return data<Project>(
      (
        await this.db.query('SELECT data FROM citevia_projects WHERE id=$1', [
          id,
        ])
      ).rows,
    );
  }
  async listProjects(userId: string) {
    const admin = (await this.getUser(userId))?.isSystemAdmin === true;
    const { rows } = await this.db.query(
      `SELECT p.data, ua.roles FROM citevia_projects p LEFT JOIN user_accounts ua ON ua.account_id=p.account_id AND ua.user_id=(SELECT user_id FROM citevia_identities WHERE subject=$1) WHERE ($2 OR ua.user_id IS NOT NULL) ORDER BY p.data->>'createdAt' DESC`,
      [userId, admin],
    );
    return rows.map((row) => ({
      ...(row.data as Project),
      role:
        admin || ((row.roles as string[]) || []).includes('OWNER')
          ? ('owner' as const)
          : ('viewer' as const),
    }));
  }
  private async syncProject(tx: SqlSession, p: Project) {
    const b = p.brandbook,
      id = uuidFor(p.id);
    await tx.query(
      `INSERT INTO accounts(id,title,names,domains,about,industry_category,sub_industry_category,company_country,language,key_features,tone_of_voice,"values",personality,target_audience,knowledge_sources,sitemap_url,case_studies_source_url,case_studies,post_guidelines,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,names=excluded.names,domains=excluded.domains,about=excluded.about,industry_category=excluded.industry_category,sub_industry_category=excluded.sub_industry_category,company_country=excluded.company_country,language=excluded.language,key_features=excluded.key_features,tone_of_voice=excluded.tone_of_voice,"values"=excluded."values",personality=excluded.personality,target_audience=excluded.target_audience,knowledge_sources=excluded.knowledge_sources,sitemap_url=excluded.sitemap_url,case_studies_source_url=excluded.case_studies_source_url,case_studies=excluded.case_studies,post_guidelines=excluded.post_guidelines,updated_at=excluded.updated_at`,
      [
        id,
        p.name,
        [p.brand.name, ...p.brand.aliases],
        p.brand.domains,
        b?.about || null,
        b?.industryCategory || null,
        b?.subIndustryCategory || null,
        p.country,
        p.language,
        b?.keyFeatures || [],
        b?.toneOfVoice || [],
        b?.values || [],
        b?.personality || [],
        b?.targetAudience || [],
        b?.knowledgeSources || [],
        b?.sitemapUrl || null,
        b?.caseStudiesSourceUrl || null,
        JSON.stringify(b?.caseStudies || []),
        JSON.stringify(b?.postGuidelines || null),
        p.createdAt,
        p.updatedAt,
      ],
    );
    await tx.query(
      `INSERT INTO account_settings(id,account_id,scan_period,ai_engines,regions,competitors_names,prompt_limit,region_limit,scan_interval_limit,scan_schedule_time,updated_at)
      VALUES($1,$2,7,ARRAY(SELECT value FROM jsonb_array_elements($3::jsonb)),$4,$5::jsonb,50,1,7,$6,$7)
      ON CONFLICT(account_id) DO UPDATE SET ai_engines=excluded.ai_engines,regions=excluded.regions,competitors_names=excluded.competitors_names,scan_schedule_time=excluded.scan_schedule_time,updated_at=excluded.updated_at`,
      [
        uuidFor(`${p.id}:settings`),
        id,
        JSON.stringify(projectProviders(p)),
        [p.country],
        JSON.stringify(p.competitors.map((c) => c.name)),
        p.timezone,
        p.updatedAt,
      ],
    );
    await tx.query(
      "UPDATE competitors SET status='INACTIVE' WHERE account_id=$1",
      [id],
    );
    for (const competitor of p.competitors)
      await tx.query(
        `INSERT INTO competitors(id,account_id,name,site,domain,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,site=excluded.site,domain=excluded.domain,status='ACTIVE',updated_at=excluded.updated_at`,
        [
          uuidFor(`${p.id}:competitor:${competitor.id}`),
          id,
          competitor.name,
          competitor.domains[0] ? `https://${competitor.domains[0]}` : null,
          competitor.domains[0] || null,
          p.updatedAt,
        ],
      );
    // Old prompt rows remain archived; immutable scan snapshots retain their original text/version.
    await tx.query('UPDATE prompts SET is_active=false WHERE account_id=$1', [
      id,
    ]);
    for (const prompt of p.prompts) {
      const topicId = uuidFor(`${p.id}:topic:${prompt.topic || 'General'}`);
      await tx.query(
        `INSERT INTO topics(id,account_id,name,priority,updated_at) VALUES($1,$2,$3,0,$4) ON CONFLICT(id) DO NOTHING`,
        [topicId, id, prompt.topic || 'General', prompt.updatedAt],
      );
      await tx.query(
        `INSERT INTO prompts(id,account_id,prompt,type,ratingscore,me_in_prompt,topic_id,regions,language,is_active,generation_id,stage,created_at,updated_at,seo_keyword,tags)
        VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,type=excluded.type,me_in_prompt=excluded.me_in_prompt,topic_id=excluded.topic_id,is_active=excluded.is_active,stage=excluded.stage,regions=excluded.regions,language=excluded.language,seo_keyword=excluded.seo_keyword,tags=excluded.tags,updated_at=excluded.updated_at`,
        [
          uuidFor(`${p.id}:prompt:${prompt.id}`),
          id,
          prompt.text,
          prompt.intent || prompt.stage || 'general',
          prompt.branded,
          topicId,
          [p.country],
          p.language,
          prompt.active,
          prompt.generationId ? uuidFor(prompt.generationId) : null,
          prompt.stage || null,
          prompt.createdAt,
          prompt.updatedAt,
          prompt.seoKeyword || null,
          JSON.stringify(prompt.tags || []),
        ],
      );
    }
  }
  async saveProject(project: Project, expectedVersion: number | null) {
    return this.db.transaction(async (tx) => {
      if (Buffer.byteLength(JSON.stringify(project), 'utf8') > 300000)
        throw new Error('Project configuration exceeds the 300 KB limit');
      if (expectedVersion === null) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          project.id,
        ]);
        if (
          (
            await tx.query('SELECT id FROM citevia_projects WHERE id=$1', [
              project.id,
            ])
          ).rows.length
        )
          return false;
      } else {
        const row = await tx.query(
          'SELECT version FROM citevia_projects WHERE id=$1 FOR UPDATE',
          [project.id],
        );
        if (row.rows[0]?.version !== expectedVersion) return false;
      }
      await this.syncProject(tx, project);
      await tx.query(
        'INSERT INTO citevia_projects(id,account_id,version,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data',
        [
          project.id,
          uuidFor(project.id),
          project.version,
          JSON.stringify(project),
        ],
      );
      return true;
    });
  }
  private async membership(tx: SqlSession, m: Membership) {
    const identity = await tx.query(
      `SELECT user_id FROM citevia_identities WHERE subject=$1 AND provider='descope'`,
      [m.userId],
    );
    if (!identity.rows[0])
      throw new AccessError(
        404,
        'USER_NOT_FOUND',
        'Register the verified Descope user before assigning an account.',
      );
    const userId = identity.rows[0].user_id;
    await tx.query(
      'INSERT INTO user_accounts(id,user_id,account_id,roles,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id,account_id) DO UPDATE SET roles=excluded.roles',
      [
        uuidFor(`${m.projectId}:member:${m.userId}`),
        userId,
        uuidFor(m.projectId),
        [m.role === 'owner' ? 'OWNER' : 'VIEWER'],
      ],
    );
  }
  async getMembership(projectId: string, userId: string) {
    const { rows } = await this.db.query(
      'SELECT ua.roles FROM user_accounts ua JOIN citevia_identities i ON i.user_id=ua.user_id JOIN citevia_projects p ON p.account_id=ua.account_id WHERE p.id=$1 AND i.subject=$2',
      [projectId, userId],
    );
    return rows.length
      ? {
          projectId,
          userId,
          role: (rows[0].roles as string[]).includes('OWNER')
            ? ('owner' as const)
            : ('viewer' as const),
        }
      : null;
  }
  async putMembership(m: Membership) {
    await this.db.transaction((tx) => this.membership(tx, m));
  }
  async createOnboarding(
    project: Project,
    job: OnboardingJob,
    maxAccounts: number,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        job.ownerId,
      ]);
      if (
        (
          await tx.query('SELECT id FROM citevia_projects WHERE id=$1', [
            project.id,
          ])
        ).rows.length
      )
        return 'exists' as const;
      const count = await tx.query(
        `SELECT count(*)::int AS count FROM user_accounts ua JOIN citevia_identities i ON i.user_id=ua.user_id WHERE i.subject=$1 AND 'OWNER'=ANY(ua.roles)`,
        [job.ownerId],
      );
      if (Number(count.rows[0].count) >= maxAccounts) return 'limit' as const;
      await this.syncProject(tx, project);
      await tx.query(
        'INSERT INTO citevia_projects(id,account_id,version,data) VALUES($1,$2,$3,$4::jsonb)',
        [
          project.id,
          uuidFor(project.id),
          project.version,
          JSON.stringify(project),
        ],
      );
      await this.membership(tx, {
        projectId: project.id,
        userId: job.ownerId,
        role: 'owner',
      });
      await tx.query(
        'INSERT INTO citevia_onboarding_jobs(project_id,id,owner_id,status,version,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          project.id,
          job.id,
          job.ownerId,
          job.status,
          job.version,
          JSON.stringify(job),
        ],
      );
      return 'created' as const;
    });
  }
  async getOnboarding(projectId: string, jobId: string) {
    return data<OnboardingJob>(
      (
        await this.db.query(
          'SELECT data FROM citevia_onboarding_jobs WHERE project_id=$1 AND id=$2',
          [projectId, jobId],
        )
      ).rows,
    );
  }
  async saveOnboarding(job: OnboardingJob, version: number) {
    return !!(
      await this.db.query(
        'UPDATE citevia_onboarding_jobs SET version=$1,status=$2,data=$3::jsonb WHERE project_id=$4 AND id=$5 AND version=$6 RETURNING id',
        [
          job.version,
          job.status,
          JSON.stringify(job),
          job.projectId,
          job.id,
          version,
        ],
      )
    ).rows.length;
  }
  async listActiveOnboarding() {
    return (
      await this.db.query(
        `SELECT data FROM citevia_onboarding_jobs WHERE status IN ('queued','running') ORDER BY data->>'createdAt' LIMIT 1000`,
      )
    ).rows.map((row) => row.data as OnboardingJob);
  }
  async createRun(run: ScanRun, results: PromptResult[]) {
    return this.db.transaction(async (tx) => {
      if (
        results.length !== run.totalCount ||
        !results.length ||
        results.length > 50 ||
        new Set(results.map((r) => r.promptId)).size !== results.length
      )
        throw new Error('Invalid run manifest');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${run.projectId}:${run.id}`,
      ]);
      if (
        (
          await tx.query(
            'SELECT id FROM citevia_runs WHERE project_id=$1 AND id=$2',
            [run.projectId, run.id],
          )
        ).rows.length
      )
        return false;
      await tx.query(
        'INSERT INTO scans(id,account_id,scheduled_by,scheduled_at,status,updated_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          uuidFor(`${run.projectId}:scan:${run.id}`),
          uuidFor(run.projectId),
          run.trigger,
          run.scheduledAt,
          run.status.toUpperCase(),
          run.createdAt,
        ],
      );
      await tx.query(
        'INSERT INTO citevia_runs(project_id,id,scan_id,status,scheduled_at,result_version,terminal_count,total_count,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [
          run.projectId,
          run.id,
          uuidFor(`${run.projectId}:scan:${run.id}`),
          run.status,
          run.scheduledAt,
          run.resultVersion,
          run.terminalCount,
          run.totalCount,
          JSON.stringify(run),
        ],
      );
      for (const result of results)
        await tx.query(
          'INSERT INTO citevia_prompt_results(project_id,run_id,prompt_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            result.projectId,
            result.runId,
            result.promptId,
            result.version,
            JSON.stringify(result),
          ],
        );
      return true;
    });
  }
  async getRun(projectId: string, id: string) {
    return data<ScanRun>(
      (
        await this.db.query(
          'SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2',
          [projectId, id],
        )
      ).rows,
    );
  }
  async listRuns(projectId: string, limit = 60) {
    return (
      await this.db.query(
        'SELECT data FROM citevia_runs WHERE project_id=$1 ORDER BY scheduled_at DESC LIMIT $2',
        [projectId, limit],
      )
    ).rows.map((row) => row.data as ScanRun);
  }
  async listPromptHistory(
    projectId: string,
    start: string,
    end: string,
    promptId?: string,
  ) {
    // One statement gives a consistent snapshot and avoids the scan-list page limit.
    const { rows } = await this.db.query(
      `WITH observations AS (
        SELECT result.data, result.run_id FROM citevia_prompt_results result
        JOIN citevia_runs run ON run.project_id=result.project_id AND run.id=result.run_id
        WHERE result.project_id=$1
          AND ($4::text IS NULL OR result.prompt_id=$4)
          AND COALESCE(result.data->>'capturedAt',run.data->>'createdAt')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz
      ) SELECT
        COALESCE((SELECT jsonb_agg(data) FROM observations),'[]'::jsonb) AS results,
        COALESCE((SELECT jsonb_agg(data) FROM citevia_runs WHERE project_id=$1 AND id IN (SELECT run_id FROM observations)),'[]'::jsonb) AS runs`,
      [projectId, start, end, promptId || null],
    );
    return {
      runs: rows[0].runs as ScanRun[],
      results: rows[0].results as PromptResult[],
    };
  }
  async listActiveRuns() {
    return (
      await this.db.query(
        `SELECT data FROM citevia_runs WHERE status IN ('queued','running') ORDER BY scheduled_at LIMIT 1000`,
      )
    ).rows.map((row) => row.data as ScanRun);
  }
  async listResults(projectId: string, runId: string) {
    return (
      await this.db.query(
        'SELECT data FROM citevia_prompt_results WHERE project_id=$1 AND run_id=$2 ORDER BY prompt_id',
        [projectId, runId],
      )
    ).rows.map((row) => row.data as PromptResult);
  }
  async getResult(projectId: string, runId: string, promptId: string) {
    return data<PromptResult>(
      (
        await this.db.query(
          'SELECT data FROM citevia_prompt_results WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3',
          [projectId, runId, promptId],
        )
      ).rows,
    );
  }
  private async updateRun(tx: SqlSession, run: ScanRun) {
    await tx.query(
      'UPDATE citevia_runs SET status=$1,result_version=$2,terminal_count=$3,data=$4::jsonb WHERE project_id=$5 AND id=$6',
      [
        run.status,
        run.resultVersion,
        run.terminalCount,
        JSON.stringify(run),
        run.projectId,
        run.id,
      ],
    );
    await tx.query('UPDATE scans SET status=$1,updated_at=now() WHERE id=$2', [
      run.status.toUpperCase(),
      uuidFor(`${run.projectId}:scan:${run.id}`),
    ]);
  }
  async commitResult(next: PromptResult, previous: PromptResult) {
    return this.db.transaction(async (tx) => {
      if (
        next.version !== previous.version + 1 ||
        next.projectId !== previous.projectId ||
        next.runId !== previous.runId ||
        next.promptId !== previous.promptId
      )
        throw new Error('Invalid result transition');
      // Consistent lock order: run first, result second. Every counter change shares this transaction.
      const run = data<ScanRun>(
        (
          await tx.query(
            'SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
            [previous.projectId, previous.runId],
          )
        ).rows,
      );
      if (!run) return false;
      const result = await tx.query(
        'UPDATE citevia_prompt_results SET version=$1,data=$2::jsonb WHERE project_id=$3 AND run_id=$4 AND prompt_id=$5 AND version=$6 RETURNING prompt_id',
        [
          next.version,
          JSON.stringify(next),
          next.projectId,
          next.runId,
          next.promptId,
          previous.version,
        ],
      );
      if (!result.rows.length) return false;
      run.terminalCount +=
        Number(isTerminal(next.status)) - Number(isTerminal(previous.status));
      run.succeededCount +=
        Number(next.status === 'succeeded') -
        Number(previous.status === 'succeeded');
      run.capturedCount +=
        Number(!!next.capturedAt) - Number(!!previous.capturedAt);
      run.resultVersion++;
      run.status = 'running';
      run.startedAt ||= new Date().toISOString();
      delete run.completedAt;
      await this.updateRun(tx, run);
      return true;
    });
  }
  async markRunRunning(projectId: string, id: string, deadlineAt?: string) {
    await this.db.transaction(async (tx) => {
      const run = data<ScanRun>(
        (
          await tx.query(
            'SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
            [projectId, id],
          )
        ).rows,
      );
      if (run && run.terminalCount < run.totalCount) {
        run.status = 'running';
        run.startedAt ||= new Date().toISOString();
        delete run.completedAt;
        if (deadlineAt) run.deadlineAt = deadlineAt;
        await this.updateRun(tx, run);
      }
    });
  }
  async finalizeRun(
    projectId: string,
    id: string,
    version: number,
    status: 'completed' | 'partial' | 'failed',
    summaryKey: string,
    completedAt: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [projectId]);
      const run = data<ScanRun>(
        (
          await tx.query(
            'SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
            [projectId, id],
          )
        ).rows,
      );
      if (
        !run ||
        run.resultVersion !== version ||
        run.terminalCount !== run.totalCount
      )
        return false;
      Object.assign(run, {
        status,
        summaryKey,
        summaryVersion: version,
        completedAt,
      });
      await this.updateRun(tx, run);
      await tracking.refreshRunCounters(tx,projectId,id);
      return true;
    });
  }
  async saveMeasurement(
    result: PromptResult,
    run: ScanRun,
    answer: CapturedAnswer | null,
    analysis: Analysis | null,
  ) {
    if (result.projectId !== run.projectId || result.runId !== run.id) return;
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [run.projectId]);
      // Prevent an older finalizer from publishing rows after a newer retry changed the result.
      await tx.query(
        'SELECT id FROM citevia_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [run.projectId, run.id],
      );
      const current = await tx.query(
        'SELECT version FROM citevia_prompt_results WHERE project_id=$1 AND run_id=$2 AND prompt_id=$3 FOR UPDATE',
        [result.projectId, result.runId, result.promptId],
      );
      if (current.rows[0]?.version !== result.version) return;
      await tracking.saveCitationMeasurement(tx,result,run,answer,analysis);
      const responseId = uuidFor(
          `${run.projectId}:response:${result.responseId}`,
        ),
        accountId = uuidFor(run.projectId),
        promptId = uuidFor(`${run.projectId}:prompt:${result.promptId}`),
        scanId = uuidFor(`${run.projectId}:scan:${run.id}`),
        topicId = uuidFor(
          `${run.projectId}:topic:${result.prompt.topic || 'General'}`,
        );
      await tx.query(
        `INSERT INTO prompt_responses(id,account_id,topic_id,prompt_id,scan_id,purpose,response,json_response,sources,model,timestamp,country,region,usage,s3_key,status,provider,visibility,response_rank,failed_reason,updated_at)
      VALUES($1,$2,$3,$4,$5,'LLM_SCAN',$6,$7::jsonb,ARRAY(SELECT value FROM jsonb_array_elements($8::jsonb)),$9,$10,$11,$11,$12::jsonb,$13,$16,$18,$14,$15,$17,now())
      ON CONFLICT(id) DO UPDATE SET response=excluded.response,json_response=excluded.json_response,sources=excluded.sources,model=excluded.model,timestamp=excluded.timestamp,provider=excluded.provider,s3_key=excluded.s3_key,usage=excluded.usage,status=excluded.status,visibility=excluded.visibility,response_rank=excluded.response_rank,failed_reason=excluded.failed_reason,updated_at=now()`,
        [
          responseId,
          accountId,
          topicId,
          promptId,
          scanId,
          answer?.text || null,
          JSON.stringify({
            companies:
              result.status === 'succeeded'
                ? reportingCompanies(analysis, run.snapshot, answer)
                : [],
            analysis,
            measurement: {
              responseId: result.responseId,
              captureKey: result.captureKey || null,
              analysisKey: result.analysisKey || null,
              version: result.version,
            },
            companiesByAppearance: analysis?.companies || [],
            sentimentScore:
              result.status === 'succeeded'
                ? brandSentimentScore(result.target)
                : null,
            error: result.error || null,
            providerResponseId: answer?.providerResponseId,
            blocks: answer?.blocks || [],
            retrievedSources: answer?.sources || [],
            nativeResponse: answer?.raw || null,
            promptSnapshot: result.prompt,
          }),
          JSON.stringify(reportingCitations(answer)),
          answer?.model || result.model || run.snapshot.generationModel,
          answer?.createdAt || result.completedAt || run.createdAt,
          run.snapshot.country,
          JSON.stringify(answer?.usage || result.usage || null),
          result.captureKey || null,
          result.status === 'succeeded' && result.target
            ? result.target.mentioned
              ? 100
              : 0
            : null,
          result.status === 'succeeded' ? brandRank(result.target) : null,
          result.status === 'succeeded'
            ? 'COMPLETED'
            : result.status.toUpperCase(),
          result.error?.code || null,
          snapshotProvider(run.snapshot),
        ],
      );
      await tx.query(
        'DELETE FROM results WHERE account_id=$1 AND scan_id=$2 AND prompt_id=$3',
        [accountId, scanId, promptId],
      );
      if (!analysis || !answer || result.status !== 'succeeded') return;
      for (const company of reportingCompanies(
        analysis,
        run.snapshot,
        answer,
      )) {
        // The native schema requires a non-null rank; unranked entities stay in JSON with rank:null.
        if (company.rank === null) continue;
        await tx.query(
          `INSERT INTO results(id,account_id,topic_id,topic,prompt_id,prompt,is_company_in_prompt,prompt_type,prompt_ranking,rank,entity,original_entity,reason,linkable,company_sources,company_site_url,company_domain,feel,url_sources,provider,model,timestamp,scan_id,region,country)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$10,$11,$12,ARRAY(SELECT value FROM jsonb_array_elements($22::jsonb)),$13,$14,$15,ARRAY(SELECT value FROM jsonb_array_elements($16::jsonb)),$21,$17,$18,$19,$20,$20)`,
          [
            uuidFor(
              `${result.responseId}:company:${company.company.toLocaleLowerCase()}`,
            ),
            accountId,
            topicId,
            result.prompt.topic || 'General',
            promptId,
            result.prompt.text,
            result.prompt.branded,
            result.prompt.intent || result.prompt.stage || 'general',
            company.rank,
            company.company,
            company.reason,
            !!company.company_site_url,
            company.company_site_url,
            company.domain,
            company.feel,
            JSON.stringify(reportingCitations(answer)),
            answer.model,
            answer.createdAt,
            scanId,
            run.snapshot.country,
            snapshotProvider(run.snapshot),
            JSON.stringify(company.sources),
          ],
        );
      }
    });
  }
}
