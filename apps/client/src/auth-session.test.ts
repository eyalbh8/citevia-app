import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSessionRecovery, reloadExpiredSession } from './auth';

const reload = vi.fn();
let values: Map<string, string>;
beforeEach(() => {
  reload.mockReset();
  values = new Map();
  vi.stubGlobal('window', { location: { reload } });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('expired session reload', () => {
  it('reloads the current page once and retains the guard across reloads', () => {
    expect(reloadExpiredSession()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(reloadExpiredSession()).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('allows recovery again after account access has succeeded', () => {
    reloadExpiredSession();
    clearSessionRecovery();
    expect(reloadExpiredSession()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it.each(['getItem', 'setItem'])('skips the reload if %s cannot persist the loop guard', (method) => {
    vi.spyOn(sessionStorage, method).mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    expect(reloadExpiredSession()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tolerates unavailable storage when clearing a recovered session', () => {
    vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    expect(() => clearSessionRecovery()).not.toThrow();
  });
});
