import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createRealtimeClient, type WebSocketLike, type WsStatus } from './wsClient';
import { applyRealtimeEvent } from './applyEvent';
import { sessionStore } from '../api/instance';
import { api } from '../api/endpoints';
import { notifications } from '../notifications/store';
import { useSession } from '../auth/useSession';

const RealtimeContext = createContext<WsStatus>('stopped');

export function useRealtimeStatus(): WsStatus {
  return useContext(RealtimeContext);
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

/** 登录后建立 WS 连接；事件写入 React Query 缓存，重连后失效当前页面查询兜底。 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSession();
  const authenticated = session.status === 'authenticated';
  const [status, setStatus] = useState<WsStatus>('stopped');

  useEffect(() => {
    if (!authenticated) return;
    const client = createRealtimeClient({
      url: wsUrl,
      // 浏览器 WebSocket 在结构上满足 WebSocketLike（事件参数更具体），边界处做一次断言
      createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      getAccessToken: () => sessionStore.getAccessToken(),
      refreshToken: async () => (await api.refresh()).ok,
      onEvent: (ev) => applyRealtimeEvent(qc, ev, notifications),
      onStatusChange: setStatus,
      onResync: () => {
        // 断线期间的事件由服务端按 sinceSeq 补发；同时让当前页面（active）查询重拉作为兜底。
        void qc.invalidateQueries();
      },
    });
    client.start();
    const onOnline = () => client.reconnectNow();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      client.stop();
      setStatus('stopped');
    };
  }, [authenticated, qc]);

  return <RealtimeContext.Provider value={status}>{children}</RealtimeContext.Provider>;
}
