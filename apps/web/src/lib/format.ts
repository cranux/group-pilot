// 时间显示与倒计时（纯函数）。

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm:ss`；null / 非法 → '—'。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ISO 时间 → 本地 `HH:mm:ss.SSS`（时间线用，毫秒精度）。 */
export function formatTimeMs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 剩余毫秒数；无值或已过期返回 0。 */
export function remainingMs(untilIso: string | null | undefined, nowMs: number): number {
  if (!untilIso) return 0;
  const t = Date.parse(untilIso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - nowMs);
}

/** 毫秒 → `1时02分03秒` / `2分05秒` / `9秒`（向上取整到秒）。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}时${pad(m)}分${pad(s)}秒`;
  if (m > 0) return `${m}分${pad(s)}秒`;
  return `${s}秒`;
}

/** 倒计时文本；已到期返回 null。 */
export function formatCountdown(untilIso: string | null | undefined, nowMs: number): string | null {
  const ms = remainingMs(untilIso, nowMs);
  if (ms <= 0) return null;
  return formatDuration(ms);
}

/** 两个时间点之间的耗时文本。 */
export function formatElapsed(fromIso: string | null | undefined, toIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) return '—';
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '—';
  const to = toIso ? Date.parse(toIso) : nowMs;
  if (Number.isNaN(to)) return '—';
  return formatDuration(Math.max(0, to - from));
}

/** 截断长文本。 */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 格式化任意值为 JSON 文本（字符串若本身是 JSON 则美化）。 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 单行 JSON 预览。 */
export function compactJson(value: unknown, max = 80): string {
  if (value === undefined || value === null) return String(value);
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return truncate(s, max);
}
