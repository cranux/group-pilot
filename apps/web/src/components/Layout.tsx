import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/useSession';
import { useRealtimeStatus } from '../realtime/RealtimeProvider';
import { useNotifications } from '../notifications/useNotifications';
import { notifications } from '../notifications/store';
import { api } from '../api/endpoints';
import { sessionStore } from '../api/instance';
import { formatDateTime } from '../lib/format';
import type { WsStatus } from '../realtime/wsClient';

const WS_LABEL: Record<WsStatus, { label: string; cls: string }> = {
  connected: { label: '实时已连接', cls: 'dot-green' },
  connecting: { label: '实时连接中…', cls: 'dot-yellow' },
  reconnecting: { label: '实时重连中…', cls: 'dot-yellow' },
  stopped: { label: '实时未连接', cls: 'dot-gray' },
};

function WsIndicator() {
  const status = useRealtimeStatus();
  const def = WS_LABEL[status];
  return (
    <span className="ws-indicator" title={`WebSocket：${status}`}>
      <span className={`dot ${def.cls}`} />
      {def.label}
    </span>
  );
}

function InconsistencyMenu() {
  const { inconsistencies, unreadInconsistencies } = useNotifications();
  const [open, setOpen] = useState(false);
  return (
    <div className="incon-menu">
      <button
        type="button"
        className={`btn btn-sm ${unreadInconsistencies > 0 ? 'btn-danger' : 'btn-ghost'}`}
        onClick={() => {
          setOpen((o) => !o);
          notifications.markInconsistenciesRead();
        }}
        title="最近的数据不一致事件"
      >
        不一致 {inconsistencies.length > 0 ? `(${inconsistencies.length})` : ''}
        {unreadInconsistencies > 0 ? <span className="incon-unread">{unreadInconsistencies} 新</span> : null}
      </button>
      {open ? (
        <div className="incon-panel">
          <div className="incon-panel-head">
            <strong>最近的不一致事件</strong>
            <span className="spacer" />
            {inconsistencies.length > 0 ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => notifications.clearInconsistencies()}>
                清空
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          {inconsistencies.length === 0 ? (
            <div className="muted small">暂无</div>
          ) : (
            <ul className="incon-list">
              {inconsistencies.map((r) => (
                <li key={r.id}>
                  <div>
                    <code className="err-code">{r.kind}</code> <span className="mono small">{r.ref}</span>
                    <span className="muted small"> · {formatDateTime(new Date(r.at).toISOString())}</span>
                  </div>
                  <div className="small">{r.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Toasts() {
  const { notices } = useNotifications();
  if (notices.length === 0) return null;
  return (
    <div className="toasts">
      {notices.map((n) => (
        <div key={n.id} className={`toast toast-${n.level}${n.sticky ? ' toast-sticky' : ''}`} role="status">
          <div className="toast-body">
            <div className="toast-title">{n.title}</div>
            {n.message ? <div className="toast-msg">{n.message}</div> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => notifications.dismiss(n.id)} aria-label="关闭通知">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function Layout() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // 退出失败也清空本地会话
    } finally {
      sessionStore.clearSession('logout');
      qc.clear();
      setLoggingOut(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">GroupPilot 控制台</div>
        <nav className="nav">
          <NavLink to="/accounts">账号</NavLink>
          <NavLink to="/groups">群</NavLink>
        </nav>
        <span className="spacer" />
        <WsIndicator />
        <InconsistencyMenu />
        {user ? (
          <span className="user-chip">
            <span className="mono">{user.username}</span>
            <span className={`badge ${isAdmin ? 'badge-blue' : 'badge-gray'}`}>{isAdmin ? '管理员' : '只读'}</span>
          </span>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={logout} disabled={loggingOut}>
          {loggingOut ? '退出中…' : '退出登录'}
        </button>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}

export function PageHeader({ title, children, sub }: { title: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
