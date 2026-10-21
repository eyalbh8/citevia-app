/** Credentials belong in an Authorization header, never in a connector URL. */
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
