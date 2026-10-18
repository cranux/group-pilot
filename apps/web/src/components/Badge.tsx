import type { ReactNode } from 'react';
import { lookup, type Tone } from '../lib/labels';

export function Badge({ tone = 'gray', children, title, strong }: { tone?: Tone; children: ReactNode; title?: string; strong?: boolean }) {
  return (
    <span className={`badge badge-${tone}${strong ? ' badge-strong' : ''}`} title={title}>
      {children}
    </span>
  );
}

/** 根据标签表渲染状态徽标，title 显示原始值。 */
export function StatusBadge({
  table,
  value,
  showRaw,
  strong,
}: {
  table: Parameters<typeof lookup>[0];
  value: string | null | undefined;
  showRaw?: boolean;
  strong?: boolean;
}) {
  const def = lookup(table, value);
  return (
    <Badge tone={def.tone} title={value ?? undefined} strong={strong}>
      {def.label}
      {showRaw && value ? <span className="badge-raw">{value}</span> : null}
    </Badge>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="mono" title={title}>
      {children}
    </span>
  );
}
