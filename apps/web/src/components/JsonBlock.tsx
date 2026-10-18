import { compactJson, prettyJson } from '../lib/format';

/** 可折叠的格式化 JSON。 */
export function JsonBlock({ value, open, previewMax = 60 }: { value: unknown; open?: boolean; previewMax?: number }) {
  if (value === undefined || value === null) return <span className="muted">null</span>;
  return (
    <details className="json-block" open={open}>
      <summary className="mono">{compactJson(value, previewMax)}</summary>
      <pre className="code">{prettyJson(value)}</pre>
    </details>
  );
}

/** 原样展示的文本（等宽、保留空白与换行，不做任何格式化）。 */
export function RawText({ text }: { text: string | null | undefined }) {
  if (text === null || text === undefined) return <span className="muted">（无原始响应）</span>;
  return <pre className="code raw">{text}</pre>;
}
