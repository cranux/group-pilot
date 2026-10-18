import { ApiError, networkError, parseErrorBody } from './errors';
import type { AuthPayload } from './types';

/**
 * API 客户端（纯模块，fetch 与会话存储均为注入，便于单测）。
 *
 * - 请求带 `Authorization: Bearer <accessToken>`；
 * - 遇到 401（code = UNAUTHORIZED）自动 refresh 一次并重放请求；
 * - refresh 是 single-flight：并发的多个 401 共享同一个 refresh promise；
 *   若某个请求带着旧 token 回来时 refresh 已经完成（当前 token 已变化），直接用新 token 重放，不再 refresh；
 * - refresh 失败（401）→ 清空会话（由上层跳转登录页）。
 *
 * refresh token 每次使用后轮换，旧的再被使用会导致整个会话作废，所以绝不能并发 refresh。
 * 跨标签页的并发通过可选的 `runExclusive`（浏览器里用 Web Locks）串行化。
 */

export interface SessionAccess {
  getAccessToken(): string | null;
  setSession(payload: AuthPayload): void;
  clearSession(reason?: 'expired' | 'logout'): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetch: FetchLike;
  session: SessionAccess;
  baseUrl?: string;
  /** 串行化 refresh（例如跨标签页的 Web Locks）。默认直接执行。 */
  runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** 是否携带 access token 并在 401 时自动续期，默认 true。 */
  auth?: boolean;
  signal?: AbortSignal;
}

export type RefreshResult =
  | { ok: true; payload: AuthPayload }
  | { ok: false; reason: 'unauthorized' | 'error'; error: ApiError };

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  /** 单飞 refresh；成功时已写入会话。 */
  refresh(): Promise<RefreshResult>;
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  let url = baseUrl + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const runExclusive = options.runExclusive ?? (<T>(fn: () => Promise<T>) => fn());
  let inflightRefresh: Promise<RefreshResult> | null = null;

  async function doRefresh(): Promise<RefreshResult> {
    let res: Response;
    try {
      res = await options.fetch(buildUrl(baseUrl, '/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      return { ok: false, reason: 'error', error: networkError(e) };
    }
    const text = await readBody(res);
    if (!res.ok) {
      const error = parseErrorBody(res.status, res.statusText, text);
      return { ok: false, reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'error', error };
    }
    let payload: AuthPayload;
    try {
      payload = JSON.parse(text) as AuthPayload;
    } catch {
      return {
        ok: false,
        reason: 'error',
        error: new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: 'refresh 响应不是合法 JSON' }),
      };
    }
    if (!payload || typeof payload.accessToken !== 'string') {
      return {
        ok: false,
        reason: 'error',
        error: new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: 'refresh 响应缺少 accessToken' }),
      };
    }
    options.session.setSession(payload);
    return { ok: true, payload };
  }

  function refresh(): Promise<RefreshResult> {
    if (!inflightRefresh) {
      inflightRefresh = (async () => {
        try {
          const result = await runExclusive(doRefresh);
          if (!result.ok && result.reason === 'unauthorized') {
            options.session.clearSession('expired');
          }
          return result;
        } catch (e) {
          return { ok: false as const, reason: 'error' as const, error: networkError(e) };
        } finally {
          inflightRefresh = null;
        }
      })();
    }
    return inflightRefresh;
  }

  async function send(path: string, o: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await options.fetch(buildUrl(baseUrl, path, o.query), {
        method: o.method ?? 'GET',
        headers,
        body,
        credentials: 'include',
        signal: o.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') throw e;
      throw networkError(e);
    }
  }

  async function finish<T>(res: Response): Promise<T> {
    const text = await readBody(res);
    if (!res.ok) throw parseErrorBody(res.status, res.statusText, text);
    if (res.status === 204 || !text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: '响应不是合法 JSON' });
    }
  }

  async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
    const auth = o.auth !== false;
    const usedToken = auth ? options.session.getAccessToken() : null;
    const res = await send(path, o, usedToken);
    if (!(auth && res.status === 401)) return finish<T>(res);

    const firstError = parseErrorBody(res.status, res.statusText, await readBody(res));
    if (firstError.code !== 'UNAUTHORIZED' && !firstError.code.startsWith('HTTP_')) throw firstError;

    // 若别的请求已经完成了 refresh（当前 token 已变化），直接用新 token 重放。
    let nextToken: string | null = null;
    const current = options.session.getAccessToken();
    if (current && current !== usedToken) {
      nextToken = current;
    } else {
      const r = await refresh();
      if (!r.ok) throw r.reason === 'unauthorized' ? firstError : r.error;
      nextToken = r.payload.accessToken;
    }

    const retry = await send(path, o, nextToken);
    if (retry.status === 401) {
      // 刚续期的 token 仍被拒绝：会话已在服务端作废。
      options.session.clearSession('expired');
    }
    return finish<T>(retry);
  }

  return {
    request,
    refresh,
    get: (path, query, signal) => request(path, { method: 'GET', query, signal }),
    post: (path, body) => request(path, { method: 'POST', body }),
    patch: (path, body) => request(path, { method: 'PATCH', body }),
  };
}
