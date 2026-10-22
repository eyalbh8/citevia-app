import { createHash } from 'node:crypto';
import {
  agentEditSchema,
  agentInputSchema,
  identifier,
  publicAgentPost,
  refreshAgentBlog,
  agentCopyValid,
  DEFAULT_AGENT_CONTENT_MODEL,
  type AgentPostJob,
  type Project,
} from '@citevia/core';
import { AccessError, type Runtime } from '@citevia/storage';
const contentModel = () =>
  process.env.OPENAI_CONTENT_MODEL?.trim() || DEFAULT_AGENT_CONTENT_MODEL;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
const fail = (status: number, code: string, message: string): never => {
  throw new AccessError(status, code, message);
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function requestKey(request: Request) {
  const value = request.headers.get('idempotency-key');
  if (!value || !/^[A-Za-z0-9_-]{8,100}$/.test(value))
    return fail(
      400,
      'IDEMPOTENCY_REQUIRED',
      'Supply an Idempotency-Key header.',
    );
  return value;
}

export async function agentRoute(
  runtime: Runtime,
  project: Project,
  userId: string,
  tail: string,
  request: Request,
  now: Date,
  available: boolean,
  body: (request: Request) => Promise<unknown>,
): Promise<Response | null> {
  if (!tail.startsWith('agents/')) return null;
  const { repository, queue } = runtime;
  const collection = tail === 'agents/posts';
  const match = tail.match(/^agents\/posts\/([^/]+)(?:\/(retry))?$/);
  if (!collection && !match) return null;
  const method = request.method;
  // This guard also protects direct use of the route outside the main router.
  if (method !== 'GET' && project.role !== 'owner')
    return fail(403, 'FORBIDDEN', 'Project owner access is required.');
  const enqueue = async (post: AgentPostJob) => {
    if (['queued', 'generating'].includes(post.status))
      await queue.send([
        { kind: 'agent-post', projectId: project.id, postId: post.id },
      ]);
    return json(
      { post: publicAgentPost(post) },
      ['queued', 'generating'].includes(post.status) ? 202 : 200,
    );
  };
  if (collection && method === 'GET') {
    const params = new URL(request.url).searchParams;
    const cursor = params.get('cursor') || '0',
      limit = Number(params.get('limit') || 10);
    if (
      !/^(0|[1-9][0-9]*)$/.test(cursor) ||
      !Number.isSafeInteger(Number(cursor)) ||
      Number(cursor) > 1000000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      return fail(400, 'INVALID_PAGE', 'Invalid content history page.');
    const page = await repository.listAgentPosts(
      project.id,
      Number(cursor),
      limit,
    );
    return json({
      ...page,
      // History uses metadata only; fetch full blog content through the detail endpoint.
      items: page.items.map((post) => ({
        ...publicAgentPost(post),
        content: null,
      })),
      nextCursor:
        Number(cursor) + limit < page.total
          ? String(Number(cursor) + limit)
          : null,
      generationAvailable: available,
    });
  }
  if (collection && method === 'POST') {
    const key = requestKey(request);
    const input = agentInputSchema.parse(await body(request));
    const id = `post_${hash(JSON.stringify([project.id, userId, key])).slice(0, 40)}`;
    const fingerprint = hash(JSON.stringify(input));
    let post = await repository.getAgentPost(project.id, id);
    if (post) {
      if (post.fingerprint !== fingerprint)
        return fail(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This request key was already used for different content.',
        );
      return enqueue(post);
    }
    if (!available)
      return fail(
        503,
        'GENERATION_UNAVAILABLE',
        'Configure OpenAI and Unsplash before generating posts.',
      );
    const selectedPrompt = project.prompts.find(
      (prompt) => prompt.id === input.promptId && prompt.active,
    );
    if (!selectedPrompt)
      return fail(
        400,
        'PROMPT_MISMATCH',
        'Choose an active prompt from this account.',
      );
    post = {
      ...input,
      prompt: selectedPrompt.text,
      topic: selectedPrompt.topic || 'General',
      id,
      projectId: project.id,
      createdBy: userId,
      fingerprint,
      status: 'queued',
      content: null,
      error: null,
      version: 1,
      generation: 1,
      attempts: 0,
      model: contentModel(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      context: {
        brand: project.brand,
        brandbook: project.brandbook,
        language: project.language,
        country: project.country,
      },
    };
    const reserved = await repository.reserveAgentPost(post, null);
    if (reserved === 'limit')
      return fail(
        429,
        'AGENT_LIMIT',
        'Up to three posts can be generated at once. Wait for one to finish.',
      );
    if (reserved === 'conflict') {
      const existing = await repository.getAgentPost(project.id, id);
      if (!existing || existing.fingerprint !== fingerprint)
        return fail(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This request key was already used for different content.',
        );
      return enqueue(existing);
    }
    return enqueue(post);
  }
  if (!match) return null;
  const id = identifier.parse(decodeURIComponent(match[1]));
  const post = await repository.getAgentPost(project.id, id);
  if (!post) return fail(404, 'POST_NOT_FOUND', 'Post not found.');
  if (!match[2] && method === 'GET')
    return json({ post: publicAgentPost(post) });
  if (!match[2] && method === 'PATCH') {
    const { version, ...content } = agentEditSchema.parse(await body(request));
    if (post.status !== 'draft')
      return fail(
        409,
        'POST_NOT_DRAFT',
        'Wait for generation to finish before editing.',
      );
    if (!agentCopyValid(post.channel, content))
      return fail(
        400,
        'CHANNEL_LIMIT',
        'The draft exceeds this channel’s length limit.',
      );
    const next: AgentPostJob = {
      ...post,
      content: refreshAgentBlog(
        { ...post, updatedAt: now.toISOString() },
        { ...post.content!, ...content },
      ),
      version: version + 1,
      updatedAt: now.toISOString(),
    };
    if (
      version !== post.version ||
      !(await repository.saveAgentPost(next, version))
    )
      return fail(
        409,
        'VERSION_CONFLICT',
        'This post changed. Refresh it before saving.',
      );
    return json({ post: publicAgentPost(next) });
  }
  if (match[2] === 'retry' && method === 'POST') {
    const key = requestKey(request);
    if (post.retryRequestId === key) return enqueue(post);
    if (post.status !== 'failed')
      return fail(409, 'POST_NOT_FAILED', 'Only failed posts can be retried.');
    if (!available)
      return fail(
        503,
        'GENERATION_UNAVAILABLE',
        'Configure OpenAI and Unsplash before generating posts.',
      );
    const next: AgentPostJob = {
      ...post,
      status: 'queued',
      error: null,
      content: null,
      generation: post.generation + 1,
      model: contentModel(),
      attempts: 0,
      retryRequestId: key,
      paidCall: undefined,
      stage: undefined,
      researchVersion: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      version: post.version + 1,
      updatedAt: now.toISOString(),
    };
    const result = await repository.reserveAgentPost(next, post.version);
    if (result === 'limit')
      return fail(
        429,
        'AGENT_LIMIT',
        'Up to three posts can be generated at once. Wait for one to finish.',
      );
    if (result === 'conflict') {
      const existing = await repository.getAgentPost(project.id, id);
      if (existing?.retryRequestId === key) return enqueue(existing);
      return fail(
        409,
        'VERSION_CONFLICT',
        'This post changed. Refresh it before retrying.',
      );
    }
    return enqueue(next);
  }
  return null;
}
