import { getSessionToken } from '@descope/react-sdk';
export const descopeProjectId = String(
  import.meta.env.VITE_DESCOPE_PROJECT_ID || '',
).trim();
export const descopeBaseUrl = String(
  import.meta.env.VITE_DESCOPE_BASE_URL || 'https://api.descope.com',
).replace(/\/$/, '');
export const descopeFlowId = String(
  import.meta.env.VITE_DESCOPE_FLOW_ID || 'sign-in',
);
export const authConfigured = Boolean(
  descopeProjectId && /^https:\/\//.test(descopeBaseUrl),
);
export async function getAccessToken(): Promise<string | undefined> {
  return getSessionToken() || undefined;
}
// The provider refreshes sessions. Reloading returns expired sessions to its sign-in flow.
export function signIn() {
  window.location.reload();
}
