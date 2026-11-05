// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import { Skeleton } from './Loading';
import { useMonitoringSelection } from './MonitoringUI';

it('keeps loading feedback accessible without visible captions', () => {
  const html = renderToStaticMarkup(<Skeleton variant="table" label="Loading tracked content…" />);
  const container = document.createElement('div');
  container.innerHTML = html;
  expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading tracked content…');
  expect(container.textContent).toBe('');
  expect(container.querySelector('.skeleton-caption')).toBeNull();
});

describe('shared monitoring filters', () => {
  it('retains the selected period across report screens, scoped to the account', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sessionStorage.clear();
    const container = document.createElement('div'), root = createRoot(container);
    const project = { id: 'shared-monitoring-account' } as Project;
    function Report({ account }: { account: Project }) {
      const [selection, setSelection] = useMonitoringSelection(account);
      return <button onClick={() => setSelection({ ...selection, days: '30', providers: ['gemini'] })}>{selection.days}:{selection.providers.join(',')}</button>;
    }
    try {
      await act(async () => root.render(<Report key="mentions" account={project} />));
      await act(async () => container.querySelector('button')!.click());
      await act(async () => root.render(<Report key="tracking" account={project} />));
      expect(container.textContent).toBe('30:gemini');
      await act(async () => root.render(<Report key="another" account={{ ...project, id: 'another-account' }} />));
      expect(container.textContent).toBe('7:');
    } finally { await act(async () => root.unmount()); sessionStorage.clear(); vi.unstubAllGlobals(); }
  });
});
