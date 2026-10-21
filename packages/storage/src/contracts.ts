import type {
  CapturedAnswer,
  Analysis,
  Membership,
  OnboardingJob,
  Project,
  PromptResult,
  ScanMessage,
  ScanRun,
  RunSummary,
  PromptHistory,
} from '@citevia/core';
import type { UserRepository } from './users.js';
export interface Repository extends UserRepository {
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
  ): Promise<void>;
  getProject(id: string): Promise<Project | null>;
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
  createRun(run: ScanRun, results: PromptResult[]): Promise<boolean>;
  getRun(projectId: string, runId: string): Promise<ScanRun | null>;
  listRuns(projectId: string, limit?: number): Promise<ScanRun[]>;
  listPromptHistory(
    projectId: string,
    start: string,
    end: string,
    promptId?: string,
  ): Promise<PromptHistory>;
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
}
export interface JobQueue {
  send(messages: ScanMessage[]): Promise<void>;
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
export interface ScannerDependencies extends Runtime {
  provider: AnswerProvider;
  now?: () => Date;
  onboarding?: {
    handle(projectId: string, jobId: string): Promise<void>;
    reconcile(): Promise<void>;
    deadLetter(projectId: string, jobId: string): Promise<void>;
  };
}
export type { CapturedAnswer, Analysis, RunSummary };
