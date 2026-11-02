// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import { project as fixtureProject } from '../../scanner/test/fixtures';

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), onSaved: vi.fn(), notify: vi.fn() }));
vi.mock('./api', async () => ({ ...mocks, ApiError: (await import('./api-error')).ApiError }));
vi.mock('./CompetitorSettings', () => ({ default: () => null }));
vi.mock('./SocialAutomationSettings', () => ({ default: () => null }));
import SettingsView from './SettingsView';

let root: Root, container: HTMLDivElement, project: Project;
const path = '/projects/frequency-test';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  project = { ...structuredClone(fixtureProject), id: 'frequency-test', role: 'owner', enabled: true,
    scanSchedule: { version: 1, slotsUtcMinutes: [360, 5400] } };
  mocks.request.mockReset().mockImplementation(async (_path: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return { ...project, ...body, version: project.version + 1,
      scanSchedule: { version: 2, slotsUtcMinutes: Array.from({ length: body.scanRunsPerWeek }, (_, i) => (360 + i * 10080 / body.scanRunsPerWeek) % 10080) } };
  });
  mocks.onSaved.mockReset(); mocks.notify.mockReset();
  mocks.useApi.mockImplementation((endpoint: string) => ({ data: endpoint.endsWith('/settings') ? project : { items: [] }, loading: false }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<SettingsView path={path} onSaved={mocks.onSaved} notify={mocks.notify} />)); }
const form = () => container.querySelector<HTMLFormElement>('form[aria-label="Weekly scan frequency"]')!;
const input = () => form().querySelector<HTMLInputElement>('input')!;
async function change(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(async () => form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

describe('weekly scan frequency', () => {
  it('saves an integer with optimistic versioning while keeping scanning paused', async () => {
    project.enabled = false;
    await render();
    expect(input().value).toBe('2');
    expect(form().textContent).toContain('Scanning stays paused');
    await change('5'); await submit();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(`${path}/settings`, {
      method: 'PATCH', body: JSON.stringify({ version: project.version, scanRunsPerWeek: 5 }),
    });
    expect(mocks.notify).toHaveBeenCalledWith('Scan schedule saved: 5 runs per week.');
    expect(mocks.onSaved).toHaveBeenCalledOnce();
    expect(form().querySelector('button')!.disabled).toBe(true);
  });

  it.each(['', '0', '8', '2.5'])('rejects invalid frequency %j even on a forced submit', async value => {
    await render(); await change(value); await submit();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('whole number from 1 to 7');
  });

  it.each(['viewer', 'demo'])('keeps the frequency read-only for %s access', async access => {
    if (access === 'demo') project.demo = { version: 1, source: 'website-demo', anchorDate: '2026-11-02',
      startDate: '2026-10-01', endDate: '2026-11-02', sourceAccountId: 'demo-source', sourceCopiedAt: '2026-11-02T00:00:00Z' };
    else project.role = 'viewer';
    await render();
    expect(input().disabled).toBe(true);
    expect(form().querySelector('button')).toBeNull();
    await change('3'); await submit();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('shows the saved frequency and refreshes after a failed schedule synchronization', async () => {
    project.scanSchedule = { version: 2, slotsUtcMinutes: [360, 3720, 7080] };
    mocks.request.mockRejectedValue(new Error('Could not synchronize the schedule'));
    await render();
    expect(input().value).toBe('3');
    expect(container.textContent).toContain('3 snapshots each week');
    await change('4'); await submit();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('Could not synchronize');
    expect(mocks.onSaved).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
