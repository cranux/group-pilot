import { describe, expect, it } from 'vitest';
import { ACCOUNT_TRANSITIONS, ALL_ACCOUNT_STATUSES, availableAccountActions, canTransition, isTerminal } from './transitions';

// 题目 A1 的表格，逐格对照（✔ = 允许）
const TABLE: Record<string, string> = {
  //            idle online rate_limited disconnected suspended session_expired
  idle: '        .    Y      .            .            Y         Y',
  online: '      Y    .      Y            Y            Y         Y',
  rate_limited: '.    Y      .            Y            Y         Y',
  disconnected: 'Y    Y      .            .            Y         Y',
  suspended: '   .    .      .            .            .         .',
  session_expired: '. . . . . .',
};
const COLS = ['idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired'];

describe('账号转移表', () => {
  it('与题目 A1 表格逐格一致（含同状态到同状态非法）', () => {
    for (const from of COLS) {
      const cells = TABLE[from].trim().split(/\s+/);
      expect(cells).toHaveLength(6);
      COLS.forEach((to, i) => {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(cells[i] === 'Y');
      });
    }
  });

  it('终态没有出边', () => {
    expect(ACCOUNT_TRANSITIONS.suspended).toEqual([]);
    expect(ACCOUNT_TRANSITIONS.session_expired).toEqual([]);
    expect(isTerminal('suspended')).toBe(true);
    expect(isTerminal('session_expired')).toBe(true);
    expect(isTerminal('online')).toBe(false);
  });

  it('未知状态一律非法', () => {
    expect(canTransition('nope', 'online')).toBe(false);
    expect(canTransition('online', 'nope')).toBe(false);
    expect(ALL_ACCOUNT_STATUSES).toHaveLength(6);
  });
});

describe('availableAccountActions', () => {
  const kinds = (s: string) => availableAccountActions(s).map((a) => a.kind);

  it('online：标记离线 + 释放', () => {
    expect(kinds('online')).toEqual(['markOffline', 'release']);
  });
  it('rate_limited：只能标记离线（不能直接释放，到 online 是自动恢复）', () => {
    expect(kinds('rate_limited')).toEqual(['markOffline']);
  });
  it('idle：只能重连', () => {
    expect(kinds('idle')).toEqual(['reconnect']);
  });
  it('disconnected：重连 + 释放', () => {
    expect(kinds('disconnected')).toEqual(['reconnect', 'release']);
  });
  it('终态：没有按钮', () => {
    expect(kinds('suspended')).toEqual([]);
    expect(kinds('session_expired')).toEqual([]);
  });
});
