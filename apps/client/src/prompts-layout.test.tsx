// @vitest-environment jsdom
import { resolveReportId } from '@citevia/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
const { useApi, downloadCsv } = vi.hoisted(() => ({ useApi: vi.fn(), downloadCsv: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<object>(), useApi, downloadCsv }));
import PromptsView from './PromptsView';

it.each([undefined, 'uk_investing', 'merchant_payments'])('aligns prompt metrics and explains the comparison for profile %s', reportingProfile => {
  const project = { id: 'prompt-layout', name: 'Example', country: 'GB', language: 'en', role: 'viewer',
    demo: reportingProfile && { reportingProfile, startDate: '2026-05-05', endDate: '2027-05-05' },
    brand: { id: 'target', name: 'Example', aliases: [], domains: ['example.com'] },
    scanProviders: [{ provider: 'openai', model: 'saved' }],
    prompts: [{ id: 'p1', text: 'Which investing platforms should I compare?', version: 1, active: true,
      createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z', branded: false, tags: [] }] } as unknown as Project;
  useApi.mockImplementation((path: string) => ({ loading: false, data: path.endsWith('/settings') ? project : undefined }));
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<PromptsView path="/projects/prompt-layout" onSaved={() => {}} notify={() => {}} />);
  const headings = [...container.querySelectorAll('thead th')];
  expect(headings.some(th => th.textContent?.includes('Created'))).toBe(false);
  expect(headings).toHaveLength(8);
  expect(container.querySelectorAll('tbody tr:first-child td')).toHaveLength(8);
  expect(container.querySelector('[aria-label^="View all answers"]')).not.toBeNull();
  expect(container.querySelector('.prompt-comparison-note')?.textContent).toContain(
    reportingProfile ? 'Changes show estimated growth' : 'Changes compare matching analysis settings',
  );
});

it('exports a stable public reference for a selected account prompt', async () => {
  const id = 'account_etoro_demo_v1-p01';
  const project = { id: 'account_etoro_demo_v1', country: 'GB', language: 'en', role: 'viewer',
    demo: { startDate: '2026-05-05', endDate: '2027-05-05' },
    brand: { id: 'target', name: 'eToro', aliases: [], domains: ['etoro.com'] },
    prompts: [{ id, text: 'Which investing platforms should I compare?', version: 1, active: true,
      createdAt: '2026-05-05T00:00:00.000Z', updatedAt: '2026-05-05T00:00:00.000Z', tags: [] }] };
  useApi.mockImplementation((path: string) => ({ loading: false, data: path.endsWith('/settings') ? project : undefined }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    await act(async () => root.render(<PromptsView path="/projects/account_etoro_demo_v1" onSaved={() => {}} notify={() => {}} />));
    await act(async () => container.querySelector<HTMLInputElement>('tbody input[type=checkbox]')!.click());
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Export selected'))!;
    await act(async () => button.click());
    const [, headers, rows] = downloadCsv.mock.lastCall!;
    expect(headers[0]).toBe('Prompt reference');
    expect(resolveReportId(rows[0][0])).toBe(id);
    expect(JSON.stringify(rows)).not.toContain(id);
    expect(rows[0][1]).toBe(project.prompts[0].text);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
