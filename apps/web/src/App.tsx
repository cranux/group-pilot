import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './auth/useSession';
import { RealtimeProvider } from './realtime/RealtimeProvider';
import { Layout } from './components/Layout';
import { Loading } from './components/Loading';
import { LoginPage } from './pages/LoginPage';
import { AccountsPage } from './pages/AccountsPage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { AgentRunPage } from './pages/AgentRunPage';
import { SequencesPage } from './pages/SequencesPage';
import { NotFoundPage, SequenceRunPage } from './pages/SequenceRunPage';

/** 未登录跳登录页（记住来源）；会话恢复中显示加载。 */
function RequireAuth() {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <Loading text="正在恢复会话…" />;
  if (session.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** 会话结束（过期 / 退出）时清空缓存，避免不同用户之间串数据。 */
function SessionCacheGuard() {
  const session = useSession();
  const qc = useQueryClient();
  useEffect(() => {
    if (session.status === 'anonymous') qc.clear();
  }, [session.status, qc]);
  return null;
}

export function App() {
  const session = useSession();
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SessionCacheGuard />
      <RealtimeProvider>
        <Routes>
          <Route path="/login" element={session.status === 'loading' ? <Loading text="正在恢复会话…" /> : <LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/accounts" replace />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/groups" element={<GroupsPage />} />
              <Route path="/groups/:id" element={<GroupDetailPage />} />
              <Route path="/groups/:id/sequences" element={<SequencesPage />} />
              <Route path="/sequence-runs/:id" element={<SequenceRunPage />} />
              <Route path="/agent-runs/:id" element={<AgentRunPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Routes>
      </RealtimeProvider>
    </BrowserRouter>
  );
}
