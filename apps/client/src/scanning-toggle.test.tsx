// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import { project as fixtureProject } from '../../scanner/test/fixtures';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), onSaved: vi.fn(), notify: vi.fn() }));
vi.mock('./api', async () => ({
  ...mocks,
  ApiError: (await import('./api-error')).ApiError,
}));
vi.mock('./CompetitorSettings', () => ({ default: () => null }));
vi.mock('./SocialAutomationSettings', () => ({ default: () => null }));
import SettingsView from './SettingsView';

let root: Root, container: HTMLDivElement, project: Project;
const path = '/projects/test-project';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  project = { ...structuredClone(fixtureProject), id: 'test-project', role: 'owner', enabled: true };
  mocks.request.mockReset().mockImplementation(async (_path: string, options: RequestInit) => ({ ...project, ...JSON.parse(String(options.body)), version: project.version + 1 }));
  mocks.onSaved.mockReset();
  mocks.notify.mockReset();
  mocks.useApi.mockImplementation((endpoint: string) => ({
    data: endpoint.endsWith('/settings') ? project : { items: [] }, loading: false,
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SettingsView path={path} onSaved={mocks.onSaved} notify={mocks.notify} />));
}
const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

describe('account scanning toggle', () => {
  it.each([true, false])('immediately saves the opposite of enabled=%s without changing account data', async (enabled) => {
    project.enabled = enabled;
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe(String(enabled));
    expect(toggle().getAttribute('aria-labelledby')).toBe('scanning-toggle-label');
    await act(async () => toggle().click());
    expect(mocks.request).toHaveBeenCalledOnce();
    const [endpoint, options] = mocks.request.mock.calls[0];
    expect(endpoint).toBe(`${path}/settings`);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ version: project.version, enabled: !enabled });
    expect(toggle().getAttribute('aria-checked')).toBe(String(!enabled));
    expect(mocks.onSaved).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(enabled ? 'Scanning paused. Your saved data is preserved.' : 'Scanning enabled.');
  });

  it('disables the switch during saving and keeps the prior state on failure', async () => {
    let fail!: (error: Error) => void;
    mocks.request.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await render();
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    expect(container.querySelector('.scanning-control')?.textContent).toContain('Saving…');
    await act(async () => fail(new Error('Could not save scanning settings')));
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save scanning settings');
    expect(mocks.onSaved).toHaveBeenCalledOnce();
  });

  it('prevents viewers from changing scanning', async () => {
    project.role = 'viewer';
    await render();
    expect(toggle().disabled).toBe(true);
    await act(async () => toggle().click());
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('does not overwrite the scanning state when saving brand settings', async () => {
    project.enabled = false;
    await render();
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).not.toHaveProperty('enabled');
  });
});
