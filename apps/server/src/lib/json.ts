/**
 * 序列化为可以写进 jsonb 的字符串。PostgreSQL 的 jsonb 不接受 \u0000，这里把它替换为空串，
 * 避免一条外部输入里的 NUL 字符让整笔事务失败。
 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/(?<!\\)\\u0000/g, '');
}

/** text 列同样不接受 NUL 字节 */
export function sanitizeText(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}

export function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
