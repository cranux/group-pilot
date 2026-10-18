import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import { hasCode, isApiError } from '../api/errors';
import type { PreflightResult, Sequence, SequenceRunRequest } from '../api/types';
import { useAuth } from '../auth/useSession';
import { PageHeader } from '../components/Layout';
import { ErrorBox } from '../components/ErrorBox';
import { Empty, Loading } from '../components/Loading';
import { Badge, Mono, StatusBadge } from '../components/Badge';
import { Modal } from '../components/Modal';
import { KvEditor } from '../components/KvEditor';
import { SequenceRunProgress } from '../components/SequenceRunProgress';
import { DateTime } from '../components/Time';
import { GROUP_STATUS, SEQ_RUN_STATUS } from '../lib/labels';
import {
  SEQUENCE_EXAMPLE,
  addMissingKeys,
  buildSequenceRunRequest,
  describeVarSource,
  extractPlaceholders,
  parseSequenceJson,
  sequencePlaceholders,
  validateRows,
  type KvRow,
} from '../lib/vars';

/** 422 UNRESOLVED_PLACEHOLDER / 409 SEQUENCE_ALREADY_RUNNING 的专门展示。 */
function SequenceError({ error, groupId, activeRunId }: { error: unknown; groupId: string; activeRunId: string | null }) {
  if (!error) return null;
  if (hasCode(error, 'UNRESOLVED_PLACEHOLDER') && isApiError(error)) {
    const stepIndex = error.details.stepIndex;
    const key = error.details.key;
    return (
      <ErrorBox error={error} title="预检不通过：存在无法解析的占位符">
        <div className="placeholder-error">
          第 <strong>{String(stepIndex ?? '?')}</strong> 步的占位符 <code>{`{${String(key ?? '?')}}`}</code> 没有取值（stepIndex = {String(stepIndex ?? '—')}，key ={' '}
          {String(key ?? '—')}）。请在 vars 或该步及之前步骤的 stepVars 中提供非空值。没有发送任何消息。
        </div>
      </ErrorBox>
    );
  }
  if (hasCode(error, 'SEQUENCE_ALREADY_RUNNING')) {
    return (
      <ErrorBox error={error} title="该群已有运行中的序列">
        <div>
          同一群同一时刻至多一个运行中的序列。
          {activeRunId ? (
            <>
              {' '}
              运行中：<Link to={`/sequence-runs/${encodeURIComponent(activeRunId)}`} className="mono">{activeRunId}</Link>
            </>
          ) : (
            <>
              {' '}
              <Link to={`/groups/${encodeURIComponent(groupId)}`}>到群详情查看</Link>
            </>
          )}
        </div>
      </ErrorBox>
    );
  }
  return <ErrorBox error={error} />;
}

function PreflightModal({
  result,
  request,
  sequence,
  groupId,
  activeRunId,
  onClose,
  onStarted,
}: {
  result: PreflightResult;
  request: SequenceRunRequest;
  sequence: Sequence | undefined;
  groupId: string;
  activeRunId: string | null;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.startSequenceRun(groupId, request),
    onSuccess: ({ runId }) => {
      void qc.invalidateQueries({ queryKey: qk.seqRunsByGroup(groupId) });
      void qc.invalidateQueries({ queryKey: qk.group(groupId) });
      onStarted(runId);
    },
    onError: (err) => {
      if (hasCode(err, 'SEQUENCE_ALREADY_RUNNING')) void qc.invalidateQueries({ queryKey: qk.group(groupId) });
    },
  });
  const steps = [...result.steps].sort((a, b) => a.index - b.index);
  const delays = new Map((sequence?.steps ?? []).map((s) => [s.index, s.delaySeconds]));

  return (
    <Modal
      title={`预检结果：${sequence?.name ?? request.sequenceId}`}
      onClose={onClose}
      width={900}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={start.isPending}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? '启动中…' : '启动'}
          </button>
        </>
      }
    >
      <p className="muted small">预检不落库、不发送。下表是每一步每个变量的最终取值与来源；确认无误后点击「启动」。</p>
      {steps.map((s) => {
        const keys = Object.keys(s.resolvedVars ?? {});
        const used = extractPlaceholders(s.text);
        return (
          <div key={s.index} className="preflight-step">
            <div className="preflight-head">
              <strong>第 {s.index} 步</strong>
              <Badge tone={s.accountRole === 'admin' ? 'blue' : 'gray'}>{s.accountRole === 'admin' ? '管理员发送' : '成员发送'}</Badge>
              {delays.has(s.index) ? <span className="muted small">延迟 {delays.get(s.index)} 秒</span> : null}
            </div>
            <div className="preflight-text">
              <div>
                <span className="kv-label">原文</span>
                <span className="mono">{s.text}</span>
              </div>
              <div>
                <span className="kv-label">解析后</span>
                <span className="resolved">{s.resolvedText}</span>
              </div>
            </div>
            {keys.length === 0 ? (
              <div className="muted small">该步没有变量</div>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>key</th>
                    <th>最终取值</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k} className={used.includes(k) ? 'row-used' : 'row-dim'}>
                      <td>
                        <code>{k}</code>
                        {used.includes(k) ? <span className="muted small"> 本步使用</span> : null}
                      </td>
                      <td>{s.resolvedVars[k] === '' ? <span className="muted">""</span> : s.resolvedVars[k]}</td>
                      <td>
                        <span title={s.varSources?.[k]}>{describeVarSource(s.varSources?.[k])}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
      <SequenceError error={start.error} groupId={groupId} activeRunId={activeRunId} />
    </Modal>
  );
}

function CreateSequence({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(SEQUENCE_EXAMPLE);
  const [localError, setLocalError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (body: unknown) => api.createSequence(body),
    onSuccess: ({ id }) => {
      void qc.invalidateQueries({ queryKey: qk.sequences() });
      onCreated(id);
      setOpen(false);
    },
  });
  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        + 新建序列
      </button>
    );
  }
  return (
    <div className="card inner-card">
      <div className="card-head">
        <h3>新建序列（JSON）</h3>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setText(SEQUENCE_EXAMPLE)}>
          恢复示例
        </button>
      </div>
      <div className="card-body">
        <textarea className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className="muted small">
          格式：<code>{'{ name, steps: [{ index, accountRole: "admin" | "member", text, delaySeconds }] }'}</code>；文本中的{' '}
          <code>{'{key}'}</code> 在发送时解析。
        </div>
        {localError ? <div className="alert alert-warning">{localError}</div> : null}
        <ErrorBox error={m.error} title="创建失败" />
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={m.isPending}
            onClick={() => {
              const parsed = parseSequenceJson(text);
              if (!parsed.ok) {
                setLocalError(parsed.error);
                return;
              }
              setLocalError(null);
              m.mutate(parsed.value);
            }}
          >
            {m.isPending ? '创建中…' : '创建'}
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)} disabled={m.isPending}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export function SequencesPage() {
  const { id: groupId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAdmin } = useAuth();
  const sequences = useQuery({ queryKey: qk.sequences(), queryFn: api.listSequences });
  const group = useQuery({ queryKey: qk.group(groupId), queryFn: () => api.getGroup(groupId), enabled: !!groupId });
  const runs = useQuery({ queryKey: qk.seqRunsByGroup(groupId), queryFn: () => api.listSequenceRuns(groupId), enabled: !!groupId });

  const selectedId = searchParams.get('sequenceId') ?? '';
  const setSelectedId = (sid: string) => {
    const next = new URLSearchParams(searchParams);
    if (sid) next.set('sequenceId', sid);
    else next.delete('sequenceId');
    setSearchParams(next, { replace: true });
  };
  const selected = sequences.data?.find((s) => String(s.id) === selectedId);

  // 没有选中时默认选第一个
  const firstSequenceId = sequences.data && sequences.data.length > 0 ? String(sequences.data[0].id) : '';
  useEffect(() => {
    if (!selectedId && firstSequenceId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sequenceId', firstSequenceId);
          return next;
        },
        { replace: true },
      );
    }
  }, [selectedId, firstSequenceId, setSearchParams]);

  const [varsRows, setVarsRows] = useState<KvRow[]>([]);
  const [stepRows, setStepRows] = useState<Record<string, KvRow[]>>({});
  const [preflight, setPreflight] = useState<{ result: PreflightResult; request: SequenceRunRequest } | null>(null);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  const steps = useMemo(() => [...(selected?.steps ?? [])].sort((a, b) => a.index - b.index), [selected]);
  const placeholders = useMemo(() => sequencePlaceholders(steps), [steps]);

  // 切换序列时（只看 id，列表重拉不算）：重置 stepVars，并把占位符键补进 vars（值为空 = 未提供）
  const lastSequenceId = useRef<string | null>(null);
  useEffect(() => {
    const sid = selected ? String(selected.id) : null;
    if (sid === lastSequenceId.current) return;
    lastSequenceId.current = sid;
    setStepRows({});
    setVarsRows((rows) => addMissingKeys(rows, placeholders));
  }, [selected, placeholders]);

  const allErrors = [varsRows, ...Object.values(stepRows)].flatMap((rows) => validateRows(rows).errors);

  const pf = useMutation({
    mutationFn: (request: SequenceRunRequest) => api.preflightSequence(groupId, request).then((result) => ({ result, request })),
    onSuccess: (r) => setPreflight(r),
  });

  const runPreflight = () => {
    if (!selected || allErrors.length) return;
    pf.mutate(buildSequenceRunRequest(String(selected.id), varsRows, stepRows));
  };

  const activeRunId = group.data?.activeSequenceRunId ?? null;

  return (
    <div>
      <PageHeader
        title={
          <>
            序列运行 · 群 <span className="mono">{groupId}</span>{' '}
            {group.data ? <StatusBadge table={GROUP_STATUS} value={group.data.status} strong={group.data.status !== 'active'} /> : null}
          </>
        }
        sub={
          activeRunId ? (
            <span>
              该群有运行中的序列：
              <Link to={`/sequence-runs/${encodeURIComponent(activeRunId)}`} className="mono">
                {activeRunId}
              </Link>
            </span>
          ) : null
        }
      >
        <Link to={`/groups/${encodeURIComponent(groupId)}`} className="btn btn-sm">
          返回群详情
        </Link>
      </PageHeader>
      {group.error ? <ErrorBox error={group.error} compact title="加载群失败" /> : null}

      <div className="card">
        <div className="card-head">
          <h2>选择序列</h2>
          <span className="spacer" />
          {isAdmin ? <CreateSequence onCreated={(sid) => setSelectedId(String(sid))} /> : null}
        </div>
        <div className="card-body">
          {sequences.error ? <ErrorBox error={sequences.error} title="加载序列失败" /> : null}
          {sequences.isLoading ? <Loading /> : null}
          {sequences.data && sequences.data.length === 0 ? <Empty>还没有序列{isAdmin ? '，请先新建一个' : ''}</Empty> : null}
          {sequences.data && sequences.data.length > 0 ? (
            <label className="field field-inline">
              <span>序列</span>
              <select className="input" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                {sequences.data.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}（{s.steps.length} 步）
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selected ? (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>发送角色</th>
                  <th>文本</th>
                  <th>延迟</th>
                  <th>占位符</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={s.index}>
                    <td>{s.index}</td>
                    <td>{s.accountRole === 'admin' ? '管理员' : '成员'}</td>
                    <td className="cell-text mono">{s.text}</td>
                    <td>{s.delaySeconds} 秒</td>
                    <td>
                      {extractPlaceholders(s.text).map((k) => (
                        <code key={k} className="ph">
                          {k}
                        </code>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>

      {isAdmin && selected ? (
        <div className="card">
          <div className="card-head">
            <h2>启动参数</h2>
          </div>
          <div className="card-body">
            <div className="subhead">vars（初始取值）</div>
            <div className="muted small">vars 里的空字符串视为「未提供」。键为空的行会被忽略。</div>
            <KvEditor rows={varsRows} onChange={setVarsRows} highlightKeys={placeholders} emptyHint="暂无变量" />
            <div className="btn-row">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVarsRows((r) => addMissingKeys(r, placeholders))}>
                按占位符补全键
              </button>
            </div>
          </div>
          <div className="card-body border-top">
            <div className="subhead">stepVars（按步覆盖）</div>
            <div className="muted small">
              某一步给了值，从这一步起后续步骤都使用新值，直到更晚的步骤再次给值；stepVars 里的空字符串表示「这一步不改」。
            </div>
            {steps.map((s) => {
              const k = String(s.index);
              const rows = stepRows[k] ?? [];
              return (
                <details key={k} className="step-vars" open={rows.length > 0}>
                  <summary>
                    第 {s.index} 步 <span className="muted small mono">{s.text}</span>
                    {rows.filter((r) => r.key.trim()).length > 0 ? <Badge tone="blue">{rows.filter((r) => r.key.trim()).length} 项</Badge> : null}
                  </summary>
                  <KvEditor
                    rows={rows}
                    onChange={(next) => setStepRows((prev) => ({ ...prev, [k]: next }))}
                    highlightKeys={extractPlaceholders(s.text)}
                    valuePlaceholder="值（空字符串 = 这一步不改）"
                  />
                </details>
              );
            })}
          </div>
          <div className="card-body border-top">
            {allErrors.length > 0 ? <div className="alert alert-warning">请先修正键名错误（{allErrors.length} 处）。</div> : null}
            <SequenceError error={pf.error} groupId={groupId} activeRunId={activeRunId} />
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={runPreflight} disabled={pf.isPending || allErrors.length > 0}>
                {pf.isPending ? '预检中…' : '预检'}
              </button>
              <span className="muted small">预检通过后在弹窗中确认启动。</span>
            </div>
          </div>
        </div>
      ) : null}

      {preflight ? (
        <PreflightModal
          result={preflight.result}
          request={preflight.request}
          sequence={selected}
          groupId={groupId}
          activeRunId={activeRunId}
          onClose={() => setPreflight(null)}
          onStarted={(runId) => {
            setPreflight(null);
            setStartedRunId(runId);
          }}
        />
      ) : null}

      {startedRunId ? (
        <div className="card">
          <div className="card-head">
            <h2>本次运行进度</h2>
            <span className="spacer" />
            <Link to={`/sequence-runs/${encodeURIComponent(startedRunId)}`} className="btn btn-sm">
              打开详情页
            </Link>
          </div>
          <div className="card-body">
            <SequenceRunProgress runId={startedRunId} />
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>该群的序列运行</h2>
        </div>
        {runs.error ? <ErrorBox error={runs.error} compact /> : null}
        {runs.isLoading ? <Loading /> : null}
        {runs.data && runs.data.length === 0 ? <Empty>暂无</Empty> : null}
        {runs.data && runs.data.length > 0 ? (
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
              {runs.data.map((r) => (
                <tr key={r.id} className={r.id === startedRunId ? 'row-current' : undefined}>
                  <td>
                    <Link to={`/sequence-runs/${encodeURIComponent(r.id)}`} className="mono">
                      {r.id}
                    </Link>
                  </td>
                  <td>{r.sequenceName ?? <Mono>{r.sequenceId}</Mono>}</td>
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
    </div>
  );
}
