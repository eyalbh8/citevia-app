// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<object>(), useApi }));
import PromptsView from './PromptsView';

it('keeps prompt metrics and actions aligned after removing the Created column', () => {
  const project = { id: 'prompt-layout', name: 'Example', country: 'GB', language: 'en', role: 'viewer',
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
});
