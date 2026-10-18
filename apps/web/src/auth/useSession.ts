import { useSyncExternalStore } from 'react';
import { sessionStore } from '../api/instance';
import type { SessionState } from './sessionStore';
import type { AuthUser } from '../api/types';

export function useSession(): SessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getState, sessionStore.getState);
}

/** 当前用户与是否有写权限（admin）。viewer 看不到任何写操作按钮/表单。 */
export function useAuth(): { user: AuthUser | null; isAdmin: boolean } {
  const s = useSession();
  const user = s.status === 'authenticated' ? s.user : null;
  return { user, isAdmin: user?.role === 'admin' };
}
