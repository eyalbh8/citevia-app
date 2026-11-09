import type {
  CapturedAnswer,
  Citation,
  Analysis,
  Membership,
  OnboardingJob,
  Project,
  PromptResult,
  ScanMessage,
  ScanRun,
  RunSummary,
  PromptHistory,
  TrackedUrl,
  TrackingMatch,
  TrafficEvent,
  TrafficStatus,
  TrafficFilters,
  TrafficAggregate,
  TrafficInstallationReceipt,
  AgentPostJob,
  AgentImage,
  WebsiteHealthJob,
  ScanProvider,
  SocialPublication,
  ReserveSocialOccurrenceInput,
  ReserveSocialOccurrenceResult,
  SocialOccurrenceMessage,
  SocialGenerationMessage,
} from '@citevia/core';
import type { UserRepository } from './users.js';
import type { McpRepository } from './mcp.js';
import type { ScanDispatchStore } from './scan-dispatch.js';
import type { GeoBacklinkRepository } from './geo-backlinks.js';
export interface SavedAnalysisRef {
  responseId: string;
  captureKey: string;
  analysisKey?: string;
}
export interface SavedAnalysis {
  responseId: string;
  analysis: Analysis | null;
}
export interface PromptAnswerPageOptions {
  start: string;
  end: string;
  promptId: string;
  provider?: ScanProvider;
  sort: 'date' | 'model' | 'rank' | 'citations' | 'sentiment';
  direction: 'asc' | 'desc';
  offset: number;
  limit: number;
}
export interface PromptAnswerPage {
  items: { result: PromptResult; run: ScanRun }[];
  total: number;
}
export interface TrackingMatchOptions {
  /** Inclusive capture-time bounds; omit start to retain lifecycle history. */
  start?: string;
  end?: string;
}
export interface SocialReviewLink {
  projectId: string;
  /** SHA-256 digest of an independently random bearer credential. */
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  publications: {
    id: string; version: number; contentHash: string; brandName: string;
    destination: string; channel: 'facebook' | 'instagram'; scheduledAt: string;
  }[];
}
export interface Repository extends UserRepository, McpRepository, GeoBacklinkRepository {
  /** Atomically select a prompt and reserve every eligible connected destination once. */
  reserveSocialOccurrence(input: ReserveSocialOccurrenceInput): Promise<ReserveSocialOccurrenceResult>;
  getSocialPublication(projectId: string, publicationId: string): Promise<SocialPublication | null>;
  listActiveSocialPublications(limit?: number, now?: string): Promise<SocialPublication[]>;
  listSocialPublications(projectId: string, offset: number, limit: number, clientReviewOnly?: boolean): Promise<{ items: SocialPublication[]; total: number }>;
  createSocialReviewLink(link: SocialReviewLink): Promise<void>;
  getSocialReviewLink(projectId: string, id: string, now: string): Promise<SocialReviewLink | null>;
  listSocialReviewLinks(projectId: string, now: string): Promise<SocialReviewLink[]>;
  revokeSocialReviewLink(projectId: string, id: string): Promise<boolean>;
  getSocialReviewPosts(projectId: string, ids: string[]): Promise<SocialPublication[]>;
  saveSocialPublication(publication: SocialPublication, expectedVersion: number, reviewLinkId?: string): Promise<boolean>;
  getWebsiteHealthAudit(projectId: string, auditId: string): Promise<WebsiteHealthJob | null>;
  listWebsiteHealthAudits(projectId: string, offset: number, limit: number): Promise<{ items: WebsiteHealthJob[]; total: number }>;
  listActiveWebsiteHealthAudits(): Promise<WebsiteHealthJob[]>;
  /** One active audit per account; new audits are separated by at least 60 seconds. */
  reserveWebsiteHealthAudit(job: WebsiteHealthJob, expectedVersion: null): Promise<'saved' | 'conflict' | 'limit'>;
  saveWebsiteHealthAudit(job: WebsiteHealthJob, expectedVersion: number): Promise<boolean>;
  /** Atomically claim a photo forever within this account/channel; recover this generation’s claim. */
  reserveAgentImage(post: AgentPostJob, image?: AgentImage): Promise<AgentImage | null>;
  getAgentPost(projectId: string, postId: string): Promise<AgentPostJob | null>;
  listAgentPosts(projectId: string, offset: number, limit: number): Promise<{ items: AgentPostJob[]; total: number }>;
  listActiveAgentPosts(): Promise<AgentPostJob[]>;
  reserveAgentPost(post: AgentPostJob, expectedVersion: number | null): Promise<'saved' | 'conflict' | 'limit'>;
  saveAgentPost(post: AgentPostJob, expectedVersion: number): Promise<boolean>;
  recordTrafficInstallation(receipt: TrafficInstallationReceipt): Promise<void>;
  collectTrafficEvent(event: TrafficEvent): Promise<void>;
  trafficStatus(projectId: string, testId?: string): Promise<TrafficStatus>;
  aggregateTraffic(projectId: string, filters: TrafficFilters): Promise<TrafficAggregate>;
  /** A returned null is authoritative. Omitted responses require legacy artifact lookup. */
  listSavedAnalyses(
    projectId: string,
    refs: SavedAnalysisRef[],
  ): Promise<SavedAnalysis[]>;
  /** Provider-qualified capture keys. Includes indexed captures with zero native citations. */
  listNativeCitations(
    projectId: string,
    captureKeys: string[],
  ): Promise<{ captureKey: string; citations: Citation[] }[]>;
  listTrackedUrls(projectId: string): Promise<TrackedUrl[]>;
  registerTrackedUrl(url: TrackedUrl): Promise<TrackedUrl>;
  updateTrackedUrl(url: TrackedUrl, expectedVersion: number): Promise<boolean>;
  listTrackingMatches(projectId: string, trackedUrlId?: string, options?: TrackingMatchOptions): Promise<TrackingMatch[]>;
  createOnboarding(
    project: Project,
    job: OnboardingJob,
    maxAccounts: number,
  ): Promise<'created' | 'exists' | 'limit'>;
  getOnboarding(
    projectId: string,
    jobId: string,
  ): Promise<OnboardingJob | null>;
  saveOnboarding(job: OnboardingJob, expectedVersion: number): Promise<boolean>;
  listActiveOnboarding(): Promise<OnboardingJob[]>;
  saveMeasurement(
    result: PromptResult,
    run: ScanRun,
    answer: CapturedAnswer | null,
    analysis: Analysis | null,
    options?: { force?: boolean },
  ): Promise<void>;
  getProject(id: string): Promise<Project | null>;
  getProjectByAccountUuid(accountUuid: string): Promise<Project | null>;
  /** Assign stable fleet slots once, atomically across accounts. Custom legacy cron is preserved. */
  ensureProjectScanSchedule(id: string, options?: { migrateCustom?: boolean }): Promise<Project | null>;
  listProjects(userId: string): Promise<Project[]>;
  listProjectSummaries(
    userId: string,
    options: { offset: number; limit: number; query?: string },
  ): Promise<{ items: Project[]; total: number; nextCursor: string | null }>;
  saveProject(
    project: Project,
    expectedVersion: number | null,
  ): Promise<boolean>;
  getMembership(projectId: string, userId: string): Promise<Membership | null>;
  putMembership(membership: Membership): Promise<void>;
  createRun(run: ScanRun, results: PromptResult[], options?: { onlyIfScheduledAccountIdle?: boolean }): Promise<boolean>;
  getRun(projectId: string, runId: string): Promise<ScanRun | null>;
  listRuns(projectId: string, limit?: number): Promise<ScanRun[]>;
  listPromptHistory(
    projectId: string,
    start: string,
    end: string,
    promptId?: string,
  ): Promise<PromptHistory>;
  /** Null retains legacy ordering for model collation or ambiguous old capture identities. */
  listPromptAnswerPage?(projectId: string, options: PromptAnswerPageOptions): Promise<PromptAnswerPage | null>;
  listActiveRuns(): Promise<ScanRun[]>;
  listResults(projectId: string, runId: string): Promise<PromptResult[]>;
  getResult(
    projectId: string,
    runId: string,
    promptId: string,
  ): Promise<PromptResult | null>;
  // CAS result + counter deltas + increment run.resultVersion atomically. next.version must be previous.version+1.
  commitResult(next: PromptResult, previous: PromptResult): Promise<boolean>;
  markRunRunning(
    projectId: string,
    runId: string,
    deadlineAt?: string,
  ): Promise<void>;
  // Conditional on resultVersion; only publish summary when every result is terminal.
  finalizeRun(
    projectId: string,
    runId: string,
    resultVersion: number,
    status: 'completed' | 'partial' | 'failed',
    summaryKey: string,
    completedAt: string,
  ): Promise<boolean>;
}
export interface ArtifactStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  /** Atomically reserve an immutable artifact key. A duplicate returns false. */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
}
export interface JobQueue {
  send(messages: ScanMessage[], delaySeconds?: number): Promise<void>;
}
export interface Runtime {
  repository: Repository;
  artifacts: ArtifactStore;
  queue: JobQueue;
}
export interface AnswerProvider {
  collect(
    prompt: string,
    snapshot: ScanRun['snapshot'],
  ): Promise<CapturedAnswer>;
  extract(
    answer: CapturedAnswer,
    snapshot: ScanRun['snapshot'],
  ): Promise<Analysis>;
}
export interface AnalysisBatchUpdate {
  promptId: string;
  captureKey: string;
  analysisAttempt?: number;
  retryRequestId?: string;
  analysisKey?: string;
  analysis?: Analysis;
  error?: import('@citevia/core').ScanError;
}
export interface AnalysisBatchPort {
  process(run: ScanRun, results: PromptResult[]): Promise<{
    batchId?: string;
    /** Fixed processing window measured from actual batch submission, never from a poll. */
    deadlineAt?: string;
    updates: AnalysisBatchUpdate[];
  }>;
  complete(batchId: string): Promise<void>;
}
export interface ScannerDependencies extends Runtime {
  geoBacklinks?: {
    handle(projectId: string, month: string): Promise<void>;
    progress(projectId: string, date: string): Promise<void>;
    reconcile(): Promise<void>;
  };
  socialAutomation?: {
    handleGeneration(message: SocialGenerationMessage): Promise<void>;
    handleOccurrence(message: SocialOccurrenceMessage): Promise<void>;
    handlePublication(projectId: string, publicationId: string): Promise<void>;
    reconcile(): Promise<void>;
    deadLetter(projectId: string, publicationId: string): Promise<void>;
  };
  websiteHealth?: {
    handle(projectId: string, auditId: string): Promise<void>;
    reconcile(): Promise<void>;
    deadLetter(projectId: string, auditId: string): Promise<void>;
  };
  dispatch?: ScanDispatchStore;
  analysisBatch?: AnalysisBatchPort;
  maintenance?: { reconcile(): Promise<void> };
  agents?: {
    handle(projectId: string, postId: string): Promise<void>;
    reconcile(): Promise<void>;
    deadLetter(projectId: string, postId: string): Promise<void>;
  };
  provider: AnswerProvider;
  now?: () => Date;
  onboarding?: {
    handle(projectId: string, jobId: string): Promise<void>;
    reconcile(): Promise<void>;
    deadLetter(projectId: string, jobId: string): Promise<void>;
  };
}
export type { CapturedAnswer, Analysis, RunSummary };
