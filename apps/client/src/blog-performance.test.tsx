// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOG_REVIEW_RULES, evaluateBlog, type AgentPost, type BlogPerformancePage, type Project, type TrackedUrl } from '@citevia/core';
const { useApi, request, idempotentPost } = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), idempotentPost: vi.fn() }));
vi.mock('./api', async (original) => ({ ...(await original<object>()), useApi, request, idempotentPost }));
import BlogPerformanceView from './BlogPerformanceView';

const project = { id: 'account-A', name: 'Northstar Analytics', brand: { name: 'Northstar' }, role: 'owner' } as Project;
const prompt = { id: 'p_01', text: 'How do I choose useful metrics?', active: true, version: 1, branded: false, createdAt: '', updatedAt: '' };
const tracked: TrackedUrl = {
  id: 'a5bce428-d988-433a-be08-fd3dcf403357', projectId: project.id,
  url: 'https://northstar.example/blog/metrics', normalizedUrl: 'northstar.example/blog/metrics', title: 'Choose useful metrics', promptId: prompt.id,
  contentType: 'BLOG', active: true, createdAt: '2026-10-01T00:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', version: 1,
};
const row = evaluateBlog(tracked, prompt, [1, 2, 3].map((i) => ({ key: `openai:${i}`, promptId: prompt.id, promptText: prompt.text, provider: 'openai' as const, cited: false, at: `2026-10-2${i}T10:00:00.000Z` })), ['openai'], new Date('2026-11-02T12:00:00.000Z'));
const data: BlogPerformancePage = { items: [row], total: 1, page: 0, pageSize: 25, prompts: [prompt], evaluatedAt: '2026-11-02T12:00:00.000Z', rules: BLOG_REVIEW_RULES, generationAvailable: true };
let root: Root, container: HTMLDivElement;
const onTracking = vi.fn();
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!;
async function click(text: string) { expect(button(text)).toBeDefined(); await act(async () => button(text).click()); }
async function render(props: Partial<Parameters<typeof BlogPerformanceView>[0]> = {}) {
  await act(async () => root.render(createElement(BlogPerformanceView, { project, systemAdmin: true, onTracking, ...props })));
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const element = container.querySelector(selector) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('admin blog review', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    useApi.mockImplementation((path: string | null) => ({ data: path?.includes('/blog-performance') ? structuredClone(data) : undefined }));
    request.mockResolvedValue({});
    HTMLElement.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it('does not fetch private review data for non-admin direct navigation', async () => {
    await render({ systemAdmin: false });
    expect(container.textContent).toContain('Administrator access required');
    expect(useApi).not.toHaveBeenCalled();
  });
  it('shows evidence, the same prompt, a recommendation and rules', async () => {
    await render();
    expect(container.textContent).toContain(prompt.text);
    expect(container.textContent).toContain('Needs improvement');
    expect(container.textContent).toContain('Adjust this article');
    expect(container.textContent).toContain('3 scan days');
    expect(container.textContent).toContain('Failed scans, repeated captures');
    await click('Manage tracked URLs');
    expect(onTracking).toHaveBeenCalledOnce();
  });
  it('saves a versioned prompt link and can remove the association', async () => {
    await render(); await click('Change prompt');
    const select = container.querySelector<HTMLSelectElement>('#blog-target-prompt')!;
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledWith(`/projects/account-A/blog-performance/${tracked.id}`, { method: 'PATCH', body: JSON.stringify({ version: 1, promptId: null }) });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('requires current article text for adjustments and sends the exact linked prompt and action', async () => {
    idempotentPost.mockResolvedValue({ post: { id: 'post_refresh', status: 'queued' } });
    await render(); await click('Prepare adjustment draft');
    expect(button('Generate blog draft').disabled).toBe(true);
    await fill('#blog-current-article', 'The current article, with useful original sections.');
    expect(button('Generate blog draft').disabled).toBe(false);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(idempotentPost).toHaveBeenCalledWith('/projects/account-A/agents/posts', { channel: 'blog', promptId: prompt.id, blogRefresh: { trackedUrlId: tracked.id, action: 'adjust', originalBody: 'The current article, with useful original sections.' } });
    expect(useApi).toHaveBeenCalledWith('/projects/account-A/agents/posts/post_refresh');
  });
  it('shows generation errors without closing the change brief', async () => {
    idempotentPost.mockRejectedValue(new Error('The recommendation changed. Refresh the blog review before generating.'));
    await render(); await click('Prepare adjustment draft'); await fill('#blog-current-article', 'Current article');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('recommendation changed');
    expect(container.querySelector('#blog-current-article')).not.toBeNull();
  });
  it('resets the account review and closes stale forms when switching accounts', async () => {
    await render(); await click('Prepare adjustment draft');
    await render({ project: { ...project, id: 'account-B', name: 'Another brand' } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(useApi).toHaveBeenCalledWith('/projects/account-B/blog-performance?page=0&outcome=all');
  });
  it('disables unavailable generation and displays fetch errors', async () => {
    useApi.mockImplementation((path: string | null) => ({ data: path ? { ...data, generationAvailable: false } : undefined }));
    await render(); expect(button('Prepare adjustment draft').disabled).toBe(true);
    useApi.mockReturnValue({ error: new Error('Access denied') });
    await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Access denied');
  });
});
