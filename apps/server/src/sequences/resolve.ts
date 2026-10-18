export interface SequenceStepDef {
  index: number;
  accountRole: 'admin' | 'member';
  text: string;
  delaySeconds: number;
}

export interface ResolvedStep extends SequenceStepDef {
  resolvedText: string;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
}

export type ResolveResult = { ok: true; steps: ResolvedStep[] } | { ok: false; stepIndex: number; key: string };

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** 文本里出现的占位符 key（按出现顺序去重） */
export function placeholders(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!keys.includes(m[1])) keys.push(m[1]);
  return keys;
}

/**
 * 预检 / 解析：
 * - 开始时的取值 = vars（vars 里的 "" 视为未提供）；
 * - 某一步在 stepVars 里给了值，从这一步起后续步骤都用新值，直到更晚的步骤再次给值；stepVars 里的 "" 表示这一步不改；
 * - varSources 标 default 或 step:<index>（沿用前面某步的值时，标最初给出它的那一步）。
 * 任何一步有解析不到的占位符 → 返回第一个（按步骤顺序、文本中出现顺序）。
 */
export function resolveSequence(
  steps: SequenceStepDef[],
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): ResolveResult {
  const current = new Map<string, { value: string; source: string }>();
  for (const [k, v] of Object.entries(vars)) if (v !== '') current.set(k, { value: v, source: 'default' });
  const resolved: ResolvedStep[] = [];
  for (const step of steps) {
    for (const [k, v] of Object.entries(stepVars[String(step.index)] ?? {})) {
      if (v !== '') current.set(k, { value: v, source: `step:${step.index}` });
    }
    const keys = placeholders(step.text);
    const missing = keys.find((k) => !current.has(k));
    if (missing !== undefined) return { ok: false, stepIndex: step.index, key: missing };
    const resolvedVars: Record<string, string> = {};
    const varSources: Record<string, string> = {};
    for (const k of keys) {
      resolvedVars[k] = current.get(k)!.value;
      varSources[k] = current.get(k)!.source;
    }
    resolved.push({
      ...step,
      resolvedText: step.text.replace(PLACEHOLDER, (_, k: string) => current.get(k)!.value),
      resolvedVars,
      varSources,
    });
  }
  return { ok: true, steps: resolved };
}
