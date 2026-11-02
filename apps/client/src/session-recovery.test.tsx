// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useApi: vi.fn(),
  logout: vi.fn(),
  reloadExpiredSession: vi.fn(),
  clearSessionRecovery: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock('@descope/react-sdk', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  Descope: ({ onSuccess }: { onSuccess?: () => void }) => <button data-testid="sign-in-flow" onClick={() => onSuccess?.()}>Sign in</button>,
  useDescope: () => ({ logout: mocks.logout }),
  useSession: () => ({ isAuthenticated: true, isSessionLoading: false, claims: { sub: 'user-a' } }),
}));
vi.mock('./auth', () => ({
  authConfigured: true,
  descopeProjectId: 'test-project',
  descopeBaseUrl: 'https://api.descope.com',
  descopeFlowId: 'sign-in',
  reloadExpiredSession: mocks.reloadExpiredSession,
  clearSessionRecovery: mocks.clearSessionRecovery,
  signIn: mocks.signIn,
}));
vi.mock('./api', async () => ({
  ApiError: (await import('./api-error')).ApiError,
  useApi: mocks.useApi,
  query: () => '',
}));
import App from './App';
import { ApiError } from './api-error';

let root: Root, container: HTMLDivElement;
let account: { data?: unknown; error?: Error; loading: boolean };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.reloadExpiredSession.mockReset().mockReturnValue(true);
  mocks.clearSessionRecovery.mockReset();
  mocks.signIn.mockReset();
  account = { error: new ApiError('Your Descope session is invalid or expired. Sign in again.', 401), loading: false };
  mocks.useApi.mockImplementation((path: string | null) => path === '/me'
    ? account : { data: undefined, error: undefined, loading: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<StrictMode><App /></StrictMode>));
}

describe('workspace session recovery', () => {
  it('shows skeletons and automatically reloads an expired session without flashing the error card', async () => {
    await render();
    expect(container.querySelector('.content-skeleton-workspace')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Workspace access unavailable');
    expect(container.textContent).not.toContain('invalid or expired');
    expect(mocks.reloadExpiredSession).toHaveBeenCalledOnce();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('opens sign-in after a failed reload instead of repeating recovery', async () => {
    mocks.reloadExpiredSession.mockReturnValue(false);
    let finish!: () => void;
    mocks.logout.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render();
    expect(container.querySelector('.content-skeleton-workspace')).not.toBeNull();
    expect(mocks.logout).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(container.querySelector('[data-testid="sign-in-flow"]')).not.toBeNull();
    expect(container.textContent).toContain('Sign in to Citevia');
    expect(container.textContent).not.toContain('Workspace access unavailable');
  });

  it('still opens sign-in if clearing the invalid session fails', async () => {
    mocks.reloadExpiredSession.mockReturnValue(false);
    mocks.logout.mockRejectedValue(new Error('Offline'));
    await render();
    expect(container.querySelector('[data-testid="sign-in-flow"]')).not.toBeNull();
    expect(mocks.logout).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="sign-in-flow"]')!.click());
    expect(mocks.clearSessionRecovery).toHaveBeenCalledOnce();
    expect(mocks.signIn).toHaveBeenCalledOnce();
  });

  it.each([403, 500])('retains the retry UI for a %s account error', async (status) => {
    account.error = new ApiError('Account access failed', status);
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Account access failed');
    expect(container.textContent).toContain('Try again');
    expect(mocks.reloadExpiredSession).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('resets the reload guard once account access is restored', async () => {
    account = { data: { id: 'user-a', name: 'Test user' }, loading: false };
    await render();
    expect(mocks.clearSessionRecovery).toHaveBeenCalled();
    expect(mocks.reloadExpiredSession).not.toHaveBeenCalled();
  });
});
