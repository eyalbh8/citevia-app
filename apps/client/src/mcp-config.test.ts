import { describe, expect, it } from 'vitest';
import { claudeConnectorUrl, mcpClientConfig, mcpConnectionUrl } from './mcp-config';

describe('MCP client credential configuration', () => {
  it('keeps an account credential in the Authorization header and out of the URL', () => {
    const serverUrl = 'https://app.citevia.io/api/v1/mcp/accounts/account-123';
    const token = 'cv_mcp_private_credential';
    const config = JSON.parse(mcpClientConfig(serverUrl, token));
    expect(config.mcpServers.citevia.url).toBe(serverUrl);
    expect(config.mcpServers.citevia.headers.Authorization).toBe(`Bearer ${token}`);
    expect(config.mcpServers.citevia.url).not.toContain(token);
  });

  it('leaves authentication to OAuth without inventing a key or restricting the global endpoint', () => {
    const config = JSON.parse(mcpClientConfig('https://app.citevia.io/api/v1/mcp'));
    expect(config.mcpServers.citevia).toEqual({ url: 'https://app.citevia.io/api/v1/mcp' });
  });

  it('encodes a URL-only credential and binds it to the account without changing its endpoint', () => {
    const serverUrl = 'https://app.citevia.io/mcp/accounts/account-123';
    const token = 'qa-only+token/with?reserved&characters=#';
    const url = new URL(mcpConnectionUrl(serverUrl, token, 'account-123'));
    expect(url.origin + url.pathname).toBe(serverUrl);
    expect(url.searchParams.get('mcp_token')).toBe(token);
    expect(url.searchParams.get('workspace_id')).toBe('account-123');
    expect([...url.searchParams.keys()]).toEqual(['mcp_token', 'workspace_id']);
    expect(url.hash).toBe('');
  });

  it('keeps a system administrator URL global and replaces stale authentication parameters', () => {
    const url = new URL(mcpConnectionUrl('https://app.citevia.io/mcp?workspace_id=old-account&mcp_token=old-key', 'qa-global-token', null));
    expect(url.pathname).toBe('/mcp');
    expect(url.searchParams.get('mcp_token')).toBe('qa-global-token');
    expect(url.searchParams.has('workspace_id')).toBe(false);
    expect(url.searchParams.getAll('mcp_token')).toHaveLength(1);
  });

  it('passes the full URL-only connection to the same Claude connector form as iGEO', () => {
    const connectionUrl = mcpConnectionUrl('https://app.citevia.io/mcp/accounts/account-123', 'qa+token&test', 'account-123');
    const destination = new URL(claudeConnectorUrl(connectionUrl));
    expect(destination.origin + destination.pathname).toBe('https://claude.ai/customize/connectors');
    expect(destination.searchParams.get('modal')).toBe('add-custom-connector');
    expect(destination.searchParams.get('connectorName')).toBe('Citevia');
    expect(destination.searchParams.get('connectorUrl')).toBe(connectionUrl);
  });
});
