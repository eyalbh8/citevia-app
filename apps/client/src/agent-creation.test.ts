// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPost, AgentPostPage, Project } from '@citevia/core';
const mocks = vi.hoisted(() => ({
  useApi: vi.fn(),
  request: vi.fn(),
  idempotentPost: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('./api', async (original) => ({
  ...(await original<object>()),
  ...mocks,
}));
vi.mock('./query-cache', () => ({ invalidateApiQueries: mocks.invalidate }));
import AgentsView from './AgentsView';
const project = {
  id: 'account-A',
  name: 'Account A',
  brand: { name: 'Northstar' },
  role: 'owner',
  prompts: [
    {
      id: 'tracked-1',
      text: 'Which metrics should I track?',
      topic: 'Reporting',
      active: true,
    },
  ],
} as Project;
const newPost = (): AgentPost => ({
  id: 'post-1',
  projectId: project.id,
  channel: 'facebook',
  topic: 'Reporting',
  prompt: 'Which metrics should I track?',
  status: 'draft',
  content: {
    title: 'Clearer reporting',
    body: 'Start with a useful question.',
    hashtags: ['#Analytics'],
  },
  createdAt: '2026-10-21T09:00:00Z',
  updatedAt: '2026-10-21T09:00:00Z',
  version: 4,
  model: 'configured-model',
  error: null,
});
let root: Root,
  container: HTMLDivElement,
  report: AgentPostPage,
  post: AgentPost;
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) =>
      item.textContent?.trim() === name ||
      item.getAttribute('aria-label') === name,
  )!;
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name).click());
}
async function fill(id: string, value: string) {
  const element = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
  expect(element).toBeTruthy();
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
async function render(selected = project) {
  await act(async () =>
    root.render(
      createElement(AgentsView, {
        key: selected.id,
        project: selected,
        onIntegrations: vi.fn(),
      }),
    ),
  );
}

describe('agent creation UI', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    post = newPost();
    report = {
      items: [],
      total: 0,
      nextCursor: null,
      generationAvailable: true,
    };
    mocks.useApi.mockImplementation((path: string | null) => ({
      data: !path ? undefined : path.includes('/posts/') ? { post } : report,
      loading: false,
    }));
    mocks.idempotentPost.mockImplementation(async (path: string) => {
      post = { ...post, status: 'queued', content: null };
      report = { ...report, items: [post], total: 1 };
      return { post };
    });
    mocks.request.mockResolvedValue({ post });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('creates a tracked-prompt draft through the real API contract and shows queued progress', async () => {
    await render();
    await click('Generate');
    await fill('agent-channel', 'reddit');
    await fill('agent-tracked-prompt', 'tracked-1');
    expect(
      (document.getElementById('agent-topic') as HTMLInputElement).value,
    ).toBe('Reporting');
    await click('Generate content');
    expect(mocks.idempotentPost).toHaveBeenCalledWith(
      '/projects/account-A/agents/posts',
      {
        channel: 'reddit',
        topic: 'Reporting',
        prompt: 'Which metrics should I track?',
        promptId: 'tracked-1',
      },
    );
    expect(container.textContent).toContain('Your post is queued');
    expect(container.textContent).not.toContain(
      'Content generation is not enabled',
    );
  });

  it('preserves form input and displays a failed submission without creating a fake post', async () => {
    mocks.idempotentPost.mockRejectedValueOnce(
      new Error('Queue unavailable. Please retry.'),
    );
    await render();
    await click('Generate');
    await fill('agent-topic', 'Reporting');
    await fill('agent-prompt', 'A custom question');
    await click('Generate content');
    expect(container.textContent).toContain('Queue unavailable. Please retry.');
    expect(
      (document.getElementById('agent-prompt') as HTMLTextAreaElement).value,
    ).toBe('A custom question');
    expect(container.textContent).not.toContain('Your post is queued');
    expect(button('Generate content').disabled).toBe(false);
  });

  it('keeps viewers read-only while allowing them to open saved drafts', async () => {
    report = { ...report, items: [post], total: 1 };
    await render({ ...project, role: 'viewer' });
    expect(button('Generate').disabled).toBe(true);
    await click('Open post: Reporting');
    expect(container.textContent).toContain(post.content!.body);
    expect(button('Edit draft')).toBeUndefined();
    expect(button('Copy content')).toBeDefined();
    expect(mocks.idempotentPost).not.toHaveBeenCalled();
  });

  it('edits a saved draft with a version check and keeps edits after a conflict', async () => {
    report = { ...report, items: [post], total: 1 };
    mocks.request.mockRejectedValueOnce(
      new Error('This post changed. Refresh it before saving.'),
    );
    await render();
    await click('Open post: Reporting');
    await click('Edit draft');
    await fill('agent-edit-body', 'My reviewed draft');
    await click('Save draft');
    expect(mocks.request).toHaveBeenCalledWith(
      '/projects/account-A/agents/posts/post-1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          ...post.content,
          body: 'My reviewed draft',
          version: 4,
        }),
      },
    );
    expect(container.textContent).toContain(
      'This post changed. Refresh it before saving.',
    );
    expect(
      (document.getElementById('agent-edit-body') as HTMLTextAreaElement).value,
    ).toBe('My reviewed draft');
  });

  it('polls queued jobs and stops polling after they become drafts', async () => {
    vi.useFakeTimers();
    post = { ...post, status: 'queued', content: null };
    report = { ...report, items: [post], total: 1 };
    await render();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(mocks.invalidate).toHaveBeenCalledWith('/projects/account-A/agents');
    mocks.invalidate.mockClear();
    post = newPost();
    report = { ...report, items: [post] };
    await render();
    await act(async () => vi.advanceTimersByTime(6000));
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('clears account-specific form and drawer state when switching accounts', async () => {
    await render();
    await click('Generate');
    await fill('agent-topic', 'Account A private topic');
    await render({
      ...project,
      id: 'account-B',
      brand: { ...project.brand, name: 'Other account' },
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click('Generate');
    expect(
      (document.getElementById('agent-topic') as HTMLInputElement).value,
    ).toBe('');
    expect(mocks.useApi).toHaveBeenCalledWith(
      '/projects/account-B/agents/posts?cursor=0&limit=10',
    );
  });
});
