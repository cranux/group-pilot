import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { AgentStep } from '../api/types';
import { PageHeader } from '../components/Layout';
import { ErrorBox } from '../components/ErrorBox';
import { Empty, Loading } from '../components/Loading';
import { Badge, Mono, StatusBadge } from '../components/Badge';
import { DateTime } from '../components/Time';
import { JsonBlock, RawText } from '../components/JsonBlock';
import { AGENT_RUN_STATUS, AUDIT_VERDICT, END_REASON, ERROR_HINTS, STEP_KIND } from '../lib/labels';
import { formatElapsed } from '../lib/format';
import { useNow } from '../hooks/useNow';

function StepRow({ step, expanded, onToggle }: { step: AgentStep; expanded: boolean; onToggle: () => void }) {
  const isProto = step.kind === 'protocol_error';
  return (
    <Fragment>
      <tr className={`step-row${isProto ? ' row-protocol' : ''}${step.isError ? ' row-error' : ''}${expanded ? ' row-expanded' : ''}`}>
        <td>{step.stepNo}</td>
        <td>
          <StatusBadge table={STEP_KIND} value={step.kind} />
        </td>
        <td>
          {step.name ? <Mono>{step.name}</Mono> : <span className="muted">—</span>}
          {step.toolUseId ? <div className="mono small muted">{step.toolUseId}</div> : null}
        </td>
        <td className="cell-json">{step.input === null || step.input === undefined ? <span className="muted">—</span> : <JsonBlock value={step.input} />}</td>
        <td className="cell-text">{step.resultSummary ?? <span className="muted">—</span>}</td>
        <td>{step.auditVerdict ? <StatusBadge table={AUDIT_VERDICT} value={step.auditVerdict} showRaw /> : <span className="muted">—</span>}</td>
        <td>
          {step.isError ? (
            <span title={step.errorCode ? ERROR_HINTS[step.errorCode] : undefined}>
              <Badge tone="red">错误</Badge> <code className="err-code">{step.errorCode ?? '—'}</code>
            </span>
          ) : (
            <span className="muted">否</span>
          )}
        </td>
        <td>
          <DateTime value={step.createdAt} />
        </td>
        <td>
          <button type="button" className={`btn btn-sm ${isProto ? 'btn-danger' : ''}`} onClick={onToggle}>
            {expanded ? '收起' : '原始响应'}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="step-raw">
          <td colSpan={9}>
            <div className="raw-head">
              <strong>Agent 服务原始响应体</strong>
              <span className="muted small">（原样显示，最多 2KB；{step.rawResponse ? `${step.rawResponse.length} 字符` : '空'}）</span>
            </div>
            <RawText text={step.rawResponse} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export function AgentRunPage() {
  const { id = '' } = useParams();
  const now = useNow();
  const q = useQuery({
    queryKey: qk.agentRun(id),
    queryFn: () => api.getAgentRun(id),
    enabled: !!id,
    // WS agent_step / agent_run 事件会失效该查询；运行中额外 3s 轮询兜底
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'running' ? false : 3000),
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (q.isLoading) return <Loading />;
  if (q.error && !q.data) {
    return (
      <div>
        <PageHeader title={`Agent 运行 ${id}`} />
        <ErrorBox error={q.error} title="加载 agent run 失败" />
      </div>
    );
  }
  const run = q.data;
  if (!run) return null;
  const steps = [...run.steps].sort((a, b) => a.stepNo - b.stepNo);
  const protoSteps = steps.filter((s) => s.kind === 'protocol_error').map((s) => s.stepNo);
  const toggle = (no: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no);
      else next.add(no);
      return next;
    });

  return (
    <div>
      <PageHeader
        title={
          <>
            Agent 运行 <span className="mono">{run.id}</span>{' '}
            <StatusBadge table={AGENT_RUN_STATUS} value={run.status} showRaw strong={run.status === 'blocked'} />
          </>
        }
        sub={
          <span className="summary-chips">
            <span>
              群 <Link to={`/groups/${encodeURIComponent(run.groupId)}`} className="mono">{run.groupId}</Link>
            </span>
            <span>
              开始 <DateTime value={run.createdAt} />
            </span>
            <span>
              结束 <DateTime value={run.endedAt} />
            </span>
            <span>耗时 {formatElapsed(run.createdAt, run.endedAt, now)}</span>
            <span>步数 {run.stepCount ?? steps.length} / 12</span>
          </span>
        }
      >
        <Link to={`/groups/${encodeURIComponent(run.groupId)}`} className="btn btn-sm">
          返回群
        </Link>
      </PageHeader>

      {run.status === 'blocked' ? (
        <div className="alert alert-error alert-strong">
          <div className="alert-title">该 run 被审计阻断（audit_blocked）</div>
          审计服务连续 3 次没有给出明确结论，待执行的工具调用未执行。请人工检查该群的情况。
        </div>
      ) : null}
      {q.error ? <ErrorBox error={q.error} compact title="刷新失败（显示的是上次结果）" /> : null}

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>结果</h2>
          </div>
          <div className="card-body kv-grid">
            <div>
              <span className="kv-label">状态</span>
              <StatusBadge table={AGENT_RUN_STATUS} value={run.status} showRaw />
            </div>
            <div>
              <span className="kv-label">结束原因</span>
              {run.endReason ? (
                <>
                  {END_REASON[run.endReason] ?? run.endReason} <Mono>{run.endReason}</Mono>
                </>
              ) : (
                <span className="muted">{run.status === 'running' ? '运行中' : '—'}</span>
              )}
            </div>
            <div className="kv-wide">
              <span className="kv-label">摘要</span>
              {run.summary ? <span className="pre-wrap">{run.summary}</span> : <span className="muted">—</span>}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>触发消息</h2>
            <span className="muted small">{run.triggerMessages.length} 条</span>
          </div>
          {run.triggerMessages.length === 0 ? (
            <Empty>无</Empty>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>发送者</th>
                  <th>内容</th>
                  <th>msgId</th>
                </tr>
              </thead>
              <tbody>
                {run.triggerMessages.map((m) => (
                  <tr key={m.msgId}>
                    <td>
                      <DateTime value={m.sentAt} />
                    </td>
                    <td>
                      <Mono>{m.senderPlatformUserId ?? '—'}</Mono>
                    </td>
                    <td className="cell-text">{m.text}</td>
                    <td>
                      <Mono>{m.msgId}</Mono>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>步骤</h2>
          <span className="muted small">
            共 {steps.length} 步{protoSteps.length ? `，其中协议错误 ${protoSteps.length} 步` : ''}
          </span>
          <span className="spacer" />
          {protoSteps.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => setExpanded(new Set(protoSteps))}>
              展开全部协议错误
            </button>
          ) : null}
          {expanded.size > 0 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(new Set())}>
              全部收起
            </button>
          ) : null}
        </div>
        {steps.length === 0 ? (
          <Empty>{run.status === 'running' ? '等待第一步…' : '没有步骤'}</Empty>
        ) : (
          <div className="table-wrap">
          <table className="table steps-table">
            <thead>
              <tr>
                <th>#</th>
                <th>类型</th>
                <th>工具</th>
                <th>入参</th>
                <th>结果摘要</th>
                <th>审计</th>
                <th>错误</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <StepRow key={s.stepNo} step={s} expanded={expanded.has(s.stepNo)} onToggle={() => toggle(s.stepNo)} />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
