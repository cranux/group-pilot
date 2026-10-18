import type { SequenceRunRequest, SequenceStepDef, StepVarRecord, VarRecord } from '../api/types';

/**
 * 序列启动参数（vars / stepVars）编辑器的纯逻辑。
 *
 * 语义（题目 B1）：
 * - vars 里的 "" 视为未提供；stepVars 里的 "" 表示这一步不改；
 *   两者都由服务端解释，前端**不丢弃空值行**，原样提交；
 * - 键为空（去掉首尾空白后）的行忽略；
 * - 键须匹配 [A-Za-z0-9_]+。
 */

export interface KvRow {
  /** 仅用于 React key */
  rowId: string;
  key: string;
  value: string;
}

export const VAR_KEY_PATTERN = /^[A-Za-z0-9_]+$/;
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

let rowSeq = 0;
export function newRow(key = '', value = ''): KvRow {
  rowSeq += 1;
  return { rowId: `r${rowSeq}`, key, value };
}

/** 文本中的占位符，按出现顺序去重。 */
export function extractPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 整个序列用到的占位符（按步骤顺序去重）。 */
export function sequencePlaceholders(steps: SequenceStepDef[]): string[] {
  const out: string[] = [];
  for (const s of [...steps].sort((a, b) => a.index - b.index)) {
    for (const k of extractPlaceholders(s.text)) if (!out.includes(k)) out.push(k);
  }
  return out;
}

export interface RowIssue {
  rowId: string;
  message: string;
}

/** 校验键：格式错误、重复。键为空的行只在有值时给出提示（不阻止提交）。 */
export function validateRows(rows: KvRow[]): { errors: RowIssue[]; warnings: RowIssue[] } {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) {
      if (r.value !== '') warnings.push({ rowId: r.rowId, message: '键为空，该行将被忽略' });
      continue;
    }
    if (!VAR_KEY_PATTERN.test(key)) {
      errors.push({ rowId: r.rowId, message: '键只能包含字母、数字和下划线' });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ rowId: r.rowId, message: `键「${key}」重复` });
      continue;
    }
    seen.set(key, r.rowId);
  }
  return { errors, warnings };
}

/** 行 → 记录：忽略空键行，保留空字符串值。 */
export function rowsToRecord(rows: KvRow[]): VarRecord {
  const out: VarRecord = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    out[key] = r.value;
  }
  return out;
}

/** 按步骤的行 → stepVars；没有任何有效键的步骤省略。键为步骤 index 的字符串。 */
export function buildStepVars(stepRows: Record<string, KvRow[]>): StepVarRecord {
  const out: StepVarRecord = {};
  for (const [index, rows] of Object.entries(stepRows)) {
    const rec = rowsToRecord(rows);
    if (Object.keys(rec).length > 0) out[String(index)] = rec;
  }
  return out;
}

export function buildSequenceRunRequest(
  sequenceId: string,
  varsRows: KvRow[],
  stepRows: Record<string, KvRow[]>,
): SequenceRunRequest {
  return { sequenceId, vars: rowsToRecord(varsRows), stepVars: buildStepVars(stepRows) };
}

/** 给编辑器补上缺失的占位符键（值为空）；已有的键不动。 */
export function addMissingKeys(rows: KvRow[], keys: string[]): KvRow[] {
  const present = new Set(rows.map((r) => r.key.trim()).filter(Boolean));
  const extra = keys.filter((k) => !present.has(k)).map((k) => newRow(k, ''));
  // 去掉完全空白的占位行，再追加
  const kept = extra.length ? rows.filter((r) => r.key.trim() !== '' || r.value !== '') : rows;
  return extra.length ? [...kept, ...extra] : rows;
}

/** varSources 值的中文说明：default → 默认值（vars）；step:<n> → 第 n 步。 */
export function describeVarSource(source: string | undefined | null): string {
  if (!source) return '—';
  if (source === 'default') return '默认值（vars）';
  const m = /^step:(\d+)$/.exec(source);
  if (m) return `第 ${m[1]} 步（stepVars）`;
  return source;
}

/** 序列 JSON 文本的基本校验（结构由服务端最终校验）。 */
export function parseSequenceJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '序列必须是 JSON 对象' };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || !v.name.trim()) return { ok: false, error: '缺少 name（字符串）' };
  if (!Array.isArray(v.steps) || v.steps.length === 0) return { ok: false, error: 'steps 必须是非空数组' };
  for (const [i, s] of (v.steps as unknown[]).entries()) {
    if (!s || typeof s !== 'object') return { ok: false, error: `steps[${i}] 必须是对象` };
    const st = s as Record<string, unknown>;
    if (typeof st.index !== 'number') return { ok: false, error: `steps[${i}].index 必须是数字` };
    if (st.accountRole !== 'admin' && st.accountRole !== 'member') {
      return { ok: false, error: `steps[${i}].accountRole 必须是 admin 或 member` };
    }
    if (typeof st.text !== 'string') return { ok: false, error: `steps[${i}].text 必须是字符串` };
    if (typeof st.delaySeconds !== 'number' || st.delaySeconds < 0) {
      return { ok: false, error: `steps[${i}].delaySeconds 必须是非负数字` };
    }
  }
  return { ok: true, value };
}

export const SEQUENCE_EXAMPLE = `{
  "name": "活动提醒",
  "steps": [
    { "index": 1, "accountRole": "admin",  "text": "{event} 将于 {time} 开始，请提前准备", "delaySeconds": 10 },
    { "index": 2, "accountRole": "member", "text": "提醒：{event} 的资料已上传到 {location}", "delaySeconds": 5 }
  ]
}`;
