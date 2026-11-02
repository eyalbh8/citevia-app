import { z } from 'zod';
import {
  BLOG_REVIEW_RULES, evaluateBlog, projectProviders, snapshotProvider,
  type BlogObservation, type BlogPerformance, type Project, type User,
} from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
import { promptAnswers } from './prompt-answers.js';

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export function requireBlogAdmin(user: User | null) {
  if (!user?.isSystemAdmin || user.disabled)
    throw new AccessError(403, 'FORBIDDEN', 'System administrator access is required.');
}
export async function blogPerformance(
  runtime: Runtime, project: Project, now: Date, trackedUrlId?: string,
): Promise<BlogPerformance[]> {
  const start = new Date(now.getTime() - BLOG_REVIEW_RULES.reviewDays * 86400000).toISOString();
  const [urls, matches, history] = await Promise.all([
    runtime.repository.listTrackedUrls(project.id),
    runtime.repository.listTrackingMatches(project.id, trackedUrlId),
    runtime.repository.listPromptHistory(project.id, start, now.toISOString()),
  ]);
  history.runs = history.runs.filter((run) => ['completed', 'partial'].includes(run.status));
  const captures = promptAnswers(history, project.id, undefined, undefined, 'date', 'asc');
  const citations = new Map<string, Set<string>>();
  for (const match of matches) {
    if (match.evidence.nativeCount < 1) continue;
    const set = citations.get(match.trackedUrlId) || new Set<string>();
    set.add(match.capture.captureKey);
    citations.set(match.trackedUrlId, set);
  }
  const observations: Omit<BlogObservation, 'cited'>[] = captures.flatMap(({ result, run }) =>
    result.status === 'succeeded' && result.captureKey ? [{
      key: `${snapshotProvider(run.snapshot)}:${result.captureKey}`,
      promptId: result.promptId, promptText: result.prompt.text,
      provider: snapshotProvider(run.snapshot), at: result.capturedAt || run.createdAt,
    }] : [],
  );
  return urls.filter((url) => url.contentType === 'BLOG' && (!trackedUrlId || url.id === trackedUrlId)).map((url) =>
    evaluateBlog(url, project.prompts.find((prompt) => prompt.id === url.promptId),
      observations.map((item) => ({ ...item, cited: citations.get(url.id)?.has(item.key) || false })),
      projectProviders(project).map((provider) => provider.provider), now),
  );
}

export async function blogPerformanceRoute(
  runtime: Runtime, project: Project, user: User, tail: string,
  request: Request, now: Date, available: boolean,
  body: (request: Request) => Promise<unknown>,
): Promise<Response | undefined> {
  if (tail !== 'blog-performance' && !tail.startsWith('blog-performance/')) return;
  requireBlogAdmin(user);
  if (tail === 'blog-performance' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const page = z.coerce.number().int().min(0).max(100000).parse(params.get('page') || 0);
    const search = z.string().max(200).parse(params.get('q') || '').toLocaleLowerCase();
    const outcome = z.enum(['all', 'successful', 'unsuccessful', 'declining', 'awaiting_data', 'unlinked', 'paused']).parse(params.get('outcome') || 'all');
    const rows = (await blogPerformance(runtime, project, now)).filter((row) =>
      (outcome === 'all' || row.outcome === outcome) &&
      (!search || `${row.url.title} ${row.url.url} ${row.prompt?.text || ''}`.toLocaleLowerCase().includes(search)),
    );
    const priority = { unsuccessful: 0, declining: 1, unlinked: 2, awaiting_data: 3, successful: 4, paused: 5 };
    rows.sort((a, b) => priority[a.outcome] - priority[b.outcome] || b.url.createdAt.localeCompare(a.url.createdAt) || a.url.id.localeCompare(b.url.id));
    return json({
      items: rows.slice(page * 25, (page + 1) * 25), total: rows.length, page, pageSize: 25,
      evaluatedAt: now.toISOString(), rules: BLOG_REVIEW_RULES, generationAvailable: available && !project.demo,
      prompts: project.prompts.map(({ id, text, active }) => ({ id, text, active })),
    });
  }
  const match = tail.match(/^blog-performance\/([^/]+)$/);
  if (match && request.method === 'PATCH') {
    const id = z.string().uuid().parse(match[1]);
    const input = z.object({ version: z.number().int().positive(), promptId: z.string().min(1).max(200).nullable() }).strict().parse(await body(request));
    const url = (await runtime.repository.listTrackedUrls(project.id)).find((url) => url.id === id && url.contentType === 'BLOG');
    if (!url) throw new AccessError(404, 'NOT_FOUND', 'Tracked blog not found.');
    if (input.promptId && !project.prompts.some((prompt) => prompt.id === input.promptId && prompt.active))
      throw new AccessError(400, 'PROMPT_MISMATCH', 'Choose an active prompt from this account.');
    const next = { ...url, promptId: input.promptId || undefined, version: input.version + 1, updatedAt: now.toISOString() };
    if (!await runtime.repository.updateTrackedUrl(next, input.version))
      throw new AccessError(409, 'VERSION_CONFLICT', 'This blog changed. Refresh before saving.');
    return json(next);
  }
  throw new AccessError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}
