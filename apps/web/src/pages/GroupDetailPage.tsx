import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { Account, AgentRunSummary, Group, PatchGroupRequest } from '../api/types';
import { useAuth } from '../auth/useSession';
import { PageHeader } from '../components/Layout';
import { ErrorBox, InlineError } from '../components/ErrorBox';
import { Empty, Loading } from '../components/Loading';
import { Badge, Mono, StatusBadge } from '../components/Badge';
import { Switch } from '../components/Switch';
import { DateTime } from '../components/Time';
import { ConfirmDialog } from '../components/Modal';
import { JobProgress } from '../components/JobProgress';
import { Timeline } from '../components/Timeline';
import { ACCOUNT_STATUS, AGENT_RUN_STATUS, END_REASON, GROUP_STATUS, MEMBER_ROLE, SEQ_RUN_STATUS } from '../lib/labels';
import { truncate } from '../lib/format';

function GroupStatusBanner({ group }: { group: Group }) {
  if (group.status === 'unreachable') {
    return (
      <div className="alert alert-error alert-strong">
        <div className="alert-title">该群不可达（unreachable）</div>
        群不可写（可能被解散或禁言）：该群的序列运行已停止，agent 不再触发，正在运行的 agent run 会在当前步后取消。
      </div>
    );
  }
  if (group.status === 'left') {
    return (
      <div className="alert alert-warning alert-strong">
        <div className="alert-title">已全员退群（left）</div>
        所有服务账号已退出该群，成员表为空，无法再以服务账号发消息。
      </div>
    );
  }
  return null;
}

function BlockedRunsBanner({ runs }: { runs: AgentRunSummary[] | undefined }) {
  const blocked = (runs ?? []).filter((r) => r.status === 'blocked');
  if (blocked.length === 0) return null;
  return (
    <div className="alert alert-error alert-strong">
      <div className="alert-title">有 {blocked.length} 个 agent run 被审计阻断（blocked / audit_blocked）</div>
      审计服务连续 3 次没有给出明确结论，相关工具调用未执行，需要人工确认：
      <ul className="inline-list">
        {blocked.map((r) => (
          <li key={r.id}>
            <Link to={`/agent-runs/${encodeURIComponent(r.id)}`} className="mono">
              {r.id}
            </Link>{' '}
            <span className="muted small">
              <DateTime value={r.createdAt} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PolicyToggles({ group }: { group: Group }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (body: PatchGroupRequest) => api.patchGroup(group.id, body),
    onSuccess: (g) => {
      if (g && typeof g === 'object' && 'id' in g) qc.setQueryData(qk.group(group.id), g);
      else void qc.invalidateQueries({ queryKey: qk.group(group.id) });
      void qc.invalidateQueries({ queryKey: qk.groupsList() });
    },
  });
  const pendingBody = m.isPending ? m.variables : undefined;
  return (
    <div className="toggles">
      <Switch
        checked={pendingBody?.agentEnabled ?? group.agentEnabled}
        disabled={m.isPending}
        onChange={(v) => m.mutate({ agentEnabled: v })}
        label="自动应答 Agent（agentEnabled）"
      />
      <Switch
        checked={pendingBody?.autoKickEnabled ?? group.autoKickEnabled}
        disabled={m.isPending}
        onChange={(v) => m.mutate({ autoKickEnabled: v })}
        label="允许 Agent 移除成员（autoKickEnabled）"
      />
      {m.error ? <ErrorBox error={m.error} compact title="修改失败" /> : null}
    </div>
  );
}

function SendForm({ group, accountsById }: { group: Group; accountsById: Map<string, Account> }) {
  const [accountId, setAccountId] = useState('');
  const [text, setText] = useState('');
  const [last, setLast] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (vars: { accountId: string; text: string }) => api.sendMessage(group.id, vars),
    onMutate: () => setLast(null),
    onSuccess: (r) => {
      setLast(r.clientMsgId);
      setText('');
    },
  });
  // 默认选第一个在线的成员账号；已选账号不再是成员时回退
  const defaultAccount =
    group.members.find((mem) => accountsById.get(mem.accountId)?.status === 'online')?.accountId ?? group.members[0]?.accountId ?? '';
  const effectiveAccount = group.members.some((mem) => mem.accountId === accountId) ? accountId : defaultAccount;
  const submit = () => {
    if (!effectiveAccount || !text.trim() || m.isPending) return;
    m.mutate({ accountId: effectiveAccount, text });
  };
  if (group.members.length === 0) {
    return <div className="muted small">该群没有服务账号成员，无法发送消息。</div>;
  }
  return (
    <form
      className="send-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="send-row">
        <label className="field field-inline">
          <span>发送账号</span>
          <select className="input" value={effectiveAccount} onChange={(e) => setAccountId(e.target.value)}>
            {group.members.map((mem) => {
              const st = accountsById.get(mem.accountId)?.status;
              return (
                <option key={mem.accountId} value={mem.accountId}>
                  {mem.accountId}（{MEMBER_ROLE[mem.role]?.label ?? mem.role}
                  {st ? ` · ${ACCOUNT_STATUS[st]?.label ?? st}` : ''}）
                </option>
              );
            })}
          </select>
        </label>
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder="消息内容（Ctrl/⌘ + Enter 发送）"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="send-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={m.isPending || !text.trim() || !effectiveAccount}
        >
          {m.isPending ? '提交中…' : '发送'}
        </button>
        {last ? (
          <span className="muted small">
            已受理，clientMsgId <Mono>{last}</Mono>，投递状态见时间线
          </span>
        ) : null}
      </div>
      {m.error ? <ErrorBox error={m.error} compact title="发送失败" /> : null}
    </form>
  );
}

function LeaveAll({ group }: { group: Group }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.leaveAll(group.id),
    onSuccess: (r) => {
      setJobId(r.jobId);
      setConfirm(false);
    },
  });
  return (
    <div className="leave-all">
      <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)} disabled={group.status === 'left' || m.isPending}>
        全员退群（leave-all）
      </button>
      {group.status === 'left' ? <span className="muted small"> 已退群</span> : null}
      {confirm ? (
        <ConfirmDialog
          title="确认全员退群？"
          danger
          confirmLabel="确认退群"
          pending={m.isPending}
          onCancel={() => {
            setConfirm(false);
            m.reset();
          }}
          onConfirm={() => m.mutate()}
          message={
            <div>
              群 <Mono>{group.id}</Mono> 中的所有服务账号（{group.members.length} 个）将退出该群，群主最后退出。
              <br />
              非群主账号退群失败时，群主不会退出，job 记为失败。此操作不可撤销。
            </div>
          }
        >
          <ErrorBox error={m.error} compact />
        </ConfirmDialog>
      ) : null}
      {jobId ? (
        <JobProgress
          jobId={jobId}
          onFinished={() => {
            void qc.invalidateQueries({ queryKey: qk.group(group.id) });
            void qc.invalidateQueries({ queryKey: qk.groupsList() });
          }}
          onDismiss={() => setJobId(null)}
        />
      ) : null}
    </div>
  );
}

function MembersCard({ group, accountsById }: { group: Group; accountsById: Map<string, Account> }) {
  const order: Record<string, number> = { creator: 0, admin: 1, member: 2 };
  const members = [...group.members].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.accountId.localeCompare(b.accountId));
  const external = group.externalMembers ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>成员</h2>
        <span className="muted small">
          服务账号 {group.members.length} · 外部 {external.length}
        </span>
      </div>
      {members.length === 0 ? (
        <Empty>没有服务账号成员</Empty>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>账号</th>
              <th>platformUserId</th>
              <th>群角色</th>
              <th>账号状态</th>
            </tr>
          </thead>
          <tbody>
            {members.map((mem) => {
              const st = accountsById.get(mem.accountId)?.status;
              return (
                <tr key={mem.accountId}>
                  <td>
                    <Mono>{mem.accountId}</Mono>
                  </td>
                  <td>
                    <Mono>{mem.platformUserId ?? '—'}</Mono>
                  </td>
                  <td>
                    <StatusBadge table={MEMBER_ROLE} value={mem.role} />
                  </td>
                  <td>{st ? <StatusBadge table={ACCOUNT_STATUS} value={st} /> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="card-body">
        <div className="subhead">外部成员</div>
        {external.length === 0 ? (
          <span className="muted small">无</span>
        ) : (
          <div className="chips">
            {external.map((e) => (
              <span key={e.platformUserId} className="chip">
                <span className="mono">{e.platformUserId}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentRunsCard({ groupId, runs, error, loading }: { groupId: string; runs: AgentRunSummary[] | undefined; error: unknown; loading: boolean }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>最近的 Agent 运行</h2>
        <span className="muted small">群 {groupId}</span>
      </div>
      {error ? <ErrorBox error={error} compact title="加载 agent run 失败" /> : null}
      {loading ? <Loading /> : null}
      {runs && runs.length === 0 ? <Empty>暂无 agent run</Empty> : null}
      {runs && runs.length > 0 ? (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Run</th>
              <th>状态</th>
              <th>结束原因</th>
              <th>摘要</th>
              <th>步数</th>
              <th>开始</th>
              <th>结束</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={r.status === 'blocked' ? 'row-blocked' : undefined}>
                <td>
                  <Link to={`/agent-runs/${encodeURIComponent(r.id)}`} className="mono">
                    {truncate(r.id, 14)}
                  </Link>
                </td>
                <td>
                  <StatusBadge table={AGENT_RUN_STATUS} value={r.status} strong={r.status === 'blocked'} />
                </td>
                <td>
                  {r.endReason ? (
                    <span title={r.endReason}>
                      {END_REASON[r.endReason] ?? r.endReason} <span className="muted small mono">{r.endReason}</span>
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="cell-text" title={r.summary ?? undefined}>
                  {r.summary ? truncate(r.summary, 80) : <span className="muted">—</span>}
                </td>
                <td>{r.stepCount}</td>
                <td>
                  <DateTime value={r.createdAt} />
                </td>
                <td>
                  <DateTime value={r.endedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function SequenceRunsCard({ group, isAdmin }: { group: Group; isAdmin: boolean }) {
  const q = useQuery({ queryKey: qk.seqRunsByGroup(group.id), queryFn: () => api.listSequenceRuns(group.id) });
  return (
    <div className="card">
      <div className="card-head">
        <h2>序列运行</h2>
        <span className="spacer" />
        <Link to={`/groups/${encodeURIComponent(group.id)}/sequences`} className="btn btn-sm btn-primary">
          {isAdmin ? '启动序列' : '查看序列'}
        </Link>
      </div>
      {q.error ? <ErrorBox error={q.error} compact title="加载序列运行失败" /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.length === 0 ? <Empty>暂无序列运行</Empty> : null}
      {q.data && q.data.length > 0 ? (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>运行</th>
              <th>序列</th>
              <th>状态</th>
              <th>当前步骤</th>
              <th>开始</th>
              <th>结束</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/sequence-runs/${encodeURIComponent(r.id)}`} className="mono">
                    {truncate(r.id, 14)}
                  </Link>
                </td>
                <td className="nowrap">{r.sequenceName ?? <Mono>{r.sequenceId}</Mono>}</td>
                <td>
                  <StatusBadge table={SEQ_RUN_STATUS} value={r.status} />
                </td>
                <td>{r.currentStepIndex ?? '—'}</td>
                <td>
                  <DateTime value={r.createdAt} />
                </td>
                <td>
                  <DateTime value={r.endedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function GroupDetailPage() {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const group = useQuery({ queryKey: qk.group(id), queryFn: () => api.getGroup(id), enabled: !!id });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.listAccounts });
  const runs = useQuery({ queryKey: qk.agentRunsByGroup(id), queryFn: () => api.listAgentRuns(id), enabled: !!id });

  const accountsById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const accountByPlatformId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts.data ?? []) if (a.platformUserId) m.set(a.platformUserId, a.id);
    for (const mem of group.data?.members ?? []) if (mem.platformUserId) m.set(mem.platformUserId, mem.accountId);
    return m;
  }, [accounts.data, group.data]);

  if (group.isLoading) return <Loading />;
  if (group.error && !group.data) {
    return (
      <div>
        <PageHeader title={`群 ${id}`} />
        <ErrorBox error={group.error} title="加载群失败" />
        <Link to="/groups">返回群列表</Link>
      </div>
    );
  }
  const g = group.data;
  if (!g) return null;

  return (
    <div>
      <PageHeader
        title={
          <>
            群 <span className="mono">{g.id}</span> <StatusBadge table={GROUP_STATUS} value={g.status} showRaw strong={g.status !== 'active'} />
          </>
        }
        sub={
          <span className="summary-chips">
            <span>
              网关群 <Mono>{g.gatewayGroupId ?? '—'}</Mono>
            </span>
            <span>
              群主 <Mono>{g.creatorAccountId}</Mono>
            </span>
            <span>
              创建于 <DateTime value={g.createdAt ?? null} />
            </span>
            <span>
              Agent <Badge tone={g.agentEnabled ? 'green' : 'gray'}>{g.agentEnabled ? '开启' : '关闭'}</Badge>
            </span>
            <span>
              自动踢人 <Badge tone={g.autoKickEnabled ? 'yellow' : 'gray'}>{g.autoKickEnabled ? '开启' : '关闭'}</Badge>
            </span>
            {g.activeAgentRunId ? (
              <span>
                运行中 run <Link to={`/agent-runs/${encodeURIComponent(g.activeAgentRunId)}`} className="mono">{truncate(g.activeAgentRunId, 14)}</Link>
              </span>
            ) : null}
            {g.activeSequenceRunId ? (
              <span>
                运行中序列 <Link to={`/sequence-runs/${encodeURIComponent(g.activeSequenceRunId)}`} className="mono">{truncate(g.activeSequenceRunId, 14)}</Link>
              </span>
            ) : null}
          </span>
        }
      >
        <Link to="/groups" className="btn btn-sm">
          返回列表
        </Link>
      </PageHeader>

      <BlockedRunsBanner runs={runs.data} />
      <GroupStatusBanner group={g} />
      {group.error ? <ErrorBox error={group.error} compact title="刷新群信息失败（显示的是上次结果）" /> : null}

      <div className="grid-2">
        <div className="col">
          <div className="card">
            <div className="card-head">
              <h2>消息时间线</h2>
            </div>
            <Timeline groupId={g.id} accountByPlatformId={accountByPlatformId} />
            {isAdmin ? (
              <div className="card-body border-top">
                <div className="subhead">以服务账号发送消息</div>
                {g.status === 'left' ? (
                  <span className="muted small">已退群，无法发送。</span>
                ) : (
                  <SendForm group={g} accountsById={accountsById} />
                )}
              </div>
            ) : null}
          </div>
          <AgentRunsCard groupId={g.id} runs={runs.data} error={runs.error} loading={runs.isLoading} />
        </div>
        <div className="col">
          {isAdmin ? (
            <div className="card">
              <div className="card-head">
                <h2>群设置</h2>
              </div>
              <div className="card-body">
                <PolicyToggles group={g} />
              </div>
              <div className="card-body border-top">
                <LeaveAll group={g} />
              </div>
            </div>
          ) : null}
          <MembersCard group={g} accountsById={accountsById} />
          <SequenceRunsCard group={g} isAdmin={isAdmin} />
        </div>
      </div>
      {accounts.error ? <InlineError error={accounts.error} /> : null}
    </div>
  );
}
