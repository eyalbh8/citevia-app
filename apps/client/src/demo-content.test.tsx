// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import DemoContentView, { readDemoContentPath } from './DemoContentView';
const api = vi.hoisted(() => ({ value: { data: undefined as Project | undefined, loading: false, error: undefined as Error | undefined }, use: vi.fn() }));
vi.mock('./api', async () => ({ ApiError: (await import('./api-error')).ApiError, useApi: (path: string) => { api.use(path); return api.value; } }));
const projectId = 'account_acme_locksmith_demo_v1', slug = 'planning-smart-lock-installation';
const project = () => ({ id: projectId, name: 'ACME Locksmith', demo: { source: 'website-demo', trackedUrls: [{
  url: `https://app.citevia.io/demo-content/${projectId}/${slug}`, title: 'Planning smart lock installation',
  publishedAt: '2026-05-04T08:00:00.000Z', demoPost: true,
  body: 'Confirm the door measurements and hardware compatibility.\n\nAsk about installation and maintenance.',
  provenance: { kind: 'demo-draft', sourceUrls: ['https://www.acmelocksmith.com/', 'javascript:alert(1)'] },
}] } }) as Project;
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.value = { data: project(), loading: false, error: undefined }; api.use.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<DemoContentView projectId={projectId} slug={slug} />));
describe('Authenticated demo articles', () => {
  it('loads the scoped account and presents the full draft with its provenance', async () => {
    await render();
    expect(api.use).toHaveBeenCalledWith(`/projects/${projectId}/settings`);
    expect(container.querySelector('h1')?.textContent).toBe('Planning smart lock installation');
    expect(container.querySelectorAll('.demo-article-body p')).toHaveLength(2);
    expect(container.querySelector('.demo-article-note')?.textContent).toContain('demo scenario');
    expect(container.querySelectorAll('.demo-article-references a')).toHaveLength(1);
    expect(container.querySelector('.demo-article-references a')?.getAttribute('href')).toBe('https://www.acmelocksmith.com/');
  });
  it('does not expose a normal account or an official article through the demo route', async () => {
    api.value.data!.demo!.source = 'igeo-dr-roof'; await render();
    expect(container.textContent).toContain('Demo article unavailable');
    api.value.data = project(); delete api.value.data.demo!.trackedUrls![0].demoPost; await render();
    expect(container.querySelector('h1')).toBeNull();
  });
  it('renders article content as plain text and cannot execute source markup', async () => {
    api.value.data!.demo!.trackedUrls![0].body = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>';
    await render();
    expect(container.querySelectorAll('.demo-article-body script,.demo-article-body img')).toHaveLength(0);
    expect(container.querySelector('.demo-article-body')?.textContent).toContain('<script>');
  });
  it('keeps access failures visible without article content', async () => {
    api.value = { loading: false, data: undefined, error: new Error('Account access denied') }; await render();
    expect(container.textContent).toContain('Account access denied'); expect(container.querySelector('h1')).toBeNull();
  });
  it('rejects malformed routes and encoded traversal segments', () => {
    expect(readDemoContentPath(`/demo-content/${projectId}/${slug}`)).toEqual({ projectId, slug });
    for (const path of ['/demo-content/a/../b','/demo-content/a/%2fother','/demo-content/a/%ZZ','/demo-content/a/a?x=1','/demo-content/a/a/b']) expect(readDemoContentPath(path)).toBeNull();
  });
});
