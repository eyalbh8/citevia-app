// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardOverview, Project } from '@citevia/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), onboardAccounts: vi.fn() }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(), ...mocks,
}));
vi.mock('./auth', () => ({ getAccessToken: async () => 'test', signIn: vi.fn() }));
import AccountsView from './AccountsView';
import { DashboardView } from './DashboardView';
import { previewProgress } from './prospect-preview';

const project = {
  id: 'sample', name: 'Sample', brand: { name: 'Sample', domains: ['sample.com'], aliases: [], id: 'target' },
  competitors: [], prompts: [], country: 'US', language: 'en', timezone: 'UTC', accountType: 'prospect',
  scanProviders: [{ provider: 'openai', model: 'test' }], role: 'owner', activePromptCount: 10,
  onboardingSummary: { status: 'completed', step: 'completed', firstRunId: 'original' },
} as unknown as Project;
const scan: NonNullable<Project['previewScan']> = {
  id: 'original', status: 'completed', totalCount: 10, succeededCount: 10, terminalCount: 10,
  scheduledAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T23:58:00Z', completedAt: '2026-01-02T00:12:00Z',
};
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.useApi.mockReset();
  mocks.onboardAccounts.mockReset();
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const element = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
  if (!element) throw Error(`Missing button: ${label}`);
  return element;
}

it('keeps Standard as the default and submits a prospective company for a single ChatGPT scan', async () => {
  mocks.useApi.mockReturnValue({ data: { items: [project], total: 1 } });
  mocks.onboardAccounts.mockResolvedValue({ items: [{ project }], limitReached: false });
  await act(async () => root.render(<AccountsView canCreate onboardingReady={{ standard: false, prospect: true }}
    onChanged={vi.fn()} onOpen={vi.fn()} notify={vi.fn()} />));
  expect(container.textContent).toContain('ChatGPT scan queued');
  expect(container.textContent).not.toContain('Preview ready');
  await act(async () => button('New account').click());
  const type = container.querySelector('select')!;
  expect(type.value).toBe('standard');
  expect(button('Create account').disabled).toBe(true);
  await act(async () => {
    type.value = 'prospect';
    type.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Create preview').disabled).toBe(false);
  expect(container.textContent).toContain('8 unbranded prompts and 2 branded prompts');
  expect(container.textContent).toContain('One ChatGPT scan');
  const [name, website] = container.querySelectorAll<HTMLInputElement>('form input');
  const update = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await act(async () => { update(name, 'Sample'); update(website, 'https://sample.com'); });
  await act(async () => button('Create preview').click());
  expect(mocks.onboardAccounts).toHaveBeenCalledWith([{
    name: 'Sample', website: 'https://sample.com', region: 'US', language: 'en', accountType: 'prospect',
  }]);
});

it('distinguishes scan progress, partial, failed and ready reports', () => {
  for (const [status, count, label, pending] of [
    ['running', 4, 'Scanning ChatGPT · 4/10 answers analyzed', true],
    ['partial', 8, 'Partial preview · 8/10 answers analyzed', false],
    ['failed', 0, 'Scan failed · 0/10 answers analyzed', false],
    ['completed', 9, 'Partial preview · 9/10 answers analyzed', false],
    ['completed', 10, 'Preview ready · 10/10 answers analyzed', false],
  ] as const) {
    expect(previewProgress({ ...project, previewScan: { ...scan, status, succeededCount: count } })).toMatchObject({ label, pending });
  }
});

it('reopens the original ten answers months later, including a scan crossing midnight UTC', async () => {
  window.sessionStorage.setItem('citevia:monitoring:sample', JSON.stringify({
    days: '7', start: '', end: '', region: '', branded: '', stage: '', providers: ['gemini'],
  }));
  const data = {
    period: { start: scan.createdAt, end: scan.completedAt, timezone: 'UTC', granularity: 'daily' }, filters: {},
    analyzed: 10, providers: [{ provider: 'openai', count: 4, change: 100 }],
    ranking: [], stages: [], trend: [], sources: [],
  } as unknown as DashboardOverview;
  mocks.useApi.mockImplementation((path: string) => ({ data: path.includes('/responses?') ? {
    items: [{ promptId: 'p1', responseId: 'original~p1', prompt: { text: 'Original question?' }, status: 'succeeded' }],
  } : data }));
  const onResponse = vi.fn();
  await act(async () => root.render(<DashboardView project={{ ...project, previewScan: scan }} path="/projects/sample" onResponse={onResponse} />));
  const reportPath = mocks.useApi.mock.calls.find(([path]) => path.includes('/dashboard/overview'))?.[0];
  const params = new URL(reportPath, 'https://sample.com').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ days: 'custom', start: '2026-01-01', end: '2026-01-02', providers: 'openai' });
  expect(mocks.useApi.mock.calls.some(([path]) => /responses\?.*runId=original/.test(path))).toBe(true);
  expect(container.textContent).toContain('Preview ready · 10/10 answers analyzed');
  expect(container.textContent).not.toContain('Brand Visibility Over Time');
  await act(async () => container.querySelector<HTMLButtonElement>('.preview-answers button')!.click());
  expect(onResponse).toHaveBeenCalledWith('original~p1');
});
