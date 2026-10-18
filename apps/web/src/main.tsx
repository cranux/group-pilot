import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { isApiError } from './api/errors';
import { api } from './api/endpoints';
import { sessionStore } from './api/instance';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx 不重试（权限、参数、不存在）；网络错误 / 5xx 最多重试 2 次
      retry: (count, err) => {
        if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
      staleTime: 2000,
    },
    mutations: { retry: false },
  },
});

// 页面加载时先调一次 refresh 恢复会话（access token 只在内存里），失败则去登录页。
void api.refresh().then((r) => {
  if (!r.ok && sessionStore.getState().status === 'loading') sessionStore.clearSession('expired');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
