import type { Prompt, ScanProvider } from './types.js';
import type { TrackedUrl } from './tracking.js';
import { PROVIDER_LABELS } from './providers.js';

export const BLOG_REVIEW_RULES = {
  reviewDays: 90,
  periodDays: 30,
  minimumDays: 14,
  minimumAnswers: 3,
  minimumScanDays: 2,
  replacementDays: 30,
  replacementAnswers: 6,
  replacementScanDays: 3,
} as const;
export type BlogOutcome = 'successful' | 'unsuccessful' | 'declining' | 'awaiting_data' | 'unlinked' | 'paused';
export type BlogAction = 'keep' | 'adjust' | 'create' | 'wait' | 'link_prompt' | 'resume';
export interface BlogObservation {
  key: string;
  promptId: string;
  promptText: string;
  provider: ScanProvider;
  at: string;
  cited: boolean;
}
export interface BlogPeriodMetrics {
  answers: number;
  citedAnswers: number;
  scanDays: number;
  citationRate: number | null;
}
export interface BlogPerformance {
  url: TrackedUrl;
  prompt: Pick<Prompt, 'id' | 'text' | 'active'> | null;
  outcome: BlogOutcome;
  action: BlogAction;
  reason: string;
  changes: string[];
  current: BlogPeriodMetrics;
  previous: BlogPeriodMetrics;
  lastCitedAt: string | null;
  lastObservedAt: string | null;
  monitoringSince: string;
  promptChanged: boolean;
}
export interface BlogPerformancePage {
  items: BlogPerformance[];
  total: number;
  page: number;
  pageSize: number;
  evaluatedAt: string;
  rules: typeof BLOG_REVIEW_RULES;
  prompts: Pick<Prompt, 'id' | 'text' | 'active'>[];
  generationAvailable: boolean;
}
export interface BlogRefreshContext {
  trackedUrlId: string;
  url: string;
  action: 'adjust' | 'create';
  evaluatedAt: string;
  reason: string;
  changes: string[];
  originalBody?: string;
  metrics: { current: BlogPeriodMetrics; previous: BlogPeriodMetrics };
}
const day = 86400000;
const textKey = (text: string) => text.trim().replace(/\s+/g, ' ');
function metrics(items: BlogObservation[]): BlogPeriodMetrics {
  const citedAnswers = items.filter((item) => item.cited).length;
  return {
    answers: items.length,
    citedAnswers,
    scanDays: new Set(items.map((item) => item.at.slice(0, 10))).size,
    citationRate: items.length ? Math.round(citedAnswers / items.length * 1000) / 10 : null,
  };
}

/** Citation pickup is an observable outcome, not proof of traffic or causal lift. */
export function evaluateBlog(
  url: TrackedUrl,
  prompt: Prompt | undefined,
  observations: BlogObservation[],
  enabledProviders: ScanProvider[],
  now: Date,
): BlogPerformance {
  const currentStart = now.getTime() - BLOG_REVIEW_RULES.periodDays * day;
  const previousStart = currentStart - BLOG_REVIEW_RULES.periodDays * day;
  const monitoringSince = new Date(Math.max(
    Date.parse(url.createdAt), Date.parse(url.publishedAt),
    Date.parse(url.trackingPeriods?.filter((period) => !period.end).at(-1)?.start || url.createdAt),
  )).toISOString();
  const since = Math.max(Date.parse(monitoringSince), now.getTime() - BLOG_REVIEW_RULES.reviewDays * day);
  const deduped = new Map<string, BlogObservation>();
  for (const item of observations) {
    const at = Date.parse(item.at);
    if (item.promptId !== prompt?.id || at < since || at > now.getTime()) continue;
    const prior = deduped.get(item.key);
    deduped.set(item.key, { ...item, cited: item.cited || Boolean(prior?.cited) });
  }
  const all = [...deduped.values()].sort((a, b) => a.at.localeCompare(b.at));
  const eligible = all.filter((item) => textKey(item.promptText) === textKey(prompt!.text));
  const recent = eligible.filter((item) => Date.parse(item.at) >= currentStart);
  const prior = eligible.filter((item) => Date.parse(item.at) >= previousStart && Date.parse(item.at) < currentStart);
  const current = metrics(recent), previous = metrics(prior);
  const cited = eligible.filter((item) => item.cited);
  const promptChanged = all.some((item) => textKey(item.promptText) !== textKey(prompt!.text));
  const age = (now.getTime() - Date.parse(monitoringSince)) / day;
  const enough = age >= BLOG_REVIEW_RULES.minimumDays && current.answers >= BLOG_REVIEW_RULES.minimumAnswers && current.scanDays >= BLOG_REVIEW_RULES.minimumScanDays;
  let outcome: BlogOutcome, action: BlogAction, reason: string;
  if (!url.active) {
    outcome = 'paused'; action = 'resume'; reason = 'Tracking is paused. Resume it in Tracking to collect new evidence.';
  } else if (!prompt) {
    outcome = 'unlinked'; action = 'link_prompt'; reason = 'Link the prompt this article was written to answer before judging its performance.';
  } else if (!prompt.active) {
    outcome = 'awaiting_data'; action = 'wait'; reason = 'The linked prompt is inactive. Activate it in Prompts to collect new answers.';
  } else if (enough && previous.answers >= BLOG_REVIEW_RULES.minimumAnswers && previous.scanDays >= BLOG_REVIEW_RULES.minimumScanDays && previous.citationRate! > 0 && current.citationRate! < previous.citationRate! / 2) {
    outcome = 'declining'; action = 'adjust'; reason = 'The citation rate for this prompt fell by more than half compared with the previous 30 days. Refresh the existing article.';
  } else if (current.citedAnswers > 0) {
    outcome = 'successful'; action = 'keep'; reason = 'AI answers to the linked prompt cited this article in the last 30 days. Keep it and continue monitoring.';
  } else if (!enough) {
    outcome = 'awaiting_data'; action = 'wait'; reason = 'Wait for at least 14 days of tracking and 3 analyzed answers on 2 different days in the last 30 days for the current prompt wording.';
  } else {
    outcome = 'unsuccessful';
    action = !cited.length && age >= BLOG_REVIEW_RULES.replacementDays && current.answers >= BLOG_REVIEW_RULES.replacementAnswers && current.scanDays >= BLOG_REVIEW_RULES.replacementScanDays ? 'create' : 'adjust';
    reason = action === 'create'
      ? 'No citations for this prompt in the review evidence after at least 30 days and 6 answers on 3 days. Try a new article with a different angle for the same prompt.'
      : 'The current prompt has enough recent answers to review, but none cited this article. Improve the existing article’s answer and evidence.';
  }
  const changes: string[] = [];
  if (action === 'adjust' || action === 'create') {
    changes.push(action === 'adjust'
      ? 'Preserve useful parts of the current article and its public URL. Rewrite the opening to answer the linked prompt directly.'
      : 'Use a distinct title, structure and practical angle to answer the same prompt. Avoid publishing a duplicate of the original article.');
    if (promptChanged) changes.push('The prompt wording changed in the review history. Align every section and FAQ with the current saved question.');
    changes.push('Verify time-sensitive claims with fresh primary-source research and the latest saved brandbook. Remove claims that cannot be supported.');
    changes.push('Add useful examples, clear headings and relevant FAQs. Refresh internal links, supporting citations, SEO metadata and article schema.');
    const uncited = enabledProviders.filter((provider) => recent.some((item) => item.provider === provider) && !recent.some((item) => item.provider === provider && item.cited));
    if (uncited.length) changes.push(`Review the answer coverage for ${uncited.map((provider) => PROVIDER_LABELS[provider]).join(', ')}; those observed providers did not cite this article for the prompt.`);
  }
  return {
    url, prompt: prompt ? { id: prompt.id, text: prompt.text, active: prompt.active } : null,
    outcome, action, reason, changes, current, previous, monitoringSince, promptChanged,
    lastCitedAt: cited.at(-1)?.at || null, lastObservedAt: eligible.at(-1)?.at || null,
  };
}
