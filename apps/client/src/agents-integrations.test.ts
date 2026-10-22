// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<object>()),
  useApi,
}));
import AgentsView from './AgentsView';
import IntegrationsView from './IntegrationsView';

const project = {
  id: 'account-A',
  name: 'Account A',
  brand: { name: 'Northstar' },
  role: 'viewer',
  prompts: [{ topic: 'Discovery' }],
} as Project;
let root: Root, container: HTMLDivElement;
const onMcp = vi.fn(),
  onTraffic = vi.fn(),
  onIntegrations = vi.fn();
const buttons = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) =>
      button.textContent?.trim() === text ||
      button.getAttribute('aria-label') === text,
  );
async function click(text: string) {
  const button = buttons(text)[0];
  expect(button, `Button ${text}`).toBeDefined();
  await act(async () => button.click());
}
async function integrations(
  props: Partial<Parameters<typeof IntegrationsView>[0]> = {},
) {
  await act(async () =>
    root.render(
      createElement(IntegrationsView, {
        systemAdmin: false,
        project,
        onMcp,
        onTraffic,
        ...props,
      }),
    ),
  );
}

describe('agents and integrations interactions', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    useApi.mockImplementation((path: string | null) => ({
      data: !path ? undefined : path.endsWith('/prompts')
        ? { items: [], version: 1 }
        : { connections: [] },
    }));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('combines category and keyword filtering and clears an empty result', async () => {
    await integrations();
    expect(container.querySelectorAll('.integration-card')).toHaveLength(17);
    await click('Social Media');
    expect(container.querySelectorAll('.integration-card')).toHaveLength(6);
    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search integrations"]',
    )!;
    const fill = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(search, value);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await fill('Twitter');
    expect(container.querySelectorAll('.integration-card')).toHaveLength(1);
    expect(container.querySelector('.integration-card h2')?.textContent).toBe(
      'X (Twitter)',
    );
    await click('Analytics');
    expect(container.textContent).toContain(
      'No integrations match your search',
    );
    await click('Clear filters');
    expect(container.querySelectorAll('.integration-card')).toHaveLength(17);
  });

  it('keeps MCP credentials account scoped for viewers and global for system admins', async () => {
    await integrations();
    expect(useApi).toHaveBeenLastCalledWith(
      '/mcp/connections?projectId=account-A',
    );
    await integrations({ systemAdmin: true });
    expect(useApi).toHaveBeenLastCalledWith('/mcp/connections');
    await integrations({ project: undefined });
    expect(useApi).toHaveBeenLastCalledWith(null);
    expect(container.querySelectorAll('.integration-ready')).toHaveLength(0);
  });

  it('only marks MCP ready for active credentials, without claiming client connectivity', async () => {
    useApi.mockReturnValue({
      data: {
        connections: [
          { revokedAt: '2026-01-01', expiresAt: null },
          { revokedAt: null, expiresAt: '2000-01-01' },
        ],
      },
    });
    await integrations();
    expect(container.querySelectorAll('.integration-ready')).toHaveLength(0);
    useApi.mockReturnValue({
      data: { connections: [{ revokedAt: null, expiresAt: null }] },
    });
    await integrations();
    expect(container.querySelectorAll('.integration-ready')).toHaveLength(6);
    expect(container.textContent).not.toContain('Connected to');
    await click('MCP');
    await click('Manage');
    expect(onMcp).toHaveBeenCalledOnce();
  });

  it('opens honest provider setup details and supports Escape dismissal', async () => {
    await integrations();
    await click('View setup');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Not available in Citevia yet.',
    );
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Google',
    );
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click('View setup');
    await click('Set up Citevia website tracking');
    expect(onTraffic).toHaveBeenCalledOnce();
  });

  it('highlights a channel deep link, resetting filters and closing stale setup', async () => {
    await integrations();
    await click('View setup');
    await click('Close details');
    await click('Analytics');
    await integrations({ highlight: 'reddit' });
    expect(container.querySelectorAll('.integration-card')).toHaveLength(17);
    expect(container.querySelector('.is-highlighted')?.id).toBe(
      'integration-reddit',
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('shows connection errors without inferring connected accounts', async () => {
    useApi.mockReturnValue({ error: new Error('Access denied') });
    await integrations();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Access denied',
    );
    expect(container.querySelectorAll('.integration-ready')).toHaveLength(0);
  });

  it('routes agent cards to the matching integration and gates generation', async () => {
    await act(async () =>
      root.render(
        createElement(AgentsView, {
          project: { ...project, role: 'owner' },
          onIntegrations,
        }),
      ),
    );
    expect(container.querySelectorAll('.agent-channel-card')).toHaveLength(6);
    await click('Manage Reddit connection');
    expect(onIntegrations).toHaveBeenCalledWith('reddit');
    await click('Generate');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Content generation is not enabled',
    );
    expect(buttons('Generate content')[0].disabled).toBe(true);
    await click('Cancel');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
