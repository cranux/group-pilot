import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { Account, Group } from '../api/types';
import { useAuth } from '../auth/useSession';
import { PageHeader } from '../components/Layout';
import { ErrorBox, InlineError } from '../components/ErrorBox';
import { Empty, Loading } from '../components/Loading';
import { Badge, Mono, StatusBadge } from '../components/Badge';
import { Switch } from '../components/Switch';
import { DateTime } from '../components/Time';
import { JobProgress } from '../components/JobProgress';
import { ACCOUNT_STATUS, GROUP_STATUS } from '../lib/labels';
import { moveItem, removeItem, toggleOrdered, validateCreateGroup } from '../lib/orderedSelection';

function AgentToggle({ group, isAdmin }: { group: Group; isAdmin: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (next: boolean) => api.patchGroup(group.id, { agentEnabled: next }),
    onSuccess: (g) => {
      if (g && typeof g === 'object' && 'id' in g) qc.setQueryData(qk.group(group.id), g);
      void qc.invalidateQueries({ queryKey: qk.groupsList() });
    },
  });
  if (!isAdmin) {
    return <Badge tone={group.agentEnabled ? 'green' : 'gray'}>{group.agentEnabled ? '开启' : '关闭'}</Badge>;
  }
  return (
    <span>
      <Switch
        checked={m.isPending && m.variables !== undefined ? m.variables : group.agentEnabled}
        disabled={m.isPending}
        onChange={(v) => m.mutate(v)}
        label={group.agentEnabled ? '开启' : '关闭'}
      />
      {m.error ? <InlineError error={m.error} /> : null}
    </span>
  );
}

function CreateGroupForm({ accounts }: { accounts: Account[] }) {
  const qc = useQueryClient();
  const [creator, setCreator] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const online = useMemo(() => accounts.filter((a) => a.status === 'online'), [accounts]);
  const onlineIds = useMemo(() => new Set(online.map((a) => a.id)), [online]);
  const statusOf = (id: string) => accounts.find((a) => a.id === id)?.status;
  const candidates = online.filter((a) => a.id !== creator);
  const errors = validateCreateGroup(creator, members, onlineIds);

  const m = useMutation({
    mutationFn: () => api.createGroup({ creatorAccountId: creator, memberAccountIds: members }),
    onSuccess: ({ jobId }) => {
      setJobIds((ids) => [jobId, ...ids]);
      setCreator('');
      setMembers([]);
      setTouched(false);
      void qc.invalidateQueries({ queryKey: qk.groupsList() });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.length) return;
    m.mutate();
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>建群</h2>
      </div>
      <form className="card-body form-grid" onSubmit={submit}>
        <label className="field">
          <span>群主（仅在线账号）</span>
          <select
            className="input"
            value={creator}
            onChange={(e) => {
              setCreator(e.target.value);
              setMembers((ms) => removeItem(ms, e.target.value));
            }}
          >
            <option value="">请选择…</option>
            {online.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
                {a.platformUserId ? ` (${a.platformUserId})` : ''}
              </option>
            ))}
          </select>
          {online.length === 0 ? <span className="muted small">当前没有在线账号，请先在账号页「重连」。</span> : null}
        </label>

        <div className="field">
          <span>成员（按点选顺序；第 1 个将被提升为管理员，其余为普通成员；不能包含群主）</span>
          <div className="chip-picker">
            {candidates.length === 0 ? <span className="muted small">没有可选的在线账号</span> : null}
            {candidates.map((a) => {
              const pos = members.indexOf(a.id);
              return (
                <label key={a.id} className={`chip${pos >= 0 ? ' chip-on' : ''}`}>
                  <input type="checkbox" checked={pos >= 0} onChange={() => setMembers((ms) => toggleOrdered(ms, a.id))} />
                  {pos >= 0 ? <span className="chip-order">{pos + 1}</span> : null}
                  <span className="mono">{a.id}</span>
                </label>
              );
            })}
          </div>
          {members.length > 0 ? (
            <ol className="ordered-list">
              {members.map((id, i) => {
                const st = statusOf(id);
                return (
                  <li key={id}>
                    <span className="ordered-index">{i + 1}</span>
                    <Mono>{id}</Mono>
                    {i === 0 ? <Badge tone="blue">将成为管理员</Badge> : <Badge>成员</Badge>}
                    {st !== 'online' ? <StatusBadge table={ACCOUNT_STATUS} value={st ?? 'unknown'} /> : null}
                    <span className="spacer" />
                    <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => setMembers((ms) => moveItem(ms, id, -1))}>
                      上移
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={i === members.length - 1}
                      onClick={() => setMembers((ms) => moveItem(ms, id, 1))}
                    >
                      下移
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMembers((ms) => removeItem(ms, id))}>
                      移除
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>

        {touched && errors.length > 0 ? (
          <div className="alert alert-warning">
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        ) : null}
        <ErrorBox error={m.error} title="建群请求失败" />
        <div>
          <button type="submit" className="btn btn-primary" disabled={m.isPending}>
            {m.isPending ? '提交中…' : '创建群'}
          </button>
          <span className="muted small"> 异步执行：建群 → 申请邀请链接 → 成员入群 → 提升管理员</span>
        </div>
      </form>
      {jobIds.length > 0 ? (
        <div className="card-body jobs">
          {jobIds.map((id) => (
            <JobProgress
              key={id}
              jobId={id}
              onFinished={() => void qc.invalidateQueries({ queryKey: qk.groupsList() })}
              onDismiss={() => setJobIds((ids) => ids.filter((x) => x !== id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GroupsPage() {
  const { isAdmin } = useAuth();
  const groups = useQuery({ queryKey: qk.groupsList(), queryFn: api.listGroups });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.listAccounts, enabled: isAdmin });

  return (
    <div>
      <PageHeader title="群" sub={groups.data ? `共 ${groups.data.length} 个群` : null}>
        <button type="button" className="btn btn-sm" onClick={() => groups.refetch()} disabled={groups.isFetching}>
          {groups.isFetching ? '刷新中…' : '刷新'}
        </button>
      </PageHeader>

      {isAdmin ? (
        accounts.error ? (
          <ErrorBox error={accounts.error} title="加载账号失败，无法建群" />
        ) : accounts.data ? (
          <CreateGroupForm accounts={accounts.data} />
        ) : (
          <Loading text="加载账号…" />
        )
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>群列表</h2>
        </div>
        {groups.error ? <ErrorBox error={groups.error} title="加载群列表失败" /> : null}
        {groups.isLoading ? <Loading /> : null}
        {groups.data && groups.data.length === 0 ? <Empty>还没有群</Empty> : null}
        {groups.data && groups.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>群 ID</th>
                <th>网关群 ID</th>
                <th>状态</th>
                <th>群主</th>
                <th>成员数</th>
                <th>Agent</th>
                <th>运行中</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.id} className={g.status !== 'active' ? `row-${g.status}` : undefined}>
                  <td>
                    <Link to={`/groups/${encodeURIComponent(g.id)}`} className="mono">
                      {g.id}
                    </Link>
                  </td>
                  <td>
                    <Mono>{g.gatewayGroupId ?? '—'}</Mono>
                  </td>
                  <td>
                    <StatusBadge table={GROUP_STATUS} value={g.status} strong={g.status !== 'active'} />
                  </td>
                  <td>
                    <Mono>{g.creatorAccountId}</Mono>
                  </td>
                  <td>
                    {g.members.length}
                    {g.externalMembers && g.externalMembers.length > 0 ? (
                      <span className="muted small"> + 外部 {g.externalMembers.length}</span>
                    ) : null}
                  </td>
                  <td>
                    <AgentToggle group={g} isAdmin={isAdmin} />
                  </td>
                  <td className="small">
                    {g.activeAgentRunId ? (
                      <Link to={`/agent-runs/${encodeURIComponent(g.activeAgentRunId)}`}>agent run</Link>
                    ) : null}
                    {g.activeAgentRunId && g.activeSequenceRunId ? ' · ' : null}
                    {g.activeSequenceRunId ? (
                      <Link to={`/sequence-runs/${encodeURIComponent(g.activeSequenceRunId)}`}>序列</Link>
                    ) : null}
                    {!g.activeAgentRunId && !g.activeSequenceRunId ? <span className="muted">—</span> : null}
                  </td>
                  <td>
                    <DateTime value={g.createdAt ?? null} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
