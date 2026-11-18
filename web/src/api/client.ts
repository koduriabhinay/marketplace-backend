/**
 * The one place the website talks to the API.
 *
 * Session model (see docs/PHASE-6.md):
 *  - the short-lived access token lives only in memory (this module), never in
 *    localStorage, so a script injected into the page can't walk away with a long-lived
 *    credential;
 *  - the refresh token lives in an httpOnly cookie that JavaScript can't read at all;
 *  - on a 401 we refresh once (shared by every request that failed at the same moment)
 *    and retry; if that fails, the session is over and the app shows the login page.
 */

const BASE = '/api/v1';
const SESSION_HINT = 'mp.session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from a 400 VALIDATION_ERROR, keyed by field name. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        const key = d.path ?? '';
        if (key && d.message && !out[key]) out[key] = d.message;
      }
    }
    return out;
  }
}

/** The network itself failed (offline, DNS, connection reset): safe to retry. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the server. Check your connection and try again.', { cause });
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;
let onSessionEnded: (() => void) | null = null;

export const session = {
  get token() {
    return accessToken;
  },
  /** Called with a fresh access token after login, 2FA or refresh. */
  start(token: string) {
    accessToken = token;
    safeStorage(() => localStorage.setItem(SESSION_HINT, '1'));
  },
  clear() {
    accessToken = null;
    safeStorage(() => localStorage.removeItem(SESSION_HINT));
  },
  /**
   * A non-secret hint that this browser probably has a session cookie, so a first-time
   * visitor doesn't fire a pointless refresh request on every page load.
   */
  get mightExist() {
    return safeStorage(() => localStorage.getItem(SESSION_HINT) === '1') ?? false;
  },
  onEnded(fn: (() => void) | null) {
    onSessionEnded = fn;
  },
};

function safeStorage<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined; // private mode / storage disabled: the app still works
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Abort (e.g. when a React Query request is no longer needed). */
  signal?: AbortSignal;
}

async function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Ask the API to keep refresh tokens in the httpOnly cookie, never in the body.
    'X-Auth-Transport': 'cookie',
    ...(opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...opts.headers,
  };
  try {
    return await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
}

async function toResult<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return json as T;
  const e = (json as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } })?.error;
  throw new ApiError(
    res.status,
    e?.code ?? `HTTP_${res.status}`,
    e?.message ?? (res.status === 429 ? 'Too many requests. Please wait a moment.' : `Request failed (${res.status})`),
    e?.details,
    e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
  );
}

let refreshing: Promise<string | null> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers share one
 * request, and tabs take turns through a Web Lock: refresh tokens rotate on every use, and
 * two tabs presenting the same one at once would look like token theft to the server.
 */
export function refreshSession(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const run = async () => {
        const res = await send('/auth/refresh', { method: 'POST' }, null);
        if (!res.ok) return null;
        const body = (await res.json()) as { data: { accessToken: string } };
        return body.data.accessToken;
      };
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      const token = locks ? await locks.request('mp-refresh', run) : await run();
      if (token) session.start(token);
      else session.clear();
      return token;
    } catch {
      return null; // offline: keep the hint, try again later
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Calls the API; on an expired access token, refreshes once and retries. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = accessToken;
  const res = await send(path, opts, token);
  if (res.status === 401 && token) {
    const fresh = await refreshSession();
    if (fresh) return toResult<T>(await send(path, opts, fresh));
    onSessionEnded?.();
  }
  return toResult<T>(res);
}

/** Unwraps `{ data }` responses. */
export async function apiData<T>(path: string, opts?: RequestOptions): Promise<T> {
  return (await api<{ data: T }>(path, opts)).data;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return 'Something went wrong. Please try again.';
}
