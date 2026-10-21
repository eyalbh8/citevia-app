import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock('./api', async importOriginal => ({ ...(await importOriginal<object>()), useApi }));
import McpConsent from './McpConsent';

const consent = {
  clientName: 'An MCP assistant', scope: 'account', projectId: null, projectName: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  projects: [{ id: 'account-a', name: 'Account A', role: 'viewer' }],
};

describe('MCP consent scope disclosure', () => {
  beforeEach(() => useApi.mockReset());

  it('discloses all-account administrator access without an account selector', () => {
    useApi.mockReturnValue({ data: { ...consent, scope: 'system', projects: [] } });
    const html = renderToStaticMarkup(createElement(McpConsent, { requestId: 'opaque-request' }));
    expect(useApi).toHaveBeenCalledWith('/mcp/oauth/consent?requestId=opaque-request', 0);
    expect(html).toContain('All accounts · System administrator');
    expect(html).toContain('including accounts added later');
    expect(html).not.toContain('<select');
  });

  it('requires an explicit account choice for a generic non-admin connection', () => {
    useApi.mockReturnValue({ data: consent });
    const html = renderToStaticMarkup(createElement(McpConsent, { requestId: 'opaque-request' }));
    expect(html).toContain('Choose an account');
    expect(html).toContain('Account A · Read-only');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Approve connection<\/button>/);
    expect(html).not.toContain('All accounts');
  });

  it('discloses a prebound account without offering another account', () => {
    useApi.mockReturnValue({ data: { ...consent, projectId: 'account-a', projectName: 'Account A', projects: [] } });
    const html = renderToStaticMarkup(createElement(McpConsent, { requestId: 'opaque-request' }));
    expect(html).toContain('<strong>Account A</strong>');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('All accounts');
  });
});
