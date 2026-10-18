import type { AuthPayload, AuthUser } from '../api/types';

// access token 只保存在内存里；refresh token 在 HttpOnly cookie 中，前端不可见。

export type EndReason = 'expired' | 'logout';

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; reason: EndReason | null }
  | { status: 'authenticated'; accessToken: string; user: AuthUser };

export interface SessionStore {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  getAccessToken(): string | null;
  setSession(payload: AuthPayload): void;
  /** 会话失效（refresh 失败）或主动退出。 */
  clearSession(reason?: EndReason): void;
}

export function createSessionStore(initial: SessionState = { status: 'loading' }): SessionStore {
  let state: SessionState = initial;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAccessToken: () => (state.status === 'authenticated' ? state.accessToken : null),
    setSession(payload) {
      state = { status: 'authenticated', accessToken: payload.accessToken, user: payload.user };
      emit();
    },
    clearSession(reason = 'expired') {
      if (state.status === 'anonymous' && state.reason === reason) return;
      // 加载阶段恢复失败不算「过期」，不提示。
      const effective: EndReason | null = state.status === 'loading' && reason === 'expired' ? null : reason;
      state = { status: 'anonymous', reason: effective };
      emit();
    },
  };
}
