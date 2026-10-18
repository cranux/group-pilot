import { describe, expect, it, vi } from 'vitest';
import { createApiClient, buildUrl, type FetchLike } from './client';
import { ApiError } from './errors';
import { createSessionStore } from '../auth/sessionStore';

const user = { username: 'admin', role: 'admin' as const };

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(): Response {
  return json(401, { error: { code: 'UNAUTHORIZED', message: 'token expired', requestId: 'r1' } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function authHeader(init?: RequestInit): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return h.Authorization;
}

describe('createApiClient', () => {
  it('3 个并发请求同时 401 时只 refresh 一次，并全部用新 token 重放成功', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 't1', user });

    const refreshGate = deferred<void>();
    const calls: Array<{ url: string; auth?: string }> = [];
    let refreshCalls = 0;

    const fetchMock: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        await refreshGate.promise;
        return json(200, { accessToken: 't2', user });
      }
      calls.push({ url, auth: authHeader(init) });
      if (authHeader(init) === 'Bearer t2') return json(200, { url });
      return unauthorized();
    });

    const client = createApiClient({ fetch: fetchMock, session });
    const p = Promise.all([
      client.get<{ url: string }>('/api/accounts'),
      client.get<{ url: string }>('/api/groups'),
      client.get<{ url: string }>('/api/sequences'),
    ]);

    // 让 3 个请求都拿到 401 并进入等待 refresh 的状态
    await new Promise((r) => setTimeout(r, 10));
    expect(refreshCalls).toBe(1);
    refreshGate.resolve();

    const results = await p;
    expect(results.map((r) => r.url)).toEqual(['/api/accounts', '/api/groups', '/api/sequences']);
    expect(refreshCalls).toBe(1);
    // 每个请求恰好发了两次：一次旧 token，一次新 token
    for (const path of ['/api/accounts', '/api/groups', '/api/sequences']) {
      const own = calls.filter((c) => c.url === path).map((c) => c.auth);
      expect(own).toEqual(['Bearer t1', 'Bearer t2']);
    }
    expect(session.getAccessToken()).toBe('t2');
  });

  it('refresh 完成后才回来的旧 token 401 请求直接用新 token 重放，不再 refresh', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 't1', user });

    const slow401 = deferred<void>();
    let refreshCalls = 0;

    const fetchMock: FetchLike = async (url, init) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        return json(200, { accessToken: 't2', user });
      }
      if (authHeader(init) === 'Bearer t2') return json(200, { ok: url });
      if (url === '/api/slow') {
        await slow401.promise;
      }
      return unauthorized();
    };

    const client = createApiClient({ fetch: fetchMock, session });
    const slow = client.get('/api/slow');
    const fast = await client.get('/api/fast');
    expect(fast).toEqual({ ok: '/api/fast' });
    expect(refreshCalls).toBe(1);

    slow401.resolve();
    await expect(slow).resolves.toEqual({ ok: '/api/slow' });
    expect(refreshCalls).toBe(1);
  });

  it('refresh 失败时清空会话，所有并发请求都以 UNAUTHORIZED 失败，refresh 仍只调用一次', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 't1', user });
    const clear = vi.spyOn(session, 'clearSession');
    let refreshCalls = 0;

    const fetchMock: FetchLike = async (url) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return json(401, { error: { code: 'UNAUTHORIZED', message: 'refresh revoked', requestId: 'r2' } });
      }
      return unauthorized();
    };

    const client = createApiClient({ fetch: fetchMock, session });
    const results = await Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(refreshCalls).toBe(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(session.getState()).toEqual({ status: 'anonymous', reason: 'expired' });
    for (const r of results) {
      expect(r.status).toBe('rejected');
      const err = (r as PromiseRejectedResult).reason as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('UNAUTHORIZED');
    }
  });

  it('refresh 网络失败不清空会话，返回 NETWORK_ERROR', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 't1', user });
    const fetchMock: FetchLike = async (url) => {
      if (url === '/api/auth/refresh') throw new TypeError('Failed to fetch');
      return unauthorized();
    };
    const client = createApiClient({ fetch: fetchMock, session });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(session.getAccessToken()).toBe('t1');
  });

  it('非 UNAUTHORIZED 的错误不触发 refresh，并保留业务字段', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 't1', user });
    const fetchMock = vi.fn<FetchLike>(async () =>
      json(422, {
        error: { code: 'UNRESOLVED_PLACEHOLDER', message: 'missing', requestId: 'q', stepIndex: 3, key: 'location' },
      }),
    );
    const client = createApiClient({ fetch: fetchMock, session });
    const err = (await client.post('/api/groups/g1/sequence-runs', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'UNRESOLVED_PLACEHOLDER', requestId: 'q' });
    expect(err.details).toEqual({ stepIndex: 3, key: 'location' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('204 返回 undefined；POST 带 JSON body 与 Authorization 头', async () => {
    const session = createSessionStore();
    session.setSession({ accessToken: 'tok', user });
    const fetchMock = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const client = createApiClient({ fetch: fetchMock, session });
    await expect(client.post('/api/auth/logout', { a: 1 })).resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe('include');
    expect(authHeader(init)).toBe('Bearer tok');
  });

  it('非 JSON 错误体也能得到 code 与 message', async () => {
    const session = createSessionStore();
    const fetchMock: FetchLike = async () => new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
    const client = createApiClient({ fetch: fetchMock, session });
    await expect(client.request('/api/x', { auth: false })).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_502',
      message: 'Bad Gateway',
    });
  });

  it('refresh 通过 runExclusive 串行执行（跨标签页锁）', async () => {
    const session = createSessionStore();
    let exclusiveCalls = 0;
    const runExclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
      exclusiveCalls += 1;
      return fn();
    };
    const fetchMock: FetchLike = async () => json(200, { accessToken: 'n', user });
    const client = createApiClient({ fetch: fetchMock, session, runExclusive });
    const r = await client.refresh();
    expect(r.ok).toBe(true);
    expect(exclusiveCalls).toBe(1);
    expect(session.getAccessToken()).toBe('n');
  });

  it('buildUrl 忽略空查询参数', () => {
    expect(buildUrl('', '/api/groups/g/messages', { before: undefined, limit: 50 })).toBe(
      '/api/groups/g/messages?limit=50',
    );
    expect(buildUrl('', '/m', { before: 'c 1', limit: 50 })).toBe('/m?before=c+1&limit=50');
  });
});
