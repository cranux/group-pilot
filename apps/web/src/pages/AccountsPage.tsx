import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import { hasCode } from '../api/errors';
import type { Account, AccountStatus } from '../api/types';
import { useAuth } from '../auth/useSession';
import { PageHeader } from '../components/Layout';
import { ErrorBox, InlineError } from '../components/ErrorBox';
import { Loading, Empty } from '../components/Loading';
import { Mono, StatusBadge } from '../components/Badge';
import { Countdown } from '../components/Time';
import { ACCOUNT_STATUS } from '../lib/labels';
import { availableAccountActions, type AccountAction } from '../lib/transitions';
import { notifications } from '../notifications/store';

type ActionVars = { account: Account; action: AccountAction };

function AccountRow({ account, isAdmin }: { account: Account; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const mutation = useMutation({
    mutationFn: async ({ account: a, action }: ActionVars): Promise<Partial<Account> & { status: AccountStatus }> => {
      if (action.kind === 'reconnect') {
        const r = await api.connectAccount(a.id);
        return { status: r.status, platformUserId: r.platformUserId };
      }
      // expectedFrom = 当前显示的状态
      const r = await api.transitionAccount(a.id, action.to, a.status);
      return { status: r.status };
    },
    onMutate: () => setError(null),
    onSuccess: (res, { account: a }) => {
      qc.setQueryData<Account[]>(qk.accounts(), (list) =>
        list?.map((x) => (x.id === a.id ? { ...x, ...res } : x)),
      );
      void qc.invalidateQueries({ queryKey: qk.accounts() });
    },
    onError: (err, { account: a }) => {
      setError(err);
      if (hasCode(err, 'CAS_CONFLICT') || hasCode(err, 'ILLEGAL_TRANSITION') || hasCode(err, 'ACCOUNT_NOT_FOUND')) {
        notifications.push({
          level: 'warning',
          title: hasCode(err, 'CAS_CONFLICT') ? '账号状态已变化' : '操作未生效',
          message: `账号 ${a.id} 的状态已被其他操作修改（操作基于「${ACCOUNT_STATUS[a.status]?.label ?? a.status}」），已刷新列表，请确认后重试。`,
        });
        void qc.invalidateQueries({ queryKey: qk.accounts() });
      }
    },
  });

  const actions = availableAccountActions(account.status);

  return (
    <tr>
      <td>
        <Mono>{account.id}</Mono>
      </td>
      <td>
        <StatusBadge table={ACCOUNT_STATUS} value={account.status} showRaw />
      </td>
      <td>
        <Mono>{account.platformUserId ?? '—'}</Mono>
      </td>
      <td>
        {account.rateLimitedUntil ? (
          <Countdown until={account.rateLimitedUntil} prefix="剩余 " expiredText="已到期，等待恢复" />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      {isAdmin ? (
        <td className="cell-actions">
          {actions.length === 0 ? <span className="muted small">无可用操作</span> : null}
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className={`btn btn-sm ${action.kind === 'reconnect' ? 'btn-primary' : action.kind === 'markOffline' ? 'btn-warning' : ''}`}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ account, action })}
            >
              {mutation.isPending && mutation.variables?.action.kind === action.kind ? '处理中…' : action.label}
            </button>
          ))}
          {error ? (
            <div>
              <InlineError error={error} />
            </div>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

export function AccountsPage() {
  const { isAdmin } = useAuth();
  const q = useQuery({
    queryKey: qk.accounts(),
    queryFn: api.listAccounts,
    // 限流截止时间的刷新不算状态转移，不一定有 WS 事件，低频轮询兜底
    refetchInterval: 10_000,
  });

  const counts = (q.data ?? []).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PageHeader
        title="账号"
        sub={
          q.data ? (
            <span className="summary-chips">
              共 {q.data.length} 个
              {Object.entries(counts).map(([s, n]) => (
                <span key={s}>
                  <StatusBadge table={ACCOUNT_STATUS} value={s} /> {n}
                </span>
              ))}
            </span>
          ) : null
        }
      >
        <button type="button" className="btn btn-sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? '刷新中…' : '刷新'}
        </button>
      </PageHeader>
      {q.error ? <ErrorBox error={q.error} title="加载账号失败" /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.length === 0 ? <Empty>没有账号</Empty> : null}
      {q.data && q.data.length > 0 ? (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>账号 ID</th>
                <th>状态</th>
                <th>platformUserId</th>
                <th>限流截止</th>
                {isAdmin ? <th>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <AccountRow key={a.id} account={a} isAdmin={isAdmin} />
              ))}
            </tbody>
          </table>
          {isAdmin ? (
            <div className="card-foot muted small">
              「标记离线」= 转为 disconnected；「重连」= 调网关 connect（空闲 / 离线时）；「释放账号」= 转为 idle。按钮仅在转移表允许时出现，终态账号没有操作。
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
