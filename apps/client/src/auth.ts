type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };
const tokenKey = 'citevia.auth';
const pendingKey = 'citevia.pkce';
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
export const localAuth = import.meta.env.VITE_AUTH_MODE === 'local' && loopback;
const domain = String(import.meta.env.VITE_COGNITO_DOMAIN || '').replace(/\/$/, '');
const clientId = String(import.meta.env.VITE_COGNITO_CLIENT_ID || '');
const redirectUri = String(import.meta.env.VITE_REDIRECT_URI || `${window.location.origin}/auth/callback`);
const logoutUri = String(import.meta.env.VITE_LOGOUT_URI || `${window.location.origin}/`);
export const authConfigured = localAuth || Boolean(/^https:\/\//.test(domain) && clientId);

function readTokens(): Tokens | undefined {
  try { return JSON.parse(sessionStorage.getItem(tokenKey) || 'null') || undefined; } catch { return undefined; }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signIn() {
  if (!authConfigured) throw new Error('Sign-in has not been configured. Set the Cognito client configuration.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state, createdAt: Date.now() }));
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256' });
  window.location.assign(`${domain}/oauth2/authorize?${params}`);
}

async function exchange(params: URLSearchParams): Promise<Tokens> {
  const response = await fetch(`${domain}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  if (!response.ok) throw new Error('Your session could not be started. Please sign in again.');
  const body = await response.json();
  if (typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in)) throw new Error('The sign-in service returned an invalid session.');
  const tokens = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
  sessionStorage.setItem(tokenKey, JSON.stringify(tokens));
  return tokens;
}

let callbackPromise: Promise<boolean> | undefined;
export function initializeAuth(): Promise<boolean> {
  if (callbackPromise) return callbackPromise;
  callbackPromise = (async () => {
    if (localAuth) return true;
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const authError = url.searchParams.get('error');
    if (authError) {
      window.history.replaceState({}, '', '/');
      throw new Error('Sign-in was cancelled or rejected. Please try again.');
    }
    if (code) {
      let pending: { verifier: string; state: string; createdAt: number } | null = null;
      try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { /* invalid pending request */ }
      sessionStorage.removeItem(pendingKey);
      window.history.replaceState({}, '', '/');
      if (!pending || pending.state !== url.searchParams.get('state') || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('This sign-in request expired. Please start again.');
      await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: pending.verifier }));
    }
    return Boolean(await getAccessToken());
  })();
  return callbackPromise;
}

let refreshPromise: Promise<string | undefined> | undefined;
export async function getAccessToken(): Promise<string | undefined> {
  if (localAuth) return 'local-development';
  const tokens = readTokens();
  if (!tokens) return undefined;
  if (tokens.expiresAt > Date.now() + 30_000) return tokens.accessToken;
  if (!tokens.refreshToken) { sessionStorage.removeItem(tokenKey); return undefined; }
  if (!refreshPromise) {
    refreshPromise = exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refreshToken }))
      .then(fresh => { sessionStorage.setItem(tokenKey, JSON.stringify({ ...fresh, refreshToken: fresh.refreshToken || tokens.refreshToken })); return fresh.accessToken; })
      .catch(() => { sessionStorage.removeItem(tokenKey); return undefined; })
      .finally(() => { refreshPromise = undefined; });
  }
  return refreshPromise;
}

export function signOut() {
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(pendingKey);
  if (localAuth) { window.location.reload(); return; }
  const params = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri });
  window.location.assign(`${domain}/logout?${params}`);
}
