// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';
import AccountSwitcher from './AccountSwitcher';

function account(id: string, name: string, domain: string): Project {
  return { id, name, brand: { id: `${id}-brand`, name, aliases: [], domains: domain ? [domain] : [] },
    competitors: [], prompts: [], country: 'US', language: 'en', timezone: 'UTC', enabled: false,
    scheduleExpression: 'cron(0 6 ? * MON *)', generationModel: 'saved', extractionModel: 'saved', parserVersion: 'test',
    version: 1, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' };
}
const accounts = [
  account('gutter', 'All American Gutter Protection', 'allamericangutterprotection.com'),
  account('freedom', 'Freedom Power', 'gofreedompower.com'),
  account('windows', 'WindowWorks', 'mywindowworks.com'),
];
let root: Root, container: HTMLDivElement, originalScrollIntoView: typeof Element.prototype.scrollIntoView;
const onChange = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubEnv('VITE_LOGO_DEV_API_KEY', 'pk_account-switcher-fixture');
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  onChange.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const trigger = () => container.querySelector<HTMLButtonElement>('button')!;
const list = () => document.querySelector<HTMLElement>('[role="listbox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(list().getAttribute('aria-activedescendant')!);
async function render(project: Project | null = accounts[1], projects = accounts) {
  await act(async () => root.render(
    <aside style={{ overflow: 'hidden' }}>
      <AccountSwitcher project={project || undefined} projects={projects} onChange={onChange} />
    </aside>,
  ));
}
async function open() {
  await act(async () => trigger().click());
}
async function key(value: string) {
  await act(async () => list().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
}

describe('workspace account switcher', () => {
  it('shows the current company and opens an unclipped account menu with full names, domains and selected icons', async () => {
    await render();
    expect(container.querySelector('select')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Select account: Freedom Power');
    expect(trigger().querySelector('.filter-dropdown-caption')?.textContent).toBe('YOUR WORKSPACE');
    expect(trigger().querySelector('.filter-dropdown-selected-label')?.textContent).toBe('Freedom Power');
    expect(trigger().querySelector<HTMLElement>('.domain-logo')?.style.width).toBe('34px');
    expect(trigger().querySelector<HTMLImageElement>('img')?.src).toContain('img.logo.dev/gofreedompower.com');
    await open();
    const panel = document.querySelector<HTMLElement>('.account-switcher-menu')!;
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    expect(panel.style.width).toBe('320px');
    expect(panel.style.maxHeight).toBe('520px');
    expect(options()).toHaveLength(3);
    expect(list().getAttribute('aria-labelledby')).toBe(panel.querySelector('.filter-dropdown-heading')?.id);
    expect(document.activeElement).toBe(list());
    const selected = options().find(option => option.getAttribute('aria-selected') === 'true')!;
    expect(selected.getAttribute('aria-label')).toBe('Freedom Power');
    expect(selected.querySelector('.filter-dropdown-check svg')).not.toBeNull();
    expect(active()).toBe(selected);
    for (const [index, option] of options().entries()) {
      expect(option.textContent).toContain(accounts[index].name);
      expect(option.querySelector('small')?.textContent).toBe(accounts[index].brand.domains[0]);
      expect(option.querySelector<HTMLElement>('.domain-logo')?.style.width).toBe('32px');
      expect(option.querySelector<HTMLImageElement>('img')?.src).toContain(accounts[index].brand.domains[0]);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects exactly one account, closes the menu and keeps the supplied projects unchanged', async () => {
    const before = structuredClone(accounts);
    await render();
    await open();
    await act(async () => options()[0].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('gutter');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(accounts).toEqual(before);
    await render(accounts[0]);
    expect(trigger().querySelector('.filter-dropdown-selected-label')?.textContent).toBe('All American Gutter Protection');
    expect(trigger().querySelector<HTMLImageElement>('img')?.src).toContain('allamericangutterprotection.com');
    await open();
    expect(options().filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.getAttribute('aria-label')))
      .toEqual(['All American Gutter Protection']);
  });

  it('supports Home, End and arrow navigation and restores trigger focus on Escape without switching', async () => {
    await render();
    await act(async () => trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(active()?.getAttribute('aria-label')).toBe('Freedom Power');
    await key('Home');
    expect(active()?.getAttribute('aria-label')).toBe('All American Gutter Protection');
    await key('End');
    expect(active()?.getAttribute('aria-label')).toBe('WindowWorks');
    await key('ArrowUp');
    expect(active()?.getAttribute('aria-label')).toBe('Freedom Power');
    await key('Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('finds a company by typeahead and selects it with Enter', async () => {
    await render();
    await open();
    await key('w');
    expect(active()?.getAttribute('aria-label')).toBe('WindowWorks');
    await key('i');
    expect(active()?.getAttribute('aria-label')).toBe('WindowWorks');
    await key('Enter');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('windows');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('dismisses outside the menu without selecting a company', async () => {
    await render();
    await open();
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('retains the selected account while the paginated account list loads and avoids duplicate rows', async () => {
    await render(accounts[1], []);
    expect(trigger().disabled).toBe(false);
    await open();
    expect(options()).toHaveLength(1);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    await key('Escape');
    await render(accounts[1], [accounts[0], accounts[1], accounts[1]]);
    await open();
    expect(options()).toHaveLength(2);
    expect(options().filter(option => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('has an honest disabled empty state and uses initials when a website logo is unavailable', async () => {
    await render(null, []);
    expect(trigger().disabled).toBe(true);
    expect(trigger().textContent).toContain('No account assigned');
    expect(trigger().querySelector('img')).toBeNull();
    const unlisted = account('unlisted', 'Northern Service', '');
    await render(unlisted, [unlisted]);
    expect(trigger().querySelector('.domain-logo-fallback')?.textContent).toBe('NS');
    await open();
    expect(options()[0].querySelector('small')?.textContent).toBe('No website added');
    expect(options()[0].querySelector('img')).toBeNull();
  });

  it('uses the shared logo fallback cascade without changing the selected company', async () => {
    await render();
    await act(async () => trigger().querySelector('img')!.dispatchEvent(new Event('error')));
    expect(trigger().querySelector<HTMLImageElement>('img')?.src).toContain('google.com/s2/favicons?domain=gofreedompower.com');
    await act(async () => trigger().querySelector('img')!.dispatchEvent(new Event('error')));
    expect(trigger().querySelector('img')).toBeNull();
    expect(trigger().querySelector('.domain-logo-fallback')?.textContent).toBe('FP');
    expect(trigger().getAttribute('aria-label')).toBe('Select account: Freedom Power');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps its portal in the navigation dialog when used in the mobile sidebar', async () => {
    await act(async () => root.render(
      <aside role="dialog" aria-label="Workspace navigation" aria-modal="true">
        <AccountSwitcher projects={accounts} project={accounts[1]} onChange={onChange} />
      </aside>,
    ));
    await open();
    expect(document.querySelector('.account-switcher-menu')?.parentElement).toBe(container.querySelector('[role="dialog"]'));
    expect(document.querySelector('.account-switcher-menu')?.closest('[aria-modal="true"]')).not.toBeNull();
    await key('Escape');
    expect(document.activeElement).toBe(trigger());
  });

  it('bounds the larger menu to a narrow, short viewport', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(320);
    vi.stubGlobal('innerHeight', 240);
    await render();
    await open();
    const panel = document.querySelector<HTMLElement>('.account-switcher-menu')!;
    const width = Number.parseFloat(panel.style.width), left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top), height = Number.parseFloat(panel.style.maxHeight);
    expect(width).toBe(296);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + width).toBeLessThanOrEqual(308);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + height).toBeLessThanOrEqual(228);
  });
});
