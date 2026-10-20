export type Sentiment =
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'mixed'
  | 'unknown'
  | 'not_applicable';
export type ScanProvider = 'openai' | 'perplexity' | 'gemini';
export interface ScanProviderConfig {
  provider: ScanProvider;
  model: string;
}
export interface Brand {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
}
export type JourneyStage = 'understand' | 'prefer' | 'trust' | 'convert';
export interface Prompt {
  id: string;
  text: string;
  version: number;
  active: boolean;
  branded: boolean;
  createdAt: string;
  updatedAt: string;
  stage?: JourneyStage;
  topic?: string;
  generationId?: string;
}
export interface Project {
  id: string;
  name: string;
  brand: Brand;
  competitors: Brand[];
  country: string;
  language: string;
  timezone: string;
  scheduleExpression: string;
  enabled: boolean;
  generationModel: string;
  extractionModel: string;
  parserVersion: string;
  version: number;
  prompts: Prompt[];
  createdAt: string;
  updatedAt: string;
  scheduleStatus?: 'pending' | 'synced' | 'error';
  nextScanAt?: string;
  role?: 'owner' | 'viewer';
  lastManualRequest?: { runId: string; requestId: string; requestedAt: string };
  brandbook?: Brandbook;
  onboardingJobId?: string;
  onboardingAppliedJobId?: string;
  activePromptCount?: number;
  onboardingSummary?: Pick<
    OnboardingJob,
    'status' | 'step' | 'error' | 'firstRunId'
  >;
  scanProviders?: ScanProviderConfig[];
}
export interface Membership {
  projectId: string;
  userId: string;
  role: 'owner' | 'viewer';
}
export interface RunSnapshot {
  projectName: string;
  brand: Brand;
  competitors: Brand[];
  prompts: Prompt[];
  country: string;
  language: string;
  timezone: string;
  generationModel: string;
  extractionModel: string;
  parserVersion: string;
  configVersion: number;
  provider?: ScanProvider;
  scanProviders?: ScanProviderConfig[];
}
export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed';
export interface ScanRun {
  groupId?: string;
  projectId: string;
  id: string;
  scheduledAt: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  trigger: 'scheduled' | 'manual';
  snapshot: RunSnapshot;
  totalCount: number;
  terminalCount: number;
  succeededCount: number;
  capturedCount: number;
  resultVersion: number;
  summaryKey?: string;
  summaryVersion?: number;
  deadlineAt: string;
  expiresAt: number;
}
export type ResultStatus =
  | 'queued'
  | 'collecting'
  | 'captured'
  | 'extracting'
  | 'succeeded'
  | 'refused'
  | 'incomplete'
  | 'failed_collection'
  | 'failed_extraction';
export interface EvidenceSpan {
  blockId: string;
  quote: string;
  start: number;
  end: number;
}
export interface BrandAnalysis {
  brandId: string;
  mentioned: boolean;
  explicitRank: number | null;
  mentionOrder: number | null;
  sentiment: Sentiment;
  evidence: EvidenceSpan[];
  rankEvidence: EvidenceSpan | null;
  sentimentEvidence: EvidenceSpan | null;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchCalls?: number;
  searchQueries?: number;
}
export interface Analysis {
  brands: BrandAnalysis[];
  parserVersion: string;
  model: string;
  createdAt: string;
  usage: Usage;
  raw?: unknown;
}
export interface TextBlock {
  id: string;
  text: string;
}
export interface Citation {
  id: string;
  blockId: string;
  url: string;
  title: string;
  start: number | null;
  end: number | null;
}
export interface RetrievedSource {
  url: string;
  title?: string;
  type?: string;
}
export interface CapturedAnswer {
  provider?: ScanProvider;
  providerResponseId: string;
  requestId?: string;
  model: string;
  status: 'completed' | 'refused' | 'incomplete';
  blocks: TextBlock[];
  text: string;
  citations: Citation[];
  sources: RetrievedSource[];
  usage: Usage;
  createdAt: string;
  raw: unknown;
  refusal?: string;
  searchSuggestions?: string[];
}
export interface ScanError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface PromptResult {
  projectId: string;
  runId: string;
  promptId: string;
  responseId: string;
  prompt: Prompt;
  status: ResultStatus;
  version: number;
  attempts: number;
  captureGeneration?: number;
  lastRetryRequestId?: string;
  lastRetryRequestedAt?: string;
  retryRequestIds?: string[];
  leaseOwner?: string;
  leaseExpiresAt?: string;
  captureKey?: string;
  analysisKey?: string;
  target?: BrandAnalysis;
  brands?: BrandAnalysis[];
  citationCount: number;
  sourceCount: number;
  capturedAt?: string;
  completedAt?: string;
  error?: ScanError;
  model?: string;
  usage?: Usage;
  extractionUsage?: Usage;
  expiresAt: number;
}
export interface Metric {
  value: number | null;
  numerator: number;
  denominator: number;
}
export interface Metrics {
  visibility: Metric;
  averageRank: Metric;
  captured: number;
  analyzed: number;
  mentioned: number;
  ranked: number;
  citations: number;
  uniqueDomains: number;
  uniqueUrls: number;
  sentiment: Record<Sentiment, number>;
}
export interface SourceRow {
  id: string;
  domain: string;
  url?: string;
  title?: string;
  kind: 'cited' | 'consulted';
  owned: boolean;
  answerCount: number;
  citationCount: number;
  uniqueUrlCount: number;
  coverage: number | null;
  responseIds: string[];
}
export interface RunSummary {
  metrics: Metrics;
  domains: SourceRow[];
  urls: SourceRow[];
  consultedDomains: SourceRow[];
  consultedUrls: SourceRow[];
  createdAt: string;
  resultVersion: number;
}
export interface ResponseDetail {
  result: PromptResult;
  run: ScanRun;
  answer: CapturedAnswer | null;
  analysis: Analysis | null;
}
export interface TrendPoint {
  runId: string;
  date: string;
  visibility: number | null;
  averageRank: number | null;
  status: RunStatus;
  analyzed: number;
  total: number;
  comparable: boolean;
}
export interface Dashboard {
  project: Project;
  run: ScanRun | null;
  metrics: Metrics;
  trend: TrendPoint[];
  topSources: SourceRow[];
  comparison: {
    visibilityDelta: number | null;
    previousRunId: string | null;
    comparableCount: number;
    reason: string | null;
  };
  nextScanAt: string | null;
  mode: 'live';
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}
export type ScanMessage =
  | {
      kind: 'kickoff';
      projectId: string;
      scheduledAt: string;
      requestId?: string;
      trigger?: 'scheduled' | 'manual';
    }
  | { kind: 'prompt'; projectId: string; runId: string; promptId: string }
  | { kind: 'retry'; projectId: string; runId: string; requestId: string }
  | { kind: 'onboard'; projectId: string; jobId: string }
  | { kind: 'reconcile' };
export const TERMINAL_STATUSES: ResultStatus[] = [
  'succeeded',
  'refused',
  'incomplete',
  'failed_collection',
  'failed_extraction',
];
export const isTerminal = (status: ResultStatus) =>
  TERMINAL_STATUSES.includes(status);
export const RETENTION_DAYS = 400;
export const PARSER_VERSION = 'brand-evidence-v1';

export interface Brandbook {
  about: string;
  industryCategory: string;
  subIndustryCategory: string;
  companyCountry: string;
  language: string;
  names: string[];
  domains: string[];
  keyFeatures: string[];
  toneOfVoice: string[];
  values: string[];
  personality: string[];
  targetAudience: string[];
  knowledgeSources: string[];
  sitemapUrl: string | null;
  caseStudiesSourceUrl: string | null;
  caseStudies: {
    id: string;
    title: string;
    sourceUrl: string;
    content: string;
    importedAt: string;
    enabled: boolean;
  }[];
  postGuidelines: { dos: string[]; donts: string[] };
  evidence: { field: string; quote: string; url: string }[];
  unknowns: string[];
  generatedAt: string;
  model: string;
  version: number;
  generationId: string;
}
export interface AccountOnboardingInput {
  name: string;
  region: string;
  language: string;
  website: string;
}
/** Persisted worker context. Older jobs may retain manual prompts and company notes. */
export interface OnboardingInput {
  name: string;
  website: string;
  country: string;
  language: string;
  timezone: string;
  description: string;
  manualPrompts: { text: string; stage: JourneyStage }[];
}
export type OnboardingStep =
  | 'research'
  | 'brandbook'
  | 'prompts'
  | 'activate'
  | 'completed';
export interface OnboardingJob {
  id: string;
  projectId: string;
  ownerId: string;
  requestId: string;
  inputHash: string;
  input: OnboardingInput;
  step: OnboardingStep;
  status: 'queued' | 'running' | 'failed' | 'completed';
  version: number;
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  researchKey?: string;
  brandbookKey?: string;
  promptsKey?: string;
  firstRunId?: string;
  error?: { code: string; message: string };
  retryRequestIds: string[];
}
