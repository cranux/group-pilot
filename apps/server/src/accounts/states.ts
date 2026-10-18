export const ACCOUNT_STATUSES = ['idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<AccountStatus> = new Set(['suspended', 'session_expired']);

/** 题目 A1 的转移表（行 = 当前状态，值 = 允许的目标状态） */
export const TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

export function isAccountStatus(v: unknown): v is AccountStatus {
  return typeof v === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(v);
}

export function isLegalTransition(from: AccountStatus, to: AccountStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: AccountStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 网关错误码 → 账号终态 */
export function terminalStatusForGatewayCode(code: string): AccountStatus | null {
  if (code === 'ACCOUNT_SUSPENDED') return 'suspended';
  if (code === 'SESSION_EXPIRED') return 'session_expired';
  return null;
}
