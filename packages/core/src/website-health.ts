export type WebsiteHealthDevice = 'mobile' | 'desktop';
export type WebsiteHealthCategory = 'performance' | 'accessibility' | 'best-practices' | 'seo';
export type WebsiteHealthRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';

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
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  results: Record<WebsiteHealthDevice, WebsiteHealthDeviceResult>;
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
  const { id, projectId, url, status, createdAt, updatedAt, completedAt, results } = job;
  return { id, projectId, url, status, createdAt, updatedAt, completedAt, results };
}
