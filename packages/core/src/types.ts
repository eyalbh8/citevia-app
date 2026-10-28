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
  intent?: import('./prompt-policy.js').PromptIntent;
  seoKeyword?: string;
  tags?: string[];
}
export interface Project {
  /** Explicit synthetic scenario; never dispatches paid scans or records real visits. */
  demo?: DemoConfig;
  id: string;
  name: string;
  brand: Brand;
  competitors: Brand[];
  /** Records an explicit owner choice, including choosing no competitors. */
  competitorsConfiguredAt?: string;
  country: string;
  language: string;
  timezone: string;
  scheduleExpression: string;
  /** Two stable weekly UTC slots; account timezone is only used for display. */
  scanSchedule?: { version: 1; slotsUtcMinutes: [number, number]; activatedAt?: string };
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
  portfolioRefresh?: {
    id: string;
    status: 'generating' | 'completed' | 'failed';
    requestedAt: string;
    promptHash: string;
    brandbookHash: string;
    error?: string;
  };
}
export interface DemoConfig {
  version: 1;
  source: 'igeo-nayax' | 'igeo-dr-roof' | 'website-demo';
  /** Company-discovery scenarios always name and cite at least one researched provider. */
  companyDiscovery?: true;
  /** An explicitly labeled illustration layered over preserved source observations. */
  presentation?: { label: string; targetRank: number; mentionCount: number; reportingOnly: true };
  anchorDate: string;
  startDate: string;
  endDate: string;
  sourceAccountId: string;
  sourceCopiedAt: string;
  /** Optional, bounded variations on the original Nayax scenario. */
  profile?: {
    visibilityAdjustment?: number;
    growthCurve?: number;
    trafficScale?: number;
    monthlyGrowth?: number;
  };
  /** Public-website scenarios use this context instead of payment/roofing defaults. */
  industry?: { label: string; audience: string; services: string[]; criteria: string[] };
  copy?: {
    introduction: string;
    /** Sentence suffix after the company name; include its initial space. */
    positiveCompany: string;
    neutralCompany?: string;
    fallback: string;
  };
  samples?: {
    promptId?: string;
    promptText?: string;
    answerText: string;
    citations?: { url: string; title?: string }[];
    companies?: string[];
  }[];
  traffic?: { pages?: string[]; countries?: string[]; browsers?: string[]; devices?: string[] };
  trackedUrls?: {
    url: string;
    title: string;
    publishedAt: string;
    createdAt?: string;
    contentType?: 'BLOG' | 'WEBSITE' | 'SOCIAL';
    imageUrl?: string;
    sourcePublishedAt?: string;
    sourceTrackedAt?: string;
    trackingPeriods?: { start: string; end: string | null }[];
    /** Drafts are hosted by Citevia and never imply publication on the brand website. */
    demoPost?: true;
    body?: string;
    provenance?: { kind: 'demo-draft'; sourceUrls: string[] };
  }[];
}
export interface Membership {
  projectId: string;
  userId: string;
  role: 'owner' | 'viewer';
}
export interface RunSnapshot {
  /** Tenant scope for private analysis caches and usage attribution. */
  projectId?: string;
  analysisMode?: 'realtime' | 'batch';
  extractionFallbackModel?: string;
  /** Per-call attribution, never part of the frozen measurement methodology. */
  execution?: { runId: string; promptId: string; attempt: number };
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
  /** Retained manifest prevents delayed kickoff deliveries from recreating a deleted scan. */
  cancelledAt?: string;
  /** Preserve this scan and its evidence while omitting it from aggregate reporting. */
  reportingExcludedAt?: string;
  reportingExclusionReason?: string;
  reanalysisOf?: string;
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
  | 'analysis_pending'
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
  /** iGEO rank among all identified companies, including untracked alternatives. */
  appearanceRank?: number | null;
  sentimentScore?: number | null;
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
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  searchCalls?: number;
  searchQueries?: number;
}
export interface CompanyAnalysis {
  name: string;
  rank: number;
  evidence: EvidenceSpan;
  /** Optional on older captures, which did not assess untracked companies. */
  sentiment?: Exclude<Sentiment, 'not_applicable'>;
  sentimentScore?: number | null;
  sentimentEvidence?: EvidenceSpan | null;
}
export interface Analysis {
  /** Reference to an exact compatible saved analysis reused without a model call. */
  reusedFrom?: string;
  brands: BrandAnalysis[];
  validationVersion?: string;
  validationWarnings?: string[];
  companies?: CompanyAnalysis[];
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
  kind?: 'rate_limit' | 'quota' | 'transient' | 'permanent' | 'uncertain' | 'deferred';
  safeToRetry?: boolean;
  retryAfterMs?: number;
  providerCode?: string;
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
  /** Durable paid-call budgets: the initial call plus at most three retries per stage. */
  collectionAttempts?: number;
  analysisAttempts?: number;
  /** A checkpoint written before a provider call; an interrupted call is never replayed blindly. */
  pendingCallStage?: 'collection' | 'analysis';
  /** Only a definitive provider rejection or explicit manual retry permits another paid call. */
  safeRetryStage?: 'collection' | 'analysis';
  retryNotBefore?: string;
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
  sentimentScore: Metric;
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
  promptCount: number;
  /** Citation occurrences / captured answers; may exceed 100%, unlike coverage. */
  usedPercent: number | null;
  avgCitations: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface ReportingGroup {
  key: string;
  promptCount: number;
  metrics: Pick<
    Metrics,
    | 'visibility'
    | 'averageRank'
    | 'sentimentScore'
    | 'captured'
    | 'analyzed'
    | 'mentioned'
    | 'ranked'
    | 'sentiment'
  >;
}
export interface ReportingGroups {
  stages: ReportingGroup[];
  topics: ReportingGroup[];
  branding: ReportingGroup[];
  intents: ReportingGroup[];
}
export interface RunSummary {
  reportingVersion: number;
  groups: ReportingGroups;
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
export interface PromptAnswerRow {
  responseId: string;
  promptText: string;
  promptVersion: number;
  provider: ScanProvider;
  model: string;
  date: string;
  country: string;
  status: ResultStatus;
  answerPreview: string | null;
  visibility: number | null;
  rank: number | null;
  sentimentScore: number | null;
  brands: string[];
  citationCount: number;
}
export interface TrendPoint {
  runId: string;
  date: string;
  visibility: number | null;
  averageRank: number | null;
  sentimentScore: number | null;
  citations: number;
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
  groups: ReportingGroups;
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
  | { kind: 'website-health'; projectId: string; auditId: string }
  | { kind: 'agent-post'; projectId: string; postId: string }
  | {
      kind: 'kickoff';
      projectId: string;
      scheduledAt: string;
      requestId?: string;
      trigger?: 'scheduled' | 'manual';
      scheduleVersion?: 1;
      scheduleSlotUtcMinute?: number;
    }
  | { kind: 'prompt'; projectId: string; runId: string; promptId: string; dispatchToken?: string }
  | { kind: 'retry'; projectId: string; runId: string; requestId: string }
  | { kind: 'onboard'; projectId: string; jobId: string }
  | { kind: 'reconcile' }
  | { kind: 'reconcile-run'; projectId: string; runId: string }
  | { kind: 'dispatch' };
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
export const PARSER_VERSION = 'igeo-evidence-v2';

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
  status: 'queued' | 'running' | 'failed' | 'stopped' | 'completed';
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
  paidCall?: {
    id: string;
    step: 'research' | 'brandbook' | 'prompts';
    startedAt: string;
  };
  error?: { code: string; message: string };
  retryRequestIds: string[];
}
