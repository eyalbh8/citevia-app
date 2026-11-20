import { promptLimitFor, type Project } from '@citevia/core';
import type { DateRangeSelection } from './DateRangeFilter';

export function previewReportPeriod(project: Project, now = new Date()): DateRangeSelection | undefined {
  const scan = project.previewScan;
  if (project.accountType !== 'prospect' || !scan) return;
  // Reports select by answer capture time. A scan may cross midnight in UTC.
  return {
    days: 'custom',
    start: scan.createdAt.slice(0, 10),
    end: (scan.completedAt ?? now.toISOString()).slice(0, 10),
  };
}

export function previewProgress(project: Project) {
  const scan = project.previewScan;
  const setup = project.onboardingSummary;
  const count = promptLimitFor('prospect');
  if (!scan) {
    if (setup?.status === 'failed' || setup?.status === 'stopped') {
      return { label: setup.status === 'failed' ? 'Setup failed' : 'Setup stopped', tone: 'failed', pending: false };
    }
    return {
      label: setup?.status === 'completed' ? 'ChatGPT scan queued' : 'Preparing preview',
      tone: 'running', pending: true,
    };
  }
  const analyzed = scan.succeededCount;
  const progress = `${analyzed}/${count} answers analyzed`;
  if (scan.status === 'completed' && analyzed === count && scan.totalCount === count)
    return { label: `Preview ready · ${progress}`, tone: 'completed', pending: false };
  if (['completed', 'partial', 'failed'].includes(scan.status))
    return { label: `${analyzed ? 'Partial preview' : 'Scan failed'} · ${progress}`, tone: 'failed', pending: false };
  return { label: `${scan.status === 'queued' ? 'ChatGPT scan queued' : 'Scanning ChatGPT'} · ${progress}`, tone: 'running', pending: true };
}
