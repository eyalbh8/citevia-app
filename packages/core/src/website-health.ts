export type WebsiteHealthDevice = 'mobile' | 'desktop';
export type WebsiteHealthCategory = 'performance' | 'accessibility' | 'best-practices' | 'seo';
export type WebsiteHealthRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';
export type WebsiteHealthScope = 'page' | 'site';
export const WEBSITE_HEALTH_DEFAULT_PAGES = 100;
export const WEBSITE_HEALTH_MAX_PAGES = 500;

export interface WebsiteHealthMetric {
  id: string;
  title: string;
  value: number | null;
  unit: 'ms' | 'unitless';
  displayValue: string;
  rating: WebsiteHealthRating;
}
export interface WebsiteHealthIssue {
  id: string;
  category: WebsiteHealthCategory;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  savingsMs?: number;
  savingsBytes?: number;
  resources: string[];
}
export interface WebsiteHealthLabResult {
  strategy: WebsiteHealthDevice;
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  lighthouseVersion: string;
  scores: Record<WebsiteHealthCategory, number | null>;
  metrics: WebsiteHealthMetric[];
  issues: WebsiteHealthIssue[];
  warnings: string[];
}
export interface WebsiteHealthFieldResult {
  status: 'available' | 'unavailable' | 'error' | 'not_configured';
  scope?: 'url' | 'origin';
  url?: string;
  collectionPeriod?: { start: string; end: string };
  metrics: WebsiteHealthMetric[];
  message?: string;
}
export interface WebsiteHealthDeviceResult {
  status: 'queued' | 'running' | 'completed' | 'failed';
  lab?: WebsiteHealthLabResult;
  field?: WebsiteHealthFieldResult;
  error?: { code: string; message: string };
}
export interface WebsiteHealthAudit {
  /** Collection rows retain scores; fetch the detail endpoint for metrics and recommendations. */
  summaryOnly?: boolean;
  id: string;
  projectId: string;
  url: string;
  /** Missing on older single-page audits. */
  scope?: WebsiteHealthScope;
  site?: WebsiteHealthSite;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  results: Record<WebsiteHealthDevice, WebsiteHealthDeviceResult>;
}
export interface WebsiteHealthSitePage {
  id: string;
  url: string;
  status: WebsiteHealthAudit['status'];
  /** Scores only; detailed measurements are loaded separately from private artifacts. */
  results: Record<WebsiteHealthDevice, WebsiteHealthDeviceResult>;
}
export interface WebsiteHealthSite {
  maxPages: number;
  discoveryStatus: 'discovering' | 'completed' | 'failed';
  limited: boolean;
  warnings: string[];
  pageCount: number;
  completedPages: number;
  partialPages: number;
  failedPages: number;
  /** Empty in history responses. The audit detail includes the page summaries. */
  pages: WebsiteHealthSitePage[];
}
export interface WebsiteHealthCrawlState {
  queue: { url: string; kind: 'page' | 'sitemap' }[];
  seen: string[];
  robots: Record<string, string>;
  requests: number;
  sitemaps: number;
}
export interface WebsiteHealthJob extends WebsiteHealthAudit {
  createdBy: string;
  fingerprint: string;
  version: number;
  attempts: number;
  deviceAttempts?: Partial<Record<WebsiteHealthDevice, number>>;
  retryNotBefore?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  artifactKeys?: Partial<Record<WebsiteHealthDevice, string>>;
  crawl?: WebsiteHealthCrawlState;
  crawlAttempts?: number;
  pageAttempts?: Record<string, number>;
}
export interface WebsiteHealthPage {
  items: WebsiteHealthAudit[];
  total: number;
  nextCursor: string | null;
  auditingAvailable: boolean;
  cruxAvailable: boolean;
  defaultUrl: string | null;
}

export function publicWebsiteHealthAudit(job: WebsiteHealthJob): WebsiteHealthAudit {
  const { id, projectId, url, scope, site, status, createdAt, updatedAt, completedAt, results } = job;
  return { id, projectId, url, ...(scope ? { scope } : {}), ...(site ? { site } : {}), status, createdAt, updatedAt, completedAt, results };
}

export function websiteHealthArtifactKey(projectId: string, auditId: string, device: WebsiteHealthDevice, pageId?: string) {
  return `projects/${projectId}/website-health/${auditId}/${pageId ? `${pageId}/` : ''}${device}.json`;
}
