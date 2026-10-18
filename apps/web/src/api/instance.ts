import { createApiClient } from './client';
import { createSessionStore } from '../auth/sessionStore';

/** 浏览器里的单例：会话存储 + API 客户端。 */
export const sessionStore = createSessionStore();

type LockManagerLike = {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
};

function getLocks(): LockManagerLike | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }) : null;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

export const apiClient = createApiClient({
  fetch: (input, init) => fetch(input, init),
  session: sessionStore,
  // refresh token 会轮换，多个标签页同时 refresh 会触发「旧 token 复用 → 会话作废」，用 Web Locks 串行化。
  runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
    const locks = getLocks();
    return locks ? locks.request('gp-auth-refresh', fn) : fn();
  },
});
