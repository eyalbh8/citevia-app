/** API-key URLs support clients that accept only a server URL. Treat the result as a secret. */
export function mcpConnectionUrl(serverUrl: string, token: string, projectId?: string | null) {
  const url = new URL(serverUrl);
  url.searchParams.set('mcp_token', token);
  if (projectId) url.searchParams.set('workspace_id', projectId);
  else url.searchParams.delete('workspace_id');
  return url.toString();
}

export function claudeConnectorUrl(connectionUrl: string) {
  const url = new URL('https://claude.ai/customize/connectors');
  url.searchParams.set('modal', 'add-custom-connector');
  url.searchParams.set('connectorName', 'Citevia');
  url.searchParams.set('connectorUrl', connectionUrl);
  return url.toString();
}

/** Header authentication remains available for clients with configurable HTTP headers. */
export function mcpClientConfig(serverUrl: string, token?: string) {
  return JSON.stringify({
    mcpServers: {
      citevia: {
        url: serverUrl,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  }, null, 2);
}
