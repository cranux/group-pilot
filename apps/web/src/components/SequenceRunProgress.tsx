import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { SequenceRunStep } from '../api/types';
import { ErrorBox } from './ErrorBox';
import { Loading } from './Loading';
import { Badge, Mono, StatusBadge } from './Badge';
import { Countdown, DateTime } from './Time';
import { SEQ_RUN_STATUS, SEQ_STEP_STATUS } from '../lib/labels';
import { describeVarSource, extractPlaceholders } from '../lib/vars';

function VarsCell({ step }: { step: SequenceRunStep }) {
  const vars = step.resolvedVars ?? {};
  const keys = Object.keys(vars);
  if (keys.length === 0) return <span className="muted">—</span>;
  const used = extractPlaceholders(step.text ?? '');
  return (
    <div className="var-list">
      {keys.map((k) => (
        <div key={k} className={used.includes(k) ? 'var-used' : 'var-unused'}>
          <code>{k}</code> = <span className="var-value">{vars[k] === '' ? '""' : vars[k]}</span>{' '}
          <span className="muted small">{describeVarSource(step.varSources?.[k])}</span>
        </div>
      ))}
    </div>
  );
}

/** 序列运行进度：WS `sequence_run` 事件失效 + 运行中 2s 轮询兜底。 */
export function SequenceRunProgress({ runId, showHeaderLink }: { runId: string; showHeaderLink?: boolean }) {
  const q = useQuery({
    queryKey: qk.seqRun(runId),
    queryFn: () => api.getSequenceRun(runId),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'running' ? false : 2000),
  });

  if (q.isLoading) return <Loading />;
  if (q.error && !q.data) return <ErrorBox error={q.error} title="加载序列运行失败" />;
  const run = q.data;
  if (!run) return null;
  const steps = [...run.steps].sort((a, b) => a.index - b.index);
  const done = steps.filter((s) => s.status === 'sent' || s.status === 'skipped' || s.status === 'failed').length;
  const running = run.status === 'running';

  return (
    <div className="seq-progress">
      <div className="kv-grid">
        <div>
          <span className="kv-label">运行</span>
          {showHeaderLink ? <Link to={`/sequence-runs/${encodeURIComponent(run.id)}`}>{run.id}</Link> : <Mono>{run.id}</Mono>}
        </div>
        <div>
          <span className="kv-label">序列</span>
          {run.sequenceName ?? '—'} <Mono>({run.sequenceId})</Mono>
        </div>
        <div>
          <span className="kv-label">群</span>
          <Link to={`/groups/${encodeURIComponent(run.groupId)}`}>{run.groupId}</Link>
        </div>
        <div>
          <span className="kv-label">状态</span>
          <StatusBadge table={SEQ_RUN_STATUS} value={run.status} showRaw />
          {run.status === 'stopped' ? <span className="muted small"> 群变为不可达，序列已停止</span> : null}
        </div>
        <div>
          <span className="kv-label">进度</span>
          {done} / {steps.length}
          {run.currentStepIndex !== null && running ? <span className="muted"> · 当前第 {run.currentStepIndex} 步</span> : null}
        </div>
        <div>
          <span className="kv-label">开始</span>
          <DateTime value={run.createdAt} />
        </div>
        <div>
          <span className="kv-label">结束</span>
          <DateTime value={run.endedAt} />
        </div>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
      </div>
      {q.error ? <ErrorBox error={q.error} compact title="刷新失败（显示的是上次结果）" /> : null}
      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>状态</th>
            <th>角色 / 账号</th>
            <th>文本</th>
            <th>变量取值（来源）</th>
            <th>计划发送</th>
            <th>发出 / 跳过</th>
            <th>clientMsgId</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const current = running && s.index === run.currentStepIndex;
            return (
              <tr key={s.index} className={current ? 'row-current' : undefined}>
                <td>
                  {s.index}
                  {current ? <Badge tone="yellow">当前</Badge> : null}
                </td>
                <td>
                  <StatusBadge table={SEQ_STEP_STATUS} value={s.status} />
                </td>
                <td>
                  <div>{s.accountRole === 'admin' ? '管理员' : '成员'}</div>
                  <Mono>{s.accountId ?? '—'}</Mono>
                </td>
                <td className="cell-text">
                  <div>{s.resolvedText ?? s.text}</div>
                  {s.resolvedText && s.resolvedText !== s.text ? <div className="muted small mono">{s.text}</div> : null}
                </td>
                <td>
                  <VarsCell step={s} />
                </td>
                <td>
                  <DateTime value={s.scheduledAt} />
                  {s.status === 'pending' && s.scheduledAt ? (
                    <div className="small">
                      <Countdown until={s.scheduledAt} prefix="剩余 " expiredText="即将发送" />
                    </div>
                  ) : null}
                </td>
                <td>
                  {s.sentAt ? <DateTime value={s.sentAt} /> : null}
                  {s.skippedAt ? (
                    <div>
                      <span className="muted small">跳过于 </span>
                      <DateTime value={s.skippedAt} />
                    </div>
                  ) : null}
                  {!s.sentAt && !s.skippedAt ? <span className="muted">—</span> : null}
                </td>
                <td>
                  <Mono>{s.clientMsgId ?? '—'}</Mono>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
