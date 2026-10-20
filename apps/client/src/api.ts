import { useEffect, useState } from 'react';
import { getAccessToken } from './auth';

const baseUrl = String(import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

// Keep the same key after a lost response or server failure. A retry can repair
// an accepted reservation without accidentally scheduling a second scan.
const pendingKeys = new Map<string, string>();
const inFlightMutations = new Map<string, Promise<unknown>>();
export function idempotentPost<T>(path: string, body?:unknown): Promise<T> {
  const payload=body===undefined?undefined:JSON.stringify(body);
  let fingerprint=2166136261;for(const char of payload||'')fingerprint=Math.imul(fingerprint^char.charCodeAt(0),16777619);
  const scope=payload===undefined?path:`${path}:${(fingerprint>>>0).toString(16)}`;
  const active = inFlightMutations.get(scope);
  if (active) return active as Promise<T>;
  const storageKey = `citevia.request:${scope}`;
  let key = pendingKeys.get(scope);
  try { key ||= sessionStorage.getItem(storageKey) || undefined; } catch { /* use in-memory fallback */ }
  key ||= crypto.randomUUID();
  pendingKeys.set(scope, key);
  try { sessionStorage.setItem(storageKey, key); } catch { /* use in-memory fallback */ }
  const clearKey = () => { pendingKeys.delete(scope); try { sessionStorage.removeItem(storageKey); } catch { /* storage unavailable */ } };
  const operation = request<T>(path, { method: 'POST', headers: { 'Idempotency-Key': key },body:payload, signal: AbortSignal.timeout(60_000) })
    .then(result => { clearKey(); return result; })
    .catch(error => { if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) clearKey(); throw error; })
    .finally(() => inFlightMutations.delete(scope));
  inFlightMutations.set(scope, operation);
  return operation;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError('Your session has expired. Sign in again to continue.', 401);
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = response.status === 401 ? 'Your session has expired. Sign in again to continue.' : `The request could not be completed (${response.status}).`;
    try { const body = await response.json(); if (typeof body.error === 'string') message = body.error; else if (typeof body.error?.message === 'string') message = body.error.message; else if (typeof body.message === 'string') message = body.message; } catch { /* non-JSON gateway failure */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function useApi<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error; loading: boolean }>({ key: path, loading: Boolean(path) });
  useEffect(() => {
    if (!path) { setState({ key: null, loading: false }); return; }
    const controller = new AbortController();
    setState(previous => ({ key: path, data: previous.key === path ? previous.data : undefined, loading: true }));
    request<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ key: path, data, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState(previous => ({ key: path, data: error instanceof ApiError&&[401,403,404].includes(error.status)?undefined:previous.key === path ? previous.data : undefined, error, loading: false }));
    });
    return () => controller.abort();
  }, [path, revision]);
  if (state.key !== path) return { data: undefined, error: undefined, loading: Boolean(path) };
  return state;
}

export function query(values: Record<string, string | number | boolean | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (value: string | number | null | undefined) => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
