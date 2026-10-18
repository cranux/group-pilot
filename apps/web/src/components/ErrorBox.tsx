import type { ReactNode } from 'react';
import { describeError } from '../api/errors';
import { ERROR_HINTS } from '../lib/labels';

/** 展示 API 错误的 code 与 message（以及 requestId 与业务字段）。 */
export function ErrorBox({ error, title, children, compact }: { error: unknown; title?: string; children?: ReactNode; compact?: boolean }) {
  if (!error) return null;
  const { code, message, requestId, details } = describeError(error);
  const hint = ERROR_HINTS[code];
  const extra = Object.entries(details).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object');
  return (
    <div className={`alert alert-error${compact ? ' alert-compact' : ''}`} role="alert">
      {title ? <div className="alert-title">{title}</div> : null}
      <div>
        <code className="err-code">{code}</code> <span>{message}</span>
        {hint ? <span className="muted">（{hint}）</span> : null}
      </div>
      {extra.length > 0 ? (
        <div className="err-details">
          {extra.map(([k, v]) => (
            <span key={k}>
              {k} = <code>{String(v)}</code>
            </span>
          ))}
        </div>
      ) : null}
      {children}
      {requestId ? <div className="err-reqid">requestId: {requestId}</div> : null}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const { code, message } = describeError(error);
  return (
    <span className="inline-error" title={message}>
      <code>{code}</code> {message}
    </span>
  );
}
