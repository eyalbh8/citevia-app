import { aggregateTraffic, type TrafficEvent, type TrafficFilters, type TrafficInstallationReceipt, type TrafficSite } from '@citevia/core';
import {
  verifiedIdentitySchema,
  type VerifiedIdentity,
  type User,
  type UserAccount,
} from '@citevia/core';
import { uuidFor } from './sql.js';
import { AccessError } from './users.js';
import { MCP_CONNECTION_LIMIT, type McpConnection, type McpRecord } from './mcp.js';
import {
  isTerminal,
  citationMeasurement,
  newerCapture, trackingEnabledAt,
  type TrackedUrl,
  type TrackingMatch,
  type CitationCapture,
  type CitationEvidence,
  type Analysis,
  type CapturedAnswer,
  type OnboardingJob,
  type Membership,
  type Project,
  type PromptResult,
  type ScanMessage,
  type ScanRun,
} from '@citevia/core';
import type {
  ArtifactStore, JobQueue, Repository, SavedAnalysisRef, SavedAnalysis,
} from './contracts.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

interface State {
  trafficEvents?: Record<string, TrafficEvent>;
  trafficSites?: Record<string, TrafficSite & {projectId: string}>;
  trafficTests?: Record<string, string>;
  mcpConnections?: Record<string, McpConnection>;
  mcpRecords?: Record<string, McpRecord>;
  mcpRequestLimits?: Record<string, { windowStart: string; count: number }>;
  savedAnalyses?: Record<string, SavedAnalysisRef & {
    projectId: string;
    runId: string;
    promptId: string;
    version: number;
    analysis: Analysis | null;
  }>;
  trackedUrls: Record<string, TrackedUrl>;
  citationCaptures: Record<string, {capture: CitationCapture; evidence: CitationEvidence[]}>;
  trackingMatches: Record<string, string[]>;
  users: Record<string, User>;
  projects: Record<string, Project>;
  members: Record<string, Membership>;
  runs: Record<string, ScanRun>;
  results: Record<string, PromptResult>;
  onboarding: Record<string, OnboardingJob>;
}
const blank = (): State => ({
  trackedUrls: {}, citationCaptures: {}, trackingMatches: {},
  users: {},
  projects: {},
  members: {},
  runs: {},
  results: {},
  onboarding: {},
});
const key = (...parts: string[]) => parts.join(':');
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryRepository implements Repository {
  protected state: State = blank();
  collectTrafficEvent(event: TrafficEvent) {
    return this.operation(() => {
      this.state.trafficEvents ||= {};
      this.state.trafficEvents[event.id] ||= copy(event);
    }, true);
  }
  recordTrafficInstallation(receipt: TrafficInstallationReceipt) {
    return this.operation(() => {
      this.state.trafficSites ||= {};
      const siteKey = JSON.stringify([receipt.projectId, receipt.origin]);
      const previous = this.state.trafficSites[siteKey];
      this.state.trafficSites[siteKey] = {
        projectId: receipt.projectId, origin: receipt.origin,
        firstSeenAt: previous?.firstSeenAt || receipt.timestamp,
        lastSeenAt: receipt.timestamp, trackerVersion: receipt.trackerVersion,
      };
      if (receipt.testId) {
        this.state.trafficTests ||= {};
        this.state.trafficTests[JSON.stringify([receipt.projectId, receipt.testId])] = receipt.timestamp;
      }
    }, true);
  }
  trafficStatus(projectId: string, testId?: string) {
    return this.operation(() => {
      const events = Object.values(this.state.trafficEvents || {}).filter(e => e.projectId === projectId);
      const sites = Object.values(this.state.trafficSites || {}).filter(s => s.projectId === projectId)
        .map(({projectId: _, ...site}) => site).sort((a,b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.origin.localeCompare(b.origin));
      return {
        installed: sites.length > 0 || events.length > 0, sites,
        hasEvents: events.some(e => !e.testId),
        lastReceivedAt: [...events.map(e => e.timestamp), ...sites.map(s => s.lastSeenAt)].sort().at(-1) || null,
        testReceived: Boolean(testId && (this.state.trafficTests?.[JSON.stringify([projectId,testId])] || events.some(e => e.testId === testId))),
      };
    });
  }
  aggregateTraffic(projectId: string, filters: TrafficFilters) {
    return this.operation(() => aggregateTraffic(Object.values(this.state.trafficEvents || {}).filter(e=>e.projectId===projectId), filters));
  }
  private tail: Promise<unknown> = Promise.resolve();
  createMcpConnection(connection: McpConnection): Promise<void> {
    return this.operation(() => {
      this.state.mcpConnections ||= {};
      if (!this.state.users[connection.userId])
        throw new AccessError(404, 'USER_NOT_FOUND', 'Register the user first.');
      if (connection.projectId !== null && !this.state.projects[connection.projectId])
        throw new AccessError(404, 'NOT_FOUND', 'Account not found.');
      const connections = Object.values(this.state.mcpConnections);
      if (connections.some(item => item.id === connection.id || item.tokenHash === connection.tokenHash))
        throw new AccessError(409, 'MCP_CONNECTION_EXISTS', 'This MCP credential already exists.');
      if (connections.filter(item =>
        item.userId === connection.userId && item.projectId === connection.projectId &&
        item.revokedAt === null && (item.expiresAt === null || Date.parse(item.expiresAt) > Date.parse(connection.createdAt)),
      ).length >= MCP_CONNECTION_LIMIT)
        throw new AccessError(409, 'MCP_CONNECTION_LIMIT', 'Revoke an existing MCP connection before creating another.');
      this.state.mcpConnections[JSON.stringify(connection.id)] = copy(connection);
    }, true);
  }
  listMcpConnections(userId: string, projectId: string | null) {
    return this.operation(() => Object.values(this.state.mcpConnections || {})
      .filter(item => item.userId === userId && item.projectId === projectId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)));
  }
  getMcpConnectionByHash(hash: string) {
    return this.operation(() => Object.values(this.state.mcpConnections || {}).find(item => item.tokenHash === hash) || null);
  }
  getMcpConnection(id: string) {
    return this.operation(() => this.state.mcpConnections?.[JSON.stringify(id)] || null);
  }
  revokeMcpConnection(id: string, userId: string, now: string) {
    return this.operation(() => {
      const connection = this.state.mcpConnections?.[JSON.stringify(id)];
      if (!connection || connection.userId !== userId || connection.revokedAt !== null) return false;
      connection.revokedAt = now;
      return true;
    }, true);
  }
  touchMcpConnection(id: string, now: string): Promise<void> {
    return this.operation(() => {
      const connection = this.state.mcpConnections?.[JSON.stringify(id)];
      if (connection && connection.revokedAt === null &&
        (connection.expiresAt === null || Date.parse(connection.expiresAt) > Date.parse(now)) &&
        (connection.lastUsedAt === null || Date.parse(connection.lastUsedAt) < Date.parse(now)))
        connection.lastUsedAt = now;
    }, true);
  }
  putMcpRecord(record: McpRecord): Promise<void> {
    return this.operation(() => {
      this.state.mcpRecords ||= {};
      this.state.mcpRecords[JSON.stringify([record.kind, record.id])] = copy(record);
    }, true);
  }
  getMcpRecord(kind: McpRecord['kind'], id: string) {
    return this.operation(() => this.state.mcpRecords?.[JSON.stringify([kind, id])] || null);
  }
  consumeMcpRecord(kind: McpRecord['kind'], id: string, now: string) {
    return this.operation(() => {
      const recordKey = JSON.stringify([kind, id]);
      const record = this.state.mcpRecords?.[recordKey];
      if (!record) return null;
      if (kind === 'refresh') {
        if (record.data.consumed === true || (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.parse(now))) return null;
        const original = copy(record);
        record.data.consumed = true;
        return original;
      }
      delete this.state.mcpRecords![recordKey];
      return record.expiresAt === null || Date.parse(record.expiresAt) > Date.parse(now) ? record : null;
    }, true);
  }
  limitMcpRequests(bucket: string, windowStart: string, limit: number) {
    return this.operation(() => {
      if (!Number.isSafeInteger(limit) || limit < 1) return false;
      this.state.mcpRequestLimits ||= {};
      // Prefix the caller-supplied bucket to avoid Object.prototype keys in file state.
      const bucketKey = JSON.stringify(bucket);
      const existing = this.state.mcpRequestLimits[bucketKey];
      if (!existing || Date.parse(existing.windowStart) < Date.parse(windowStart)) {
        this.state.mcpRequestLimits[bucketKey] = { windowStart, count: 1 };
        return true;
      }
      if (Date.parse(existing.windowStart) !== Date.parse(windowStart) || existing.count >= limit) return false;
      existing.count++;
      return true;
    }, true);
  }
  listSavedAnalyses(projectId: string, refs: SavedAnalysisRef[]) {
    return this.operation(() => {
      const found = new Map<string, SavedAnalysis>();
      for (const ref of refs) {
        const saved = this.state.savedAnalyses?.[key(projectId, ref.responseId)];
        if (
          !saved || saved.projectId !== projectId ||
          saved.captureKey !== ref.captureKey || saved.analysisKey !== ref.analysisKey
        ) continue;
        const current = this.state.results[key(projectId, saved.runId, saved.promptId)];
        if (
          !current || current.responseId !== ref.responseId || current.version !== saved.version ||
          current.captureKey !== ref.captureKey || current.analysisKey !== ref.analysisKey
        ) continue;
        found.set(ref.responseId, { responseId: ref.responseId, analysis: saved.analysis });
      }
      return [...found.values()];
    });
  }
  listNativeCitations(projectId: string, captureKeys: string[]) {
    return this.operation(() => [...new Set(captureKeys)].flatMap(captureKey => {
      const measurement = this.state.citationCaptures?.[key(projectId, captureKey)];
      if (!measurement || measurement.capture.projectId !== projectId) return [];
      return [{ captureKey, citations: measurement.evidence.flatMap(item => item.citations) }];
    }));
  }
  createOnboarding(project: Project, job: OnboardingJob, maxAccounts: number) {
    return this.operation(() => {
      this.state.onboarding ||= {};
      if (this.state.projects[project.id]) return 'exists' as const;
      if (!this.state.users?.[job.ownerId])
        throw new AccessError(
          404,
          'USER_NOT_FOUND',
          'Register the user first.',
        );
      if (
        Object.values(this.state.members).filter(
          (member) => member.userId === job.ownerId && member.role === 'owner',
        ).length >= maxAccounts
      )
        return 'limit' as const;
      this.state.projects[project.id] = copy(project);
      this.state.onboarding[key(project.id, job.id)] = copy(job);
      this.state.members[key(project.id, job.ownerId)] = {
        projectId: project.id,
        userId: job.ownerId,
        role: 'owner',
      };
      return 'created' as const;
    }, true);
  }
  getOnboarding(projectId: string, jobId: string) {
    return this.operation(
      () => this.state.onboarding?.[key(projectId, jobId)] || null,
    );
  }
  saveOnboarding(job: OnboardingJob, expectedVersion: number) {
    return this.operation(() => {
      const id = key(job.projectId, job.id);
      if (this.state.onboarding?.[id]?.version !== expectedVersion)
        return false;
      this.state.onboarding[id] = copy(job);
      return true;
    }, true);
  }
  listActiveOnboarding() {
    return this.operation(() =>
      Object.values(this.state.onboarding || {}).filter((job) =>
        ['queued', 'running'].includes(job.status),
      ),
    );
  }
  listTrackedUrls(projectId: string) {
    return this.operation(() => Object.values(this.state.trackedUrls || {}).filter(url => url.projectId === projectId));
  }
  registerTrackedUrl(url: TrackedUrl) {
    return this.operation(() => {
      this.state.trackedUrls ||= {}; this.state.trackingMatches ||= {};
      const urls = Object.values(this.state.trackedUrls).filter(item => item.projectId === url.projectId);
      const existing = urls.find(item => item.normalizedUrl === url.normalizedUrl);
      if (existing) return existing;
      if (urls.length >= 500) throw new AccessError(400, 'TRACKING_LIMIT', 'An account can track up to 500 URLs.');
      this.state.trackedUrls[key(url.projectId, url.id)] = copy(url);
      this.state.trackingMatches[key(url.projectId,url.id)] = Object.entries(this.state.citationCaptures || {}).filter(([,m]) => m.capture.projectId === url.projectId && trackingEnabledAt(url,m.capture.capturedAt) && m.evidence.some(e => e.normalizedUrl === url.normalizedUrl)).map(([id])=>id);
      return url;
    }, true);
  }
  updateTrackedUrl(url: TrackedUrl, expectedVersion: number) {
    return this.operation(() => {
      const id = key(url.projectId,url.id);
      if (this.state.trackedUrls?.[id]?.version !== expectedVersion) return false;
      this.state.trackedUrls[id] = copy(url); return true;
    }, true);
  }
  listTrackingMatches(projectId: string, trackedUrlId?: string) {
    return this.operation(() => {
      const matches: TrackingMatch[] = [];
      for (const url of Object.values(this.state.trackedUrls || {})) {
        if (url.projectId !== projectId || (trackedUrlId && url.id !== trackedUrlId)) continue;
        for (const captureId of this.state.trackingMatches?.[key(projectId,url.id)] || []) {
          const measurement = this.state.citationCaptures?.[captureId];
          if (!measurement || !['completed','partial'].includes(this.state.runs[key(projectId,measurement.capture.runId)]?.status)) continue;
          const evidence = measurement.evidence.find(e => e.normalizedUrl === url.normalizedUrl);
          if (evidence) matches.push({trackedUrlId: url.id, capture: measurement.capture, evidence});
        }
      }
      return matches.sort((a,b)=>b.capture.capturedAt.localeCompare(a.capture.capturedAt)||a.capture.captureKey.localeCompare(b.capture.captureKey));
    });
  }
  async saveMeasurement(result: PromptResult, run: ScanRun, answer: CapturedAnswer | null, analysis: Analysis | null) {
    return this.operation(() => {
      if (result.projectId !== run.projectId || result.runId !== run.id) return;
      if (this.state.results[key(result.projectId,result.runId,result.promptId)]?.version !== result.version) return;
      if (result.captureKey) {
        this.state.savedAnalyses ||= {};
        this.state.savedAnalyses[key(result.projectId, result.responseId)] = copy({
          projectId: result.projectId,
          runId: result.runId,
          promptId: result.promptId,
          responseId: result.responseId,
          captureKey: result.captureKey,
          analysisKey: result.analysisKey,
          version: result.version,
          analysis,
        });
      }
      const measurement = citationMeasurement(result,run,answer,analysis);
      if (!measurement) return;
      this.state.citationCaptures ||= {}; this.state.trackingMatches ||= {};
      const id = key(result.projectId,measurement.capture.captureKey);
      if (!newerCapture(measurement.capture,this.state.citationCaptures[id]?.capture)) return;
      this.state.citationCaptures[id] = copy(measurement);
      for (const url of Object.values(this.state.trackedUrls || {})) {
        if (url.projectId !== result.projectId) continue;
        const matchKey = key(url.projectId,url.id), previous = this.state.trackingMatches[matchKey] || [];
        const eligible = previous.includes(id) || trackingEnabledAt(url,measurement.capture.capturedAt);
        this.state.trackingMatches[matchKey] = previous.filter(item => item !== id);
        if (eligible && measurement.evidence.some(e => e.normalizedUrl === url.normalizedUrl)) this.state.trackingMatches[matchKey].push(id);
      }
    }, true);
  }
  protected async persist(): Promise<void> {}
  protected async operation<T>(fn: () => T, write = false): Promise<T> {
    const work = this.tail.then(async () => {
      const result = fn();
      if (write) await this.persist();
      return copy(result);
    });
    this.tail = work.catch(() => {});
    return work;
  }
  syncUser(value: VerifiedIdentity, seen = false) {
    return this.operation(() => {
      const identity = verifiedIdentitySchema.parse(value);
      this.state.users ||= {};
      const previous = this.state.users[identity.subject];
      if (
        Object.values(this.state.users).some(
          (u) =>
            u.subject !== identity.subject &&
            (u.email === identity.email ||
              u.descopeUserId === identity.externalUserId),
        )
      )
        throw new AccessError(
          409,
          'IDENTITY_CONFLICT',
          'This email or identity is already linked.',
        );
      const now = new Date().toISOString();
      const user: User = {
        id: previous?.id || uuidFor(`user:${identity.subject}`),
        subject: identity.subject,
        descopeUserId: identity.externalUserId,
        email: identity.email,
        name: identity.name,
        lastName: identity.lastName,
        isSystemAdmin: previous?.isSystemAdmin || false,
        disabled: previous?.disabled || false,
        version: previous?.version || 1,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        lastSeenAt: seen ? now : previous?.lastSeenAt || null,
      };
      this.state.users[identity.subject] = user;
      return user;
    }, true);
  }
  getUser(subject: string) {
    return this.operation(() => this.state.users?.[subject] || null);
  }
  getUserById(id: string) {
    return this.operation(
      () =>
        Object.values(this.state.users || {}).find((u) => u.id === id) || null,
    );
  }
  listUsers(options: { offset: number; limit: number; query?: string }) {
    return this.operation(() => {
      const q = options.query?.toLowerCase() || '';
      const users = Object.values(this.state.users || {})
        .filter((u) => `${u.email} ${u.name || ''}`.toLowerCase().includes(q))
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        );
      return {
        items: users.slice(options.offset, options.offset + options.limit),
        total: users.length,
        nextCursor:
          options.offset + options.limit < users.length
            ? Buffer.from(String(options.offset + options.limit)).toString(
                'base64url',
              )
            : null,
      };
    });
  }
  listUserAccounts(id: string) {
    return this.operation(() => {
      const user = Object.values(this.state.users || {}).find(
        (u) => u.id === id,
      );
      return user
        ? Object.values(this.state.members)
            .filter((m) => m.userId === user.subject)
            .map((m) => ({
              projectId: m.projectId,
              projectName:
                this.state.projects[m.projectId]?.name || m.projectId,
              role: m.role,
            }))
        : [];
    });
  }
  private accessTarget(actor: string, id: string, version: number) {
    const admin = this.state.users?.[actor];
    if (!admin?.isSystemAdmin || admin.disabled)
      throw new AccessError(
        403,
        'FORBIDDEN',
        'System administrator access is required.',
      );
    const user = Object.values(this.state.users || {}).find((u) => u.id === id);
    if (!user) throw new AccessError(404, 'USER_NOT_FOUND', 'User not found');
    if (user.version !== version)
      throw new AccessError(
        409,
        'VERSION_CONFLICT',
        'User access changed. Refresh before saving.',
      );
    return user;
  }
  updateUserAccess(
    actor: string,
    id: string,
    version: number,
    input: { isSystemAdmin?: boolean; disabled?: boolean },
  ) {
    return this.operation(() => {
      const user = this.accessTarget(actor, id, version),
        admin = input.isSystemAdmin ?? user.isSystemAdmin,
        disabled = input.disabled ?? user.disabled;
      if (actor === user.subject && (!admin || disabled))
        throw new AccessError(
          409,
          'SELF_LOCKOUT',
          'Another administrator must change your administrator access.',
        );
      if (
        user.isSystemAdmin &&
        !user.disabled &&
        (!admin || disabled) &&
        Object.values(this.state.users).filter(
          (u) => u.isSystemAdmin && !u.disabled,
        ).length <= 1
      )
        throw new AccessError(
          409,
          'LAST_ADMIN',
          'Keep at least one enabled system administrator.',
        );
      user.isSystemAdmin = admin;
      user.disabled = disabled;
      user.version++;
      user.updatedAt = new Date().toISOString();
      return user;
    }, true);
  }
  setUserAccount(
    actor: string,
    id: string,
    projectId: string,
    role: 'owner' | 'viewer' | null,
    version: number,
  ) {
    return this.operation(() => {
      const user = this.accessTarget(actor, id, version);
      if (!this.state.projects[projectId])
        throw new AccessError(404, 'NOT_FOUND', 'Account not found');
      if (role)
        this.state.members[key(projectId, user.subject)] = {
          projectId,
          userId: user.subject,
          role,
        };
      else delete this.state.members[key(projectId, user.subject)];
      user.version++;
      return user;
    }, true);
  }
  bootstrapAdmin(id: string) {
    return this.operation(() => {
      const user = Object.values(this.state.users || {}).find(
        (u) => u.id === id,
      );
      if (!user || user.disabled)
        throw new AccessError(
          404,
          'USER_NOT_FOUND',
          'Sign in through Descope first.',
        );
      const admins = Object.values(this.state.users).filter(
        (u) => u.isSystemAdmin && !u.disabled,
      );
      if (admins.length) {
        if (admins.length === 1 && admins[0].id === id) return user;
        throw new AccessError(
          409,
          'BOOTSTRAP_CLOSED',
          'An administrator already exists.',
        );
      }
      user.isSystemAdmin = true;
      user.version++;
      return user;
    }, true);
  }
  getProject(id: string) {
    return this.operation(() => this.state.projects[id] || null);
  }
  listProjects(userId: string) {
    return this.operation(() => {
      const user = this.state.users?.[userId];
      if (user?.isSystemAdmin && !user.disabled)
        return Object.values(this.state.projects).map((p) => ({
          ...p,
          role: 'owner' as const,
        }));
      return Object.values(this.state.members)
        .filter((m) => m.userId === userId)
        .flatMap((m) =>
          this.state.projects[m.projectId]
            ? [{ ...this.state.projects[m.projectId], role: m.role }]
            : [],
        );
    });
  }
  async listProjectSummaries(
    userId: string,
    options: { offset: number; limit: number; query?: string },
  ) {
    const q = options.query?.toLocaleLowerCase() || '';
    const projects = (await this.listProjects(userId))
      .filter((project) =>
        `${project.name} ${project.brand.domains.join(' ')}`
          .toLocaleLowerCase()
          .includes(q),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    const items: Project[] = [];
    for (const project of projects.slice(
      options.offset,
      options.offset + options.limit,
    )) {
      const job = project.onboardingJobId
        ? await this.getOnboarding(project.id, project.onboardingJobId)
        : null;
      items.push({
        ...project,
        prompts: [],
        brandbook: undefined,
        activePromptCount: project.prompts.filter((prompt) => prompt.active)
          .length,
        onboardingSummary: job
          ? {
              status: job.status,
              step: job.step,
              error: job.error,
              firstRunId: job.firstRunId,
            }
          : undefined,
      });
    }
    return {
      items,
      total: projects.length,
      nextCursor:
        options.offset + options.limit < projects.length
          ? Buffer.from(String(options.offset + options.limit)).toString(
              'base64url',
            )
          : null,
    };
  }
  async saveProject(project: Project, expectedVersion: number | null) {
    if (Buffer.byteLength(JSON.stringify(project), 'utf8') > 300000)
      throw new Error('Project configuration exceeds the 300 KB limit');
    return this.operation(() => {
      const previous = this.state.projects[project.id];
      if (
        expectedVersion === null
          ? !!previous
          : previous?.version !== expectedVersion
      )
        return false;
      this.state.projects[project.id] = copy(project);
      return true;
    }, true);
  }
  getMembership(projectId: string, userId: string) {
    return this.operation(
      () => this.state.members[key(projectId, userId)] || null,
    );
  }
  putMembership(member: Membership) {
    return this.operation(() => {
      if (!this.state.users?.[member.userId])
        throw new AccessError(
          404,
          'USER_NOT_FOUND',
          'Register the user first.',
        );
      this.state.members[key(member.projectId, member.userId)] = copy(member);
    }, true);
  }
  createRun(run: ScanRun, results: PromptResult[]) {
    return this.operation(() => {
      if (this.state.runs[key(run.projectId, run.id)]) return false;
      if (
        results.length !== run.totalCount ||
        results.length > 50 ||
        results.length === 0 ||
        new Set(results.map((r) => r.promptId)).size !== results.length
      )
        throw new Error('Invalid run manifest');
      this.state.runs[key(run.projectId, run.id)] = copy(run);
      results.forEach((result) => {
        this.state.results[key(run.projectId, run.id, result.promptId)] =
          copy(result);
      });
      return true;
    }, true);
  }
  getRun(projectId: string, runId: string) {
    return this.operation(() => this.state.runs[key(projectId, runId)] || null);
  }
  listRuns(projectId: string, limit = 60) {
    return this.operation(() =>
      Object.values(this.state.runs)
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, limit),
    );
  }
  listPromptHistory(
    projectId: string,
    start: string,
    end: string,
    promptId?: string,
  ) {
    return this.operation(() => {
      const runs = Object.values(this.state.runs).filter(
        (run) => run.projectId === projectId,
      );
      const byId = new Map(runs.map((run) => [run.id, run]));
      const results = Object.values(this.state.results).filter((result) => {
        const run = byId.get(result.runId);
        const at = Date.parse(result.capturedAt || run?.createdAt || '');
        return (
          result.projectId === projectId &&
          (!promptId || result.promptId === promptId) &&
          run &&
          at >= Date.parse(start) &&
          at <= Date.parse(end)
        );
      });
      const used = new Set(results.map((result) => result.runId));
      return { runs: runs.filter((run) => used.has(run.id)), results };
    });
  }
  listActiveRuns() {
    return this.operation(() =>
      Object.values(this.state.runs).filter(
        (r) => r.status === 'queued' || r.status === 'running',
      ),
    );
  }
  listResults(projectId: string, runId: string) {
    return this.operation(() =>
      Object.values(this.state.results)
        .filter((r) => r.projectId === projectId && r.runId === runId)
        .sort((a, b) => a.promptId.localeCompare(b.promptId)),
    );
  }
  getResult(projectId: string, runId: string, promptId: string) {
    return this.operation(
      () => this.state.results[key(projectId, runId, promptId)] || null,
    );
  }
  commitResult(next: PromptResult, previous: PromptResult) {
    return this.operation(() => {
      const id = key(previous.projectId, previous.runId, previous.promptId);
      const current = this.state.results[id],
        run = this.state.runs[key(previous.projectId, previous.runId)];
      if (!current || current.version !== previous.version || !run)
        return false;
      if (
        next.version !== previous.version + 1 ||
        key(next.projectId, next.runId, next.promptId) !== id
      )
        throw new Error('Invalid result transition');
      this.state.results[id] = copy(next);
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
      return true;
    }, true);
  }
  markRunRunning(projectId: string, runId: string, deadlineAt?: string) {
    return this.operation(() => {
      const run = this.state.runs[key(projectId, runId)];
      if (run && run.terminalCount < run.totalCount) {
        run.status = 'running';
        run.startedAt ||= new Date().toISOString();
        delete run.completedAt;
        if (deadlineAt) run.deadlineAt = deadlineAt;
      }
    }, true);
  }
  finalizeRun(
    projectId: string,
    runId: string,
    resultVersion: number,
    status: 'completed' | 'partial' | 'failed',
    summaryKey: string,
    completedAt: string,
  ) {
    return this.operation(() => {
      const run = this.state.runs[key(projectId, runId)];
      if (
        !run ||
        run.resultVersion !== resultVersion ||
        run.terminalCount !== run.totalCount
      )
        return false;
      Object.assign(run, {
        status,
        summaryKey,
        summaryVersion: resultVersion,
        completedAt,
      });
      return true;
    }, true);
  }
}

export class FileRepository extends MemoryRepository {
  private constructor(private path: string) {
    super();
  }
  static async open(path: string): Promise<FileRepository> {
    const repository = new FileRepository(path);
    try {
      repository.state = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return repository;
  }
  protected async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.state), {
      mode: 0o600,
    });
    await rename(`${this.path}.tmp`, this.path);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return copy((this.values.get(key) as T) ?? null);
  }
  async put(key: string, value: unknown) {
    this.values.set(key, copy(value));
  }
}
export class FileArtifacts implements ArtifactStore {
  constructor(private root: string) {}
  private path(key: string) {
    const path = resolve(this.root, `${key}.json`);
    if (!path.startsWith(`${resolve(this.root)}${sep}`))
      throw new Error('Invalid artifact key');
    return path;
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async put(key: string, value: unknown) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
}
export class MemoryQueue implements JobQueue {
  readonly messages: ScanMessage[] = [];
  async send(messages: ScanMessage[]) {
    this.messages.push(...copy(messages));
  }
}
