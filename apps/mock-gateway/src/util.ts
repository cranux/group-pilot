import type { Range } from './config.js';

export function randInt(min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function randIn(range: Range): number {
  return randInt(range[0], range[1]);
}

/** 业务错误：统一以扁平结构 `{ code, message, ...extra }` 返回 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** 可整体取消的定时器集合：reset / close 时清空，避免残留回调 */
export class Scheduler {
  private readonly timers = new Set<NodeJS.Timeout>();

  after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (err) {
        console.error('[mock-gateway] scheduled task failed', err);
      }
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => this.after(ms, resolve));
  }

  cancelAll(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
