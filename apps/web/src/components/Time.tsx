import { useNow } from '../hooks/useNow';
import { formatCountdown, formatDateTime } from '../lib/format';

export function DateTime({ value }: { value: string | null | undefined }) {
  return (
    <span className="nowrap" title={value ?? undefined}>
      {formatDateTime(value)}
    </span>
  );
}

/** 截止时间倒计时；到期后显示 expiredText。 */
export function Countdown({ until, expiredText = '已到期', prefix = '' }: { until: string | null | undefined; expiredText?: string; prefix?: string }) {
  const now = useNow();
  if (!until) return <span className="muted">—</span>;
  const text = formatCountdown(until, now);
  return (
    <span className="nowrap" title={formatDateTime(until)}>
      {text ? (
        <span className="countdown">
          {prefix}
          {text}
        </span>
      ) : (
        <span className="muted">{expiredText}</span>
      )}
    </span>
  );
}
