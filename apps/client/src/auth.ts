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
const sessionRecoveryKey = 'citevia.session-recovery';

export function clearSessionRecovery() {
  try {
    sessionStorage.removeItem(sessionRecoveryKey);
  } catch {
    /* storage unavailable */
  }
}

export function reloadExpiredSession(): boolean {
  try {
    // Survives the reload so a persistently invalid session cannot loop.
    if (sessionStorage.getItem(sessionRecoveryKey)) return false;
    sessionStorage.setItem(sessionRecoveryKey, 'pending');
  } catch {
    // Without a durable guard, go straight to sign-in.
    return false;
  }
  signIn();
  return true;
}

// The provider refreshes sessions. Reloading returns expired sessions to its sign-in flow.
export function signIn() {
  window.location.reload();
}
