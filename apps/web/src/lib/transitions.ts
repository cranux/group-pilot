import type { AccountStatus } from '../api/types';

/** 账号状态转移表（题目 A1，行 = 当前状态，值 = 允许去的状态）。与后端同一份语义。 */
export const ACCOUNT_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

export const ALL_ACCOUNT_STATUSES = Object.keys(ACCOUNT_TRANSITIONS) as AccountStatus[];

export function isAccountStatus(v: unknown): v is AccountStatus {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ACCOUNT_TRANSITIONS, v);
}

export function canTransition(from: AccountStatus | string, to: AccountStatus | string): boolean {
  if (!isAccountStatus(from) || !isAccountStatus(to)) return false;
  return ACCOUNT_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: AccountStatus | string): boolean {
  return status === 'suspended' || status === 'session_expired';
}

export type AccountAction =
  | { kind: 'markOffline'; label: '标记离线'; to: 'disconnected' }
  | { kind: 'reconnect'; label: '重连' }
  | { kind: 'release'; label: '释放账号'; to: 'idle' };

/**
 * 账号列表页的三个操作按钮，仅在对应转移合法时出现：
 * - 标记离线 = transition 到 disconnected；
 * - 重连 = 调 connect（只在 idle / disconnected 时，即 → online 的手动转移）；
 * - 释放账号 = transition 到 idle。
 */
export function availableAccountActions(status: AccountStatus | string): AccountAction[] {
  const actions: AccountAction[] = [];
  if (canTransition(status, 'disconnected')) actions.push({ kind: 'markOffline', label: '标记离线', to: 'disconnected' });
  if ((status === 'idle' || status === 'disconnected') && canTransition(status, 'online')) {
    actions.push({ kind: 'reconnect', label: '重连' });
  }
  if (canTransition(status, 'idle')) actions.push({ kind: 'release', label: '释放账号', to: 'idle' });
  return actions;
}
