import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { Job } from '../api/types';
import { ErrorBox } from './ErrorBox';
import { StatusBadge, Mono } from './Badge';
import { ERROR_HINTS, JOB_STATUS, JOB_TYPE, describeJobStep } from '../lib/labels';

/** 建群 / 退群 job 的进度：WS `job` 事件失效 + 1s 轮询兜底，直到结束。 */
export function JobProgress({ jobId, onFinished, onDismiss }: { jobId: string; onFinished?: (job: Job) => void; onDismiss?: () => void }) {
  const q = useQuery({
    queryKey: qk.job(jobId),
    queryFn: () => api.getJob(jobId),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'running' ? false : 1000),
    refetchIntervalInBackground: true,
  });
  const job = q.data;
  const notified = useRef(false);

  useEffect(() => {
    if (job && job.status !== 'running' && !notified.current) {
      notified.current = true;
      onFinished?.(job);
    }
  }, [job, onFinished]);

  return (
    <div className={`job-card job-${job?.status ?? 'loading'}`}>
      <div className="job-head">
        <strong>{job ? (JOB_TYPE[job.type] ?? job.type) : '任务'}</strong>
        <Mono>{jobId}</Mono>
        {job ? <StatusBadge table={JOB_STATUS} value={job.status} /> : <span className="muted">查询中…</span>}
        {job?.status === 'running' ? <span className="spinner" aria-hidden="true" /> : null}
        {job?.groupId ? (
          <Link to={`/groups/${encodeURIComponent(job.groupId)}`} className="small">
            查看群 {job.groupId}
          </Link>
        ) : null}
        {onDismiss && job && job.status !== 'running' ? (
          <button type="button" className="btn btn-ghost btn-sm job-dismiss" onClick={onDismiss}>
            关闭
          </button>
        ) : null}
      </div>
      {q.error ? <ErrorBox error={q.error} compact /> : null}
      {job && job.errors.length > 0 ? (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>失败步骤</th>
              <th>说明</th>
              <th>错误码</th>
            </tr>
          </thead>
          <tbody>
            {job.errors.map((e, i) => (
              <tr key={`${e.step}-${i}`}>
                <td>
                  <Mono>{e.step}</Mono>
                </td>
                <td>{describeJobStep(e.step)}</td>
                <td>
                  <code className="err-code">{e.code}</code>
                  {ERROR_HINTS[e.code] ? <span className="muted small"> {ERROR_HINTS[e.code]}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
