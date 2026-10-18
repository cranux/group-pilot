/** 网关时序与故障配置。时序数字来自题目 2.1，是外部契约的一部分。 */

export type Range = [number, number];

export interface TimingConfig {
  /** invite 返回的 readyAfterMs 取值范围 */
  inviteReadyAfterMs: Range;
  /** 邀请链接存活时间；null = 不过期 */
  inviteTtlMs: number | null;
  /** join 202 之后多久真正入群 */
  joinDelayMs: Range;
  /** 成员列表变化后多久推 member_joined / member_left */
  memberEventLagMs: number;
  /** send 的 202 多久返回 */
  sendAcceptDelayMs: Range;
  /** 受理后多久落地并推 message_sent */
  messageSentDelayMs: Range;
  /** kick 响应耗时 */
  kickDelayMs: Range;
}

export interface RateLimitConfig {
  maxPerWindow: number;
  windowMs: number;
  retryAfterSeconds: number;
}

export interface GatewayConfig {
  timing: TimingConfig;
  /** 0~1，每个事件被重复推送的概率 */
  duplicateEvents: number;
  /** 0 = 不乱序；>0 时 SSE 输出侧在该窗口内随机交换相邻事件顺序（≤ 1000） */
  reorderWindowMs: number;
  /** join 受理后永远不入群的概率 */
  dropJoinProbability: number;
  /** true 时所有非 /_control 端点返回 503 */
  unavailable: boolean;
  /** 自动限流；null = 关闭 */
  rateLimit: RateLimitConfig | null;
  /**
   * 扩展字段：随机故障（2% 请求 503、send 5% 返回 504 且其中一半实际落地、
   * 约每 60s 断一次 SSE、邀请链接 TTL 随机 5–30s）。main.ts 在 CHAOS=1 时开启。
   */
  chaos: boolean;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export const DEFAULT_TIMING: TimingConfig = {
  inviteReadyAfterMs: [0, 2000],
  inviteTtlMs: null,
  joinDelayMs: [100, 1500],
  memberEventLagMs: 20,
  sendAcceptDelayMs: [0, 1500],
  messageSentDelayMs: [50, 2000],
  kickDelayMs: [1000, 5000],
};

/** 测试用：所有延迟都在几十毫秒内 */
export const FAST_TIMING: TimingConfig = {
  inviteReadyAfterMs: [0, 0],
  inviteTtlMs: null,
  joinDelayMs: [20, 60],
  memberEventLagMs: 10,
  sendAcceptDelayMs: [0, 20],
  messageSentDelayMs: [20, 60],
  kickDelayMs: [20, 60],
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxPerWindow: 5,
  windowMs: 1000,
  retryAfterSeconds: 3,
};

export const DEFAULT_CONFIG: GatewayConfig = {
  timing: DEFAULT_TIMING,
  duplicateEvents: 0,
  reorderWindowMs: 0,
  dropJoinProbability: 0,
  unavailable: false,
  rateLimit: null,
  chaos: false,
};

export class ConfigError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (patch === undefined) return target;
  if (!isPlainObject(patch)) return patch;
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    base[k] = deepMerge(base[k], v);
  }
  return base;
}

export function cloneConfig(c: GatewayConfig): GatewayConfig {
  return JSON.parse(JSON.stringify(c)) as GatewayConfig;
}

function checkRange(name: string, v: unknown): Range {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) {
    throw new ConfigError(`${name} 必须是两个非负数组成的 [min, max]`);
  }
  const [a, b] = v as [number, number];
  if (a > b) throw new ConfigError(`${name} 的 min 不能大于 max`);
  return [a, b];
}

function checkNumber(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${name} 必须是 ${min}~${max} 之间的数`);
  }
  return v;
}

function normalize(raw: unknown): GatewayConfig {
  if (!isPlainObject(raw)) throw new ConfigError('config 必须是对象');
  const t = raw.timing;
  if (!isPlainObject(t)) throw new ConfigError('timing 必须是对象');
  const ttl = t.inviteTtlMs;
  if (ttl !== null && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0)) {
    throw new ConfigError('timing.inviteTtlMs 必须是非负数或 null');
  }
  const timing: TimingConfig = {
    inviteReadyAfterMs: checkRange('timing.inviteReadyAfterMs', t.inviteReadyAfterMs),
    inviteTtlMs: ttl as number | null,
    joinDelayMs: checkRange('timing.joinDelayMs', t.joinDelayMs),
    memberEventLagMs: checkNumber('timing.memberEventLagMs', t.memberEventLagMs, 0, 60_000),
    sendAcceptDelayMs: checkRange('timing.sendAcceptDelayMs', t.sendAcceptDelayMs),
    messageSentDelayMs: checkRange('timing.messageSentDelayMs', t.messageSentDelayMs),
    kickDelayMs: checkRange('timing.kickDelayMs', t.kickDelayMs),
  };

  let rateLimit: RateLimitConfig | null = null;
  if (raw.rateLimit !== null && raw.rateLimit !== undefined) {
    if (!isPlainObject(raw.rateLimit)) throw new ConfigError('rateLimit 必须是对象或 null');
    const r = { ...DEFAULT_RATE_LIMIT, ...raw.rateLimit } as Record<string, unknown>;
    rateLimit = {
      maxPerWindow: checkNumber('rateLimit.maxPerWindow', r.maxPerWindow, 1, 1e9),
      windowMs: checkNumber('rateLimit.windowMs', r.windowMs, 1, 1e9),
      retryAfterSeconds: checkNumber('rateLimit.retryAfterSeconds', r.retryAfterSeconds, 0, 86_400),
    };
  }

  if (typeof raw.unavailable !== 'boolean') throw new ConfigError('unavailable 必须是 boolean');
  if (typeof raw.chaos !== 'boolean') throw new ConfigError('chaos 必须是 boolean');

  return {
    timing,
    duplicateEvents: checkNumber('duplicateEvents', raw.duplicateEvents, 0, 1),
    reorderWindowMs: Math.min(1000, checkNumber('reorderWindowMs', raw.reorderWindowMs, 0, Number.MAX_SAFE_INTEGER)),
    dropJoinProbability: checkNumber('dropJoinProbability', raw.dropJoinProbability, 0, 1),
    unavailable: raw.unavailable,
    rateLimit,
    chaos: raw.chaos,
  };
}

/** 深合并 patch 到 base（数组整体替换，null 覆盖），并校验。失败抛 ConfigError。 */
export function mergeConfig(base: GatewayConfig, patch: unknown): GatewayConfig {
  if (patch !== undefined && patch !== null && !isPlainObject(patch)) {
    throw new ConfigError('config patch 必须是对象');
  }
  return normalize(deepMerge(cloneConfig(base), patch ?? {}));
}
