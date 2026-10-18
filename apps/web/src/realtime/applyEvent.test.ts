import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyRealtimeEvent, type Notifier } from './applyEvent';
import { qk } from '../api/queryKeys';
import type { Account, MessageItem } from '../api/types';
import { mergeLatestPage, type TimelineState } from '../lib/timeline';

function notifier(): Notifier & { pushed: unknown[]; recorded: unknown[] } {
  const pushed: unknown[] = [];
  const recorded: unknown[] = [];
  return {
    pushed,
    recorded,
    push: (n) => pushed.push(n),
    recordInconsistency: (r) => recorded.push(r),
  };
}

function item(id: string, extra: Partial<MessageItem> = {}): MessageItem {
  return {
    id,
    msgId: `m${id}`,
    clientMsgId: null,
    senderPlatformUserId: 'u',
    senderAccountId: null,
    isOwn: false,
    text: id,
    sentAt: `2026-09-26T08:00:0${id}.000Z`,
    deliveryStatus: null,
    failCode: null,
    mediaUrl: null,
    localFilePath: null,
    source: 'inbound',
    ...extra,
  };
}

describe('applyRealtimeEvent', () => {
  it('account_status_changed 用 account 更新账号列表缓存', () => {
    const qc = new QueryClient();
    const accounts: Account[] = [
      { id: 'a1', status: 'online', platformUserId: 'p1', rateLimitedUntil: null },
      { id: 'a2', status: 'idle', platformUserId: null, rateLimitedUntil: null },
    ];
    qc.setQueryData(qk.accounts(), accounts);
    applyRealtimeEvent(
      qc,
      {
        seq: 1,
        type: 'account_status_changed',
        payload: {
          accountId: 'a1',
          from: 'online',
          to: 'rate_limited',
          account: { id: 'a1', status: 'rate_limited', platformUserId: 'p1', rateLimitedUntil: '2026-09-26T08:01:00.000Z' },
        },
      },
      notifier(),
    );
    const next = qc.getQueryData<Account[]>(qk.accounts())!;
    expect(next[0]).toMatchObject({ status: 'rate_limited', rateLimitedUntil: '2026-09-26T08:01:00.000Z' });
    expect(next[1]).toBe(accounts[1]);
  });

  it('message 事件 upsert 到已打开的时间线；未加载的群不建缓存', () => {
    const qc = new QueryClient();
    qc.setQueryData<TimelineState>(qk.timeline('g1'), mergeLatestPage(undefined, { items: [item('1')], nextCursor: null }, 0, 0));
    const n = notifier();
    applyRealtimeEvent(qc, { seq: 2, type: 'message', payload: { groupId: 'g1', id: '2', item: item('2') } }, n, 10);
    applyRealtimeEvent(qc, { seq: 3, type: 'message', payload: { groupId: 'g1', id: '2', item: item('2', { text: 'edited' }) } }, n, 11);
    applyRealtimeEvent(qc, { seq: 4, type: 'message', payload: { groupId: 'g2', id: '9', item: item('9') } }, n, 12);
    const s = qc.getQueryData<TimelineState>(qk.timeline('g1'))!;
    expect(s.items.map((m) => m.id)).toEqual(['2', '1']);
    expect(s.items[0].text).toBe('edited');
    expect(qc.getQueryData(qk.timeline('g2'))).toBeUndefined();

    applyRealtimeEvent(qc, { seq: 5, type: 'message_removed', payload: { groupId: 'g1', id: '1' } }, n, 13);
    expect(qc.getQueryData<TimelineState>(qk.timeline('g1'))!.items.map((m) => m.id)).toEqual(['2']);
  });

  it('inconsistency 记录到页头并弹醒目通知；agent_run blocked 弹醒目通知', () => {
    const qc = new QueryClient();
    const n = notifier();
    applyRealtimeEvent(qc, { seq: 1, type: 'inconsistency', payload: { kind: 'inbox', ref: 'e:12', message: 'db write failed' } }, n);
    expect(n.recorded).toEqual([{ kind: 'inbox', ref: 'e:12', message: 'db write failed' }]);
    expect(n.pushed).toHaveLength(1);
    applyRealtimeEvent(
      qc,
      { seq: 2, type: 'agent_run', payload: { runId: 'r1', groupId: 'g1', status: 'blocked', endReason: 'audit_blocked' } },
      n,
    );
    expect(n.pushed).toHaveLength(2);
    expect(n.pushed[1]).toMatchObject({ level: 'error', sticky: true });
    applyRealtimeEvent(qc, { seq: 3, type: 'agent_run', payload: { runId: 'r2', groupId: 'g1', status: 'finished' } }, n);
    expect(n.pushed).toHaveLength(2);
  });

  it('sequence_run / group_updated / job 失效对应查询，且不误伤时间线', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const n = notifier();
    applyRealtimeEvent(qc, { seq: 1, type: 'sequence_run', payload: { runId: 's1', groupId: 'g1', status: 'running' } }, n);
    applyRealtimeEvent(qc, { seq: 2, type: 'group_updated', payload: { groupId: 'g1' } }, n);
    applyRealtimeEvent(qc, { seq: 3, type: 'job', payload: { jobId: 'j1', type: 'create_group', status: 'finished', groupId: 'g1' } }, n);
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(qk.seqRun('s1')),
        JSON.stringify(qk.seqRunsByGroup('g1')),
        JSON.stringify(qk.group('g1')),
        JSON.stringify(qk.groupsList()),
        JSON.stringify(qk.job('j1')),
      ]),
    );
    expect(keys.some((k) => k.includes('timeline'))).toBe(false);
  });
});
