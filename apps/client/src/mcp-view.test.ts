import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@citevia/core';

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock('./api', async importOriginal => ({ ...(await importOriginal<object>()), useApi }));
import McpView, { CreatedConnectionPanel } from './McpView';

const project = { id: 'account-A', name: 'Account A', role: 'viewer' } as Project;
const connectionData = {
  scope: 'account', projectId: project.id, projectName: project.name,
  serverUrl: 'https://app.citevia.io/api/v1/mcp/accounts/account-A',
  oauthEnabled: true, connections: [],
};

describe('MCP connection scope UI', () => {
  beforeEach(() => { useApi.mockReset(); });

  it('loads the global connection for an administrator independently of the selected account', () => {
    useApi.mockReturnValue({ data: { ...connectionData, scope: 'system', projectId: null, projectName: null, serverUrl: 'https://app.citevia.io/api/v1/mcp' } });
    const html = renderToStaticMarkup(createElement(McpView, { systemAdmin: true, project, revision: 0 }));
    expect(useApi).toHaveBeenCalledWith('/mcp/connections', 0);
    expect(html).toContain('All accounts');
    expect(html).not.toContain('Account A');
    expect(html).not.toContain('/accounts/account-A');
  });

  it('keeps a viewer account scoped and explains the read-only credential', () => {
    useApi.mockReturnValue({ data: connectionData });
    const html = renderToStaticMarkup(createElement(McpView, { systemAdmin: false, project, revision: 0 }));
    expect(useApi).toHaveBeenCalledWith('/mcp/connections?projectId=account-A', 0);
    expect(html).toContain('Read-only access · Viewer');
    expect(html).toContain('Create API key');
    expect(html).toContain('https://app.citevia.io/api/v1/mcp/accounts/account-A');
    expect(html).not.toContain('All accounts');
    expect(html).toContain('None / No authentication');
    expect(html).toContain('Add to ChatGPT');
    expect(html).toContain('Add to Claude');
    expect(html).not.toContain('mcp_token=');
  });

  it('never falls back to a global connection when a non-admin has no assigned account', () => {
    const html = renderToStaticMarkup(createElement(McpView, { systemAdmin: false, revision: 0 }));
    expect(useApi).not.toHaveBeenCalled();
    expect(html).toContain('Select an account to connect');
    expect(html).not.toContain('Create API key');
  });

  it('shows the newly created URL before advanced credentials and explains URL-only authentication', () => {
    const created = {
      scope: 'account' as const,
      projectId: 'account-A',
      serverUrl: connectionData.serverUrl,
      token: 'qa-only-created-token',
      connection: { id: 'qa-created', name: 'My assistant', keyPrefix: 'qa-only', createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null, revokedAt: null, kind: 'api_key' as const },
    };
    const html = renderToStaticMarkup(createElement(CreatedConnectionPanel, { created, onHide: () => undefined }));
    expect(html).toContain('Connection URL (URL-only)');
    expect(html).toContain('mcp_token=qa-only-created-token&amp;workspace_id=account-A');
    expect(html).toContain('None / No authentication');
    expect(html).toContain('href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('https://claude.ai/customize/connectors?modal=add-custom-connector');
    expect(html.indexOf('mcp-connection-url')).toBeLessThan(html.indexOf('mcp-new-key'));
    expect(html).toContain('<details class="mcp-config-details">');
    expect(html).not.toContain('<details class="mcp-config-details" open');
    expect(html).toContain('hide it');
  });
});
