import { useMemo } from 'react';
import { newRow, validateRows, type KvRow } from '../lib/vars';

/**
 * 键值编辑器。空值行原样保留（"" 有语义），键为空的行在提交时忽略。
 */
export function KvEditor({
  rows,
  onChange,
  disabled,
  valuePlaceholder = '值（可为空字符串）',
  emptyHint,
  highlightKeys,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  disabled?: boolean;
  valuePlaceholder?: string;
  emptyHint?: string;
  /** 需要高亮的键（例如该步文本中出现的占位符）。 */
  highlightKeys?: string[];
}) {
  const { errors, warnings } = useMemo(() => validateRows(rows), [rows]);
  const issueFor = (rowId: string) =>
    errors.find((e) => e.rowId === rowId) ?? warnings.find((w) => w.rowId === rowId);

  const update = (rowId: string, patch: Partial<KvRow>) =>
    onChange(rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));

  return (
    <div className="kv-editor">
      {rows.length === 0 && emptyHint ? <div className="muted small">{emptyHint}</div> : null}
      {rows.map((r) => {
        const issue = issueFor(r.rowId);
        const isError = errors.some((e) => e.rowId === r.rowId);
        const hl = highlightKeys?.includes(r.key.trim());
        return (
          <div className="kv-row" key={r.rowId}>
            <input
              className={`input mono kv-key${isError ? ' input-error' : ''}${hl ? ' kv-key-hl' : ''}`}
              placeholder="键"
              value={r.key}
              disabled={disabled}
              onChange={(e) => update(r.rowId, { key: e.target.value })}
            />
            <span className="kv-eq">=</span>
            <input
              className="input kv-value"
              placeholder={valuePlaceholder}
              value={r.value}
              disabled={disabled}
              onChange={(e) => update(r.rowId, { value: e.target.value })}
            />
            <span className="kv-flag" title={r.value === '' ? '空字符串' : undefined}>
              {r.key.trim() && r.value === '' ? '""' : ''}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => onChange(rows.filter((x) => x.rowId !== r.rowId))}
              title="删除该行"
            >
              删除
            </button>
            {issue ? <div className={`kv-issue ${isError ? 'text-error' : 'muted'}`}>{issue.message}</div> : null}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange([...rows, newRow()])}>
        + 添加一行
      </button>
    </div>
  );
}
