import { describe, expect, it } from 'vitest';
import { mcpClientConfig } from './mcp-config';

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
});
