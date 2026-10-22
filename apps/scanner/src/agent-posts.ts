import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  blogSeoChecks,
  refreshAgentBlog,
  normalizeUrl,
  type AgentImage,
  type AgentPostJob,
  type AgentContent,
} from '@citevia/core';
import {
  agentGenerationRequest,
  parseAgentContent,
  parseBlogDraft,
  agentOutput,
  finalizeSocialCopy,
  verifiedBlogLinks,
} from './agent-generation.js';
export {
  agentGenerationRequest,
  parseAgentContent,
} from './agent-generation.js';
import { createAgentImages, type AgentImages } from './agent-images.js';
import { blogResearchBrief, blogResearchRequest } from './agent-research.js';
import { accountWebsite } from './agent-prompts.js';
import type { Runtime } from '@citevia/storage';
import {
  ProviderError,
  type ProviderReceipt,
  type ResponseProvider,
} from './provider.js';

export class AgentPostEngine {
  constructor(
    private runtime: Runtime,
    private provider: () => Promise<ResponseProvider>,
    private now = () => new Date(),
    private images: () => Promise<AgentImages> = createAgentImages,
  ) {}

  private async fail(post: AgentPostJob, code: string, message: string) {
    await this.runtime.repository.saveAgentPost(
      {
        ...post,
        status: 'failed',
        error: { code, message },
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        version: post.version + 1,
        updatedAt: this.now().toISOString(),
      },
      post.version,
    );
  }

  private async advance(
    post: AgentPostJob,
    stage: NonNullable<AgentPostJob['stage']>,
    extra: Partial<AgentPostJob> = {},
  ) {
    const next: AgentPostJob = {
      ...post,
      ...extra,
      stage,
      paidCall: undefined,
      attempts: 0,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      version: post.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (await this.runtime.repository.saveAgentPost(next, post.version))
      await this.runtime.queue.send([
        { kind: 'agent-post', projectId: post.projectId, postId: post.id },
      ]);
  }

  async handle(projectId: string, postId: string) {
    const { repository, artifacts } = this.runtime;
    const post = await repository.getAgentPost(projectId, postId);
    if (
      !post ||
      !['queued', 'generating'].includes(post.status) ||
      (post.leaseExpiresAt &&
        Date.parse(post.leaseExpiresAt) > this.now().getTime())
    )
      return;
    if (post.attempts >= 5) {
      await this.fail(
        post,
        'agent_recovery_exhausted',
        'Generation could not finish after repeated interruptions. Retry generation.',
      );
      return;
    }
    let current: AgentPostJob = {
      ...post,
      status: 'generating',
      leaseOwner: randomUUID(),
      attempts: post.attempts + 1,
      leaseExpiresAt: new Date(this.now().getTime() + 4 * 60_000).toISOString(),
      version: post.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await repository.saveAgentPost(current, post.version))) return;
    const receiptKey = `projects/${projectId}/agent-posts/${post.id}/generation-${post.generation}${post.stage ? '-' + post.stage : ''}.json`;
    try {
      let receipt = await artifacts.get<ProviderReceipt>(receiptKey);
      if (!receipt) {
        if (post.paidCall)
          throw new ProviderError(
            'agent_call_uncertain',
            'A previous generation attempt has no saved response. Retry explicitly to start another generation.',
            false,
          );
        // Initialize credentials before recording that a paid request may have started.
        const provider = await this.provider();
        await this.images();
        const searchRequest =
          current.channel === 'blog' &&
          (!current.stage || current.stage === 'links')
            ? blogResearchRequest(current, this.now())
            : null;
        const pending: AgentPostJob = {
          ...current,
          paidCall: { startedAt: this.now().toISOString() },
          version: current.version + 1,
        };
        if (!(await repository.saveAgentPost(pending, current.version))) return;
        current = pending;
        let draft: unknown;
        if (current.stage === 'social-repair') {
          const source = await artifacts.get<ProviderReceipt>(
            `projects/${projectId}/agent-posts/${post.id}/generation-${post.generation}.json`,
          );
          if (!source)
            throw new ProviderError(
              'agent_missing_draft',
              'The saved caption could not be recovered. Retry generation.',
              false,
            );
          draft = {
            ...parseAgentContent(current, source),
            revision:
              'Remove every account brand name, alias, branded hashtag and handle from the title and caption. Rewrite naturally without losing the answer. Use neutral descriptions such as the platform or provider when the selected prompt names the brand. Keep the existing platform-specific style and length limits.',
          };
        } else if (current.stage && current.stage !== 'links') {
          const sourceKey =
            'projects/' +
            projectId +
            '/agent-posts/' +
            post.id +
            '/generation-' +
            post.generation +
            (current.stage === 'repair'
              ? '-format'
              : current.stage === 'format'
                ? '-write'
                : '') +
            '.json';
          const source = await artifacts.get<ProviderReceipt>(sourceKey);
          if (!source)
            throw new ProviderError(
              'agent_missing_draft',
              'The saved blog draft could not be recovered. Retry generation.',
              false,
            );
          const researchReceipt = await artifacts.get<ProviderReceipt>(
            'projects/' +
              projectId +
              '/agent-posts/' +
              post.id +
              '/generation-' +
              post.generation +
              '.json',
          );
          if (!researchReceipt)
            throw new ProviderError(
              'agent_missing_research',
              'The blog research could not be recovered. Retry generation.',
              false,
            );
          const internalReceipt = await artifacts.get<ProviderReceipt>(
            `projects/${projectId}/agent-posts/${post.id}/generation-${post.generation}-links.json`,
          );
          const sourceBrief = blogResearchBrief(
            current,
            researchReceipt,
            internalReceipt,
          );
          if (current.stage === 'write') draft = { research: sourceBrief };
          else {
            const previous = parseBlogDraft(source);
            previous.body = verifiedBlogLinks(
              current,
              previous.body,
              sourceBrief.sources,
            );
            draft = {
              ...previous,
              research: sourceBrief,
              failedChecks: blogSeoChecks(
                previous.title,
                previous.body,
                previous.blog,
                current.context.language,
                accountWebsite(current) || undefined,
              ).filter((item) => !item.passed),
            };
          }
        }
        receipt = searchRequest
          ? await provider.answer(searchRequest)
          : await provider.extract(agentGenerationRequest(current, draft));
        // Native receipts are private checkpoints, so storage retries do not regenerate paid content.
        await artifacts.put(receiptKey, receipt);
      }
      let content: AgentContent;
      let query: string;
      let alt: string;
      if (current.channel === 'blog') {
        if (!current.stage) {
          blogResearchBrief(current, receipt, null);
          await this.advance(current, 'links', { researchVersion: 2 });
          return;
        }
        if (current.stage === 'links') {
          const externalReceipt = await artifacts.get<ProviderReceipt>(
            `projects/${projectId}/agent-posts/${post.id}/generation-${post.generation}.json`,
          );
          if (!externalReceipt)
            throw new ProviderError(
              'agent_missing_research',
              'The saved external web search could not be recovered. Retry generation.',
              false,
            );
          blogResearchBrief(current, externalReceipt, receipt);
          await this.advance(current, 'write');
          return;
        }
        const draft = parseBlogDraft(receipt);
        const researchReceipt = await artifacts.get<ProviderReceipt>(
          'projects/' +
            projectId +
            '/agent-posts/' +
            post.id +
            '/generation-' +
            post.generation +
            '.json',
        );
        if (!researchReceipt)
          throw new ProviderError(
            'agent_missing_research',
            'The saved research could not be recovered. Retry generation.',
            false,
          );
        const internalReceipt = await artifacts.get<ProviderReceipt>(
          `projects/${projectId}/agent-posts/${post.id}/generation-${post.generation}-links.json`,
        );
        const sources = blogResearchBrief(
          current,
          researchReceipt,
          internalReceipt,
        ).sources;
        draft.body = verifiedBlogLinks(current, draft.body, sources);
        const failedChecks = blogSeoChecks(
          draft.title,
          draft.body,
          draft.blog,
          current.context.language,
          accountWebsite(current) || undefined,
        ).filter((item) => !item.passed);
        if (
          current.stage === 'write' ||
          (current.stage === 'format' && failedChecks.length)
        ) {
          await this.advance(
            current,
            current.stage === 'write' ? 'format' : 'repair',
          );
          return;
        }
        if (
          failedChecks.some((check) =>
            ['internal-link', 'external-link'].includes(check.id),
          )
        )
          throw new ProviderError(
            'agent_blog_links_missing',
            'Web search and editorial revision could not produce valid internal and external blog links. Retry generation to search for sources again.',
            false,
          );
        content = {
          ...draft,
          blog: {
            ...draft.blog,
            sources: sources.filter((source) =>
              [
                ...draft.body.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g),
              ].some(
                (match) => normalizeUrl(match[1]) === normalizeUrl(source.url),
              ),
            ),
            researchedAt: researchReceipt.receivedAt,
            articleSchema: {},
            faqSchema: {},
            checks: [],
          },
        };
        query = draft.blog.imageSearchQuery;
        alt = draft.blog.imageAlt;
      } else {
        content = finalizeSocialCopy(
          current,
          parseAgentContent(current, receipt),
        );
        query =
          agentOutput(receipt).imageSearchQuery ||
          current.context.brandbook?.industryCategory ||
          current.prompt;
        alt = content.title;
      }
      const imageKey =
        'projects/' +
        projectId +
        '/agent-posts/' +
        post.id +
        '/generation-' +
        post.generation +
        '-image.json';
      let image = await repository.reserveAgentImage(current);
      const images = await this.images();
      if (!image) {
        const checkpoint = await artifacts.get<AgentImage>(imageKey);
        if (checkpoint)
          image = await repository.reserveAgentImage(current, checkpoint);
      }
      if (!image) {
        const selected = await images.select(
          current,
          query,
          alt,
          async (candidate) =>
            Boolean(await repository.reserveAgentImage(current, candidate)),
        );
        image = await repository.reserveAgentImage(current, selected);
        if (!image)
          throw new ProviderError(
            'unsplash_photo_reused',
            'This photo was already selected for this account and channel. Retry generation to choose an unused photo.',
            false,
          );
      }
      await artifacts.put(imageKey, image);
      const trackedKey = imageKey + '.tracked';
      const tracked = await artifacts.get<{ photoId?: string }>(trackedKey);
      if (tracked?.photoId !== image.photoId) {
        await images.track(image);
        await artifacts.put(trackedKey, {
          photoId: image.photoId,
          trackedAt: this.now().toISOString(),
        });
      }
      content = refreshAgentBlog(
        { ...current, updatedAt: this.now().toISOString() },
        { ...content, image },
      );
      await repository.saveAgentPost(
        {
          ...current,
          status: 'draft',
          content,
          error: null,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          version: current.version + 1,
          updatedAt: this.now().toISOString(),
        },
        current.version,
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        if (
          error.code === 'agent_brand_mention' &&
          !current.stage &&
          ['facebook', 'instagram', 'x'].includes(current.channel)
        ) {
          await this.advance(current, 'social-repair');
          return;
        }
        await this.fail(current, error.code, error.message);
      } else if (error instanceof ZodError || error instanceof SyntaxError) {
        await this.fail(
          current,
          'agent_invalid_output',
          'The generated draft did not pass validation. Retry generation.',
        );
      } else {
        // Keep the lease and checkpoint for infrastructure recovery; never expose raw errors.
        throw error;
      }
    }
  }

  async reconcile() {
    const posts = await this.runtime.repository.listActiveAgentPosts();
    const messages = posts
      .filter(
        (post) =>
          !post.leaseExpiresAt ||
          Date.parse(post.leaseExpiresAt) <= this.now().getTime(),
      )
      .map((post) => ({
        kind: 'agent-post' as const,
        projectId: post.projectId,
        postId: post.id,
      }));
    if (messages.length) await this.runtime.queue.send(messages);
  }
  async deadLetter(projectId: string, postId: string) {
    const post = await this.runtime.repository.getAgentPost(projectId, postId);
    if (
      post &&
      ['queued', 'generating'].includes(post.status) &&
      (!post.leaseExpiresAt ||
        Date.parse(post.leaseExpiresAt) <= this.now().getTime())
    )
      await this.fail(
        post,
        'agent_delivery_exhausted',
        'Generation could not be completed after delivery retries. Retry generation.',
      );
  }
}
