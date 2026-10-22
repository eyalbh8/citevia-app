import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  FileText,
  Info,
  LoaderCircle,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  Save,
  Sparkles,
  Download,
} from 'lucide-react';
import {
  agentContentSchema,
  agentPostText,
  agentJsonLd,
  type AgentContent,
  type AgentPost,
  type AgentPostPage,
  type Prompt,
  type Project,
} from '@citevia/core';
import { idempotentPost, query, request, useApi } from './api';
import { Drawer, ErrorNotice, formatDate, Pagination } from './components';
import { Skeleton } from './Loading';
import { invalidateApiQueries } from './query-cache';
import AnswerMarkdown from './AnswerMarkdown';
import {
  AgentPhoto,
  AgentBlogBody,
  AgentBlogSeo,
  downloadBlogArticle,
} from './AgentPostPreview';
import IntegrationMark from './IntegrationMark';
import FilterDropdown from './FilterDropdown';
import { AGENTS } from './integration-catalog';
import './agents-integrations.css';

const active = (post?: AgentPost) =>
  Boolean(post && ['queued', 'generating'].includes(post.status));
const channelFor = (post: AgentPost) =>
  AGENTS.find((agent) => agent.id === post.channel)!;
const statusLabel = (post: AgentPost) =>
  ({
    queued: 'Queued',
    generating: 'Generating…',
    draft: 'Draft',
    failed: 'Failed',
  })[post.status];

export default function AgentsView({
  project,
  onIntegrations,
}: {
  project: Project;
  onIntegrations: (highlight?: string) => void;
}) {
  const path = `/projects/${encodeURIComponent(project.id)}/agents`;
  const owner = project.role === 'owner';
  const [generateOpen, setGenerateOpen] = useState(false);
  const [channel, setChannel] = useState(AGENTS[0].id);
  const [promptId, setPromptId] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error>();
  // Account summaries omit prompts. Fetch the saved collection when the drawer
  // opens rather than treating a summary's empty array as the real prompt list.
  const promptsPath =
    '/projects/' + encodeURIComponent(project.id) + '/prompts';
  const accountPrompts = useApi<{ items: Prompt[]; version: number }>(
    generateOpen ? promptsPath : null,
  );
  const history = useApi<AgentPostPage>(
    `${path}/posts${query({ cursor: page * 10, limit: 10 })}`,
  );
  const detail = useApi<{ post: AgentPost }>(
    selectedId ? `${path}/posts/${encodeURIComponent(selectedId)}` : null,
  );
  const posts = history.data?.items || [];
  const generating = posts.some(active) || active(detail.data?.post);
  const available = history.data?.generationAvailable === true;
  const prompts =
    accountPrompts.data?.items.filter((item) => item.active) || [];
  const promptsLoading =
    accountPrompts.loading || (!accountPrompts.data && !accountPrompts.error);
  const selectedPrompt =
    !promptsLoading && !accountPrompts.error
      ? prompts.find((item) => item.id === promptId)
      : undefined;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void invalidateApiQueries(path), 3000);
    return () => clearInterval(timer);
  }, [generating, path]);
  useEffect(() => {
    if (history.data && page > 0 && page * 10 >= history.data.total) setPage(0);
  }, [history.data, page]);
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!owner || !available || submitting || !selectedPrompt) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await idempotentPost<{ post: AgentPost }>(
        `${path}/posts`,
        { channel, promptId },
      );
      setPage(0);
      setGenerateOpen(false);
      setSelectedId(result.post.id);
      setPromptId('');
      void invalidateApiQueries(path);
    } catch (error) {
      setError(error as Error);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="agents-screen">
      <header className="agents-heading">
        <div>
          <h1>Meet our Citevia Agents</h1>
          <p>Generate high-quality content with our AI-powered design lab.</p>
        </div>
        <div className="agents-heading-actions">
          <button
            className="button button-outline"
            onClick={() => onIntegrations()}
          >
            <Plug size={15} />
            Manage connections
          </button>
          <button
            className="button button-primary"
            disabled={!owner}
            title={
              !owner
                ? 'Project owner access is required to create posts'
                : undefined
            }
            onClick={() => {
              setError(undefined);
              setGenerateOpen(true);
            }}
          >
            <Plus size={16} />
            Generate
          </button>
        </div>
      </header>
      <div className="agents-channel-grid" aria-label="Agent channels">
        {AGENTS.map((agent) => (
          <button
            key={agent.id}
            className="agent-channel-card"
            aria-label={`Manage ${agent.name} connection`}
            onClick={() => onIntegrations(agent.id)}
          >
            <span className="agent-channel-logo">
              <IntegrationMark integration={agent} size={38} />
            </span>
            <span className="agent-channel-label">{agent.name}</span>
            <span className="agent-channel-status">
              <Plug size={12} />
              Not connected
              <ArrowRight size={12} />
            </span>
          </button>
        ))}
      </div>
      <div className="agents-availability" role="status">
        <Info size={16} />
        <p>
          Create drafts for any channel without connecting a social account.
          Publishing integrations are not available yet.
          {!owner && ' Your account has read-only access to posts.'}
        </p>
      </div>
      <section
        className="agents-history"
        aria-labelledby="agents-history-title"
      >
        <header>
          <div>
            <h2 id="agents-history-title">Content history</h2>
            <p>Your generated content, all in one place.</p>
          </div>
          <span>
            {history.data
              ? `${history.data.total} ${history.data.total === 1 ? 'post' : 'posts'}`
              : 'Loading…'}
          </span>
        </header>
        <ErrorNotice
          error={history.error}
          retry={() => void invalidateApiQueries(path)}
        />
        {!history.data && history.loading ? (
          <Skeleton variant="table" label="Loading content history…" />
        ) : posts.length ? (
          <>
            <div className="agent-history-table-scroll">
              <table className="agent-history-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Date and time</th>
                    <th>Topic</th>
                    <th>Prompt</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((post) => (
                    <tr key={post.id}>
                      <td>
                        <span className="agent-history-channel">
                          <IntegrationMark
                            integration={channelFor(post)}
                            size={22}
                          />
                          {channelFor(post).name}
                        </span>
                      </td>
                      <td>
                        {formatDate(post.createdAt, true)}
                        <small>
                          {new Date(post.createdAt).toLocaleTimeString('en', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </small>
                      </td>
                      <td>{post.topic}</td>
                      <td>
                        <span className="agent-history-prompt">
                          {post.prompt}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`agent-post-status status-${post.status}`}
                        >
                          {active(post) && (
                            <LoaderCircle size={12} className="spinner" />
                          )}
                          {statusLabel(post)}
                        </span>
                      </td>
                      <td>
                        <button
                          className="button button-outline"
                          aria-label={`Open post: ${post.topic}`}
                          onClick={() => setSelectedId(post.id)}
                        >
                          Open
                          <ArrowRight size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              total={history.data?.total || 0}
              size={10}
              onChange={setPage}
            />
          </>
        ) : (
          !history.error && (
            <div className="agents-history-empty">
              <span className="agents-empty-icon">
                <FileText size={26} />
              </span>
              <h3>Empty for now.</h3>
              <p>Your agent-generated posts will appear here.</p>
              {owner && (
                <button
                  className="button button-outline"
                  onClick={() => {
                    setError(undefined);
                    setGenerateOpen(true);
                  }}
                >
                  <Sparkles size={15} />
                  Create your first post
                  <ArrowRight size={14} />
                </button>
              )}
            </div>
          )
        )}
      </section>
      {generateOpen && (
        <Drawer
          title="Generate content"
          onClose={() => {
            if (!submitting) setGenerateOpen(false);
          }}
        >
          <form
            onSubmit={(event) => void generate(event)}
            aria-busy={submitting}
          >
            <div className="agent-generation-intro">
              <span className="agents-empty-icon">
                <Sparkles size={24} />
              </span>
              <h3>Answer a prompt. Reach your audience.</h3>
              <p>
                Choose one of the saved account prompts and the target agent for{' '}
                {project.brand.name}. Your brandbook guides the voice and
                content.
              </p>
            </div>
            <ErrorNotice error={error} />
            <ErrorNotice
              error={accountPrompts.error}
              retry={() => void invalidateApiQueries(promptsPath)}
            />
            <fieldset className="agent-generation-fields" disabled={submitting}>
              <label htmlFor="agent-tracked-prompt">Prompt to answer</label>
              <select
                id="agent-tracked-prompt"
                required
                disabled={Boolean(promptsLoading || accountPrompts.error)}
                aria-busy={promptsLoading}
                value={promptId}
                onChange={(event) => setPromptId(event.target.value)}
              >
                <option value="" disabled>
                  {promptsLoading
                    ? 'Loading account prompts…'
                    : 'Select an account prompt'}
                </option>
                {prompts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.text}
                  </option>
                ))}
              </select>
              <span className="agent-selector-label">Target agent</span>
              <FilterDropdown
                label="Target agent"
                className="agent-target-select"
                active={false}
                value={channel}
                onChange={setChannel}
                disabled={submitting}
                options={AGENTS.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  icon: <IntegrationMark integration={agent} size={22} />,
                }))}
              />
            </fieldset>
            {accountPrompts.data &&
              !accountPrompts.error &&
              !promptsLoading &&
              !prompts.length && (
                <div className="setting-note" role="status">
                  <Info size={17} />
                  <span>
                    No active prompts available.{' '}
                    <a href="#prompts">View account prompts</a> to activate an
                    existing question.
                  </span>
                </div>
              )}
            {!available && (
              <div className="setting-note" role="status">
                <Info size={17} />
                <span>
                  {history.loading && !history.data
                    ? 'Checking generation availability…'
                    : 'Content generation is not enabled. Ask your administrator to configure OpenAI and Unsplash for this workspace.'}
                </span>
              </div>
            )}
            <div className="agent-generation-actions">
              <button
                type="button"
                disabled={submitting}
                className="button button-outline"
                onClick={() => setGenerateOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={!available || submitting || !selectedPrompt}
              >
                {submitting ? (
                  <LoaderCircle size={14} className="spinner" />
                ) : (
                  <Sparkles size={14} />
                )}
                {submitting ? 'Creating post…' : 'Generate content'}
              </button>
            </div>
          </form>
        </Drawer>
      )}
      {selectedId && (
        <Drawer title="Agent post" onClose={() => setSelectedId(undefined)}>
          <ErrorNotice
            error={detail.error}
            retry={() => void invalidateApiQueries(path)}
          />
          {!detail.data && !detail.error ? (
            <Skeleton variant="detail" label="Loading your post…" />
          ) : (
            detail.data && (
              <PostDetail
                key={detail.data.post.id}
                post={detail.data.post}
                owner={owner}
                available={available}
                path={path}
                onUpdated={() => void invalidateApiQueries(path)}
              />
            )
          )}
        </Drawer>
      )}
    </div>
  );
}

function PostDetail({
  post,
  owner,
  available,
  path,
  onUpdated,
}: {
  post: AgentPost;
  owner: boolean;
  available: boolean;
  path: string;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState(post.version);
  const [content, setContent] = useState<AgentContent>(
    post.content || { title: '', body: '', hashtags: [] },
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error>();
  const item = channelFor(post);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !owner) return;
    setBusy(true);
    setError(undefined);
    try {
      const parsed = agentContentSchema.safeParse(content);
      if (!parsed.success)
        throw new Error(
          'Enter a title and body. Use no more than 15 hashtags.',
        );
      await request(`${path}/posts/${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: parsed.data.title,
          body: parsed.data.body,
          hashtags: parsed.data.hashtags,
          version: editVersion,
        }),
      });
      setEditing(false);
      onUpdated();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (busy || !owner) return;
    setBusy(true);
    setError(undefined);
    try {
      await idempotentPost(
        `${path}/posts/${encodeURIComponent(post.id)}/retry`,
      );
      onUpdated();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        agentPostText(post.channel, post.content!),
      );
      setCopied(true);
    } catch {
      setError(
        new Error('Copy unavailable. Select the content and copy it manually.'),
      );
    }
  }
  return (
    <div className="agent-post-detail">
      <div className="agent-post-detail-header">
        <IntegrationMark integration={item} size={30} />
        <strong>{item.name}</strong>
        <span className={`agent-post-status status-${post.status}`}>
          {statusLabel(post)}
        </span>
      </div>
      <dl className="agent-post-context">
        <dt>Topic</dt>
        <dd>{post.topic}</dd>
        <dt>Prompt</dt>
        <dd>{post.prompt}</dd>
      </dl>
      <ErrorNotice error={error} />
      {active(post) ? (
        <div className="agent-post-progress" role="status">
          <LoaderCircle className="spinner" size={24} />
          <h3>
            {post.status === 'queued'
              ? 'Your post is queued'
              : 'Your agent is writing…'}
          </h3>
          <p>
            You can close this panel. The draft will appear in content history
            when it’s ready.
          </p>
        </div>
      ) : post.status === 'failed' ? (
        <>
          <ErrorNotice
            error={
              post.error?.message || 'Generation failed. Please try again.'
            }
          />
          {owner && (
            <button
              className="button button-primary"
              disabled={busy || !available}
              onClick={() => void retry()}
            >
              {busy ? (
                <LoaderCircle size={14} className="spinner" />
              ) : (
                <RefreshCw size={14} />
              )}
              Retry generation
            </button>
          )}
        </>
      ) : (
        post.content &&
        (editing ? (
          <form onSubmit={(event) => void save(event)}>
            <fieldset className="agent-generation-fields" disabled={busy}>
              <label htmlFor="agent-edit-title">Title</label>
              <input
                id="agent-edit-title"
                required
                maxLength={300}
                value={content.title}
                onChange={(event) =>
                  setContent({ ...content, title: event.target.value })
                }
              />
              <label htmlFor="agent-edit-body">Content</label>
              <textarea
                id="agent-edit-body"
                rows={14}
                required
                maxLength={30000}
                value={content.body}
                onChange={(event) =>
                  setContent({ ...content, body: event.target.value })
                }
              />
              <label htmlFor="agent-edit-hashtags">Hashtags</label>
              <input
                id="agent-edit-hashtags"
                value={content.hashtags.join(' ')}
                onChange={(event) =>
                  setContent({
                    ...content,
                    hashtags: event.target.value
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean),
                  })
                }
              />
            </fieldset>
            <div className="agent-generation-actions">
              <button
                type="button"
                className="button button-outline"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle size={14} className="spinner" />
                ) : (
                  <Save size={14} />
                )}
                Save draft
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="agent-post-content">
              <h2 dir="auto">{post.content.title}</h2>
              {post.content.image && <AgentPhoto image={post.content.image} />}
              {post.channel === 'blog' ? (
                <AgentBlogBody content={post.content} />
              ) : (
                <p className="agent-post-body" dir="auto">
                  {post.content.body}
                </p>
              )}
              {post.content.hashtags.length > 0 && (
                <p className="agent-post-hashtags" dir="auto">
                  {post.content.hashtags.join(' ')}
                </p>
              )}
            </div>
            <AgentBlogSeo content={post.content} />
            <div className="agent-generation-actions">
              {post.content.blog && (
                <>
                  <button
                    className="button button-outline"
                    onClick={() => {
                      void downloadBlogArticle(post.content!).catch(() =>
                        setError(
                          new Error(
                            'The article could not be exported. Please try again.',
                          ),
                        ),
                      );
                    }}
                  >
                    <Download size={14} />
                    Download article
                  </button>
                  <button
                    className="button button-outline"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(
                          JSON.stringify(agentJsonLd(post.content!), null, 2),
                        )
                        .then(() => setCopied(true))
                        .catch(() => setError(new Error('Copy unavailable.')));
                    }}
                  >
                    Copy schema
                  </button>
                </>
              )}
              <button
                className="button button-outline"
                onClick={() => void copy()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy content'}
              </button>
              {owner && (
                <button
                  className="button button-primary"
                  onClick={() => {
                    setContent(post.content!);
                    setEditVersion(post.version);
                    setEditing(true);
                  }}
                >
                  <Pencil size={14} />
                  Edit draft
                </button>
              )}
            </div>
            <p className="integration-scope-note">
              Saved as a draft · {post.model} ·{' '}
              {formatDate(post.createdAt, true)}
            </p>
          </>
        ))
      )}
    </div>
  );
}
