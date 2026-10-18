import { describe, expect, it } from 'vitest';
import type { MessageItem } from '../api/types';
import {
  applyMessageEvent,
  applyMessageRemoved,
  compareIds,
  emptyTimeline,
  mergeLatestPage,
  mergeOlderPage,
  toDisplayOrder,
  upsertItems,
  type TimelineState,
} from './timeline';

function msg(id: string, sec: number, extra: Partial<MessageItem> = {}): MessageItem {
  return {
    id,
    msgId: `m${id}`,
    clientMsgId: null,
    senderPlatformUserId: 'u1',
    senderAccountId: null,
    isOwn: false,
    text: `text ${id}`,
    sentAt: new Date(Date.UTC(2026, 8, 26, 8, 0, sec)).toISOString(),
    deliveryStatus: null,
    failCode: null,
    mediaUrl: null,
    localFilePath: null,
    source: 'inbound',
    ...extra,
  };
}

const ids = (s: TimelineState) => s.items.map((m) => m.id);

describe('compareIds', () => {
  it('数字串按数值比较', () => {
    expect(compareIds('9', '10')).toBeLessThan(0);
    expect(compareIds('b', 'a')).toBeGreaterThan(0);
    expect(compareIds('7', '7')).toBe(0);
  });
});

describe('upsertItems', () => {
  it('按 sentAt 倒序、id 去重', () => {
    const out = upsertItems([msg('1', 1), msg('3', 3)], [msg('2', 2), msg('3', 3, { text: 'new' })], emptyTimeline());
    expect(out.map((m) => m.id)).toEqual(['3', '2', '1']);
    expect(out[0].text).toBe('new');
  });

  it('同一毫秒按 id 倒序稳定排序', () => {
    const out = upsertItems([], [msg('10', 5), msg('9', 5), msg('11', 5)], emptyTimeline());
    expect(out.map((m) => m.id)).toEqual(['11', '10', '9']);
  });

  it('自己的消息 sentAt 变化后重新排序，仍然只有一行', () => {
    const own = msg('5', 10, { isOwn: true, msgId: null, deliveryStatus: 'queued' });
    let items = upsertItems([], [own, msg('6', 11)], emptyTimeline());
    expect(items.map((m) => m.id)).toEqual(['6', '5']);
    items = upsertItems(items, [{ ...own, msgId: 'mx', sentAt: msg('x', 12).sentAt, deliveryStatus: 'sent' }], emptyTimeline());
    expect(items.map((m) => m.id)).toEqual(['5', '6']);
    expect(items[0].deliveryStatus).toBe('sent');
  });

  it('msgId 相同但 id 不同：新行替换旧行（孤儿回流合并）', () => {
    const orphan = msg('20', 5, { msgId: 'M1', isOwn: true });
    const outbound = msg('7', 5, { msgId: 'M1', isOwn: true, deliveryStatus: 'sent' });
    const out = upsertItems([orphan, msg('1', 1)], [outbound], emptyTimeline());
    expect(out.map((m) => m.id)).toEqual(['7', '1']);
  });
});

describe('mergeLatestPage / mergeOlderPage', () => {
  it('首次加载直接采用页数据与游标', () => {
    const s = mergeLatestPage(undefined, { items: [msg('3', 3), msg('2', 2)], nextCursor: 'c2' }, 0, 0);
    expect(ids(s)).toEqual(['3', '2']);
    expect(s.nextCursor).toBe('c2');
  });

  it('加载更早：合并且不重复，游标前进', () => {
    let s = mergeLatestPage(undefined, { items: [msg('4', 4), msg('3', 3)], nextCursor: 'c3' }, 0, 0);
    // 翻页期间新消息写入导致边界重叠：服务端返回了重复的 3
    s = mergeOlderPage(s, { items: [msg('3', 3), msg('2', 2), msg('1', 1)], nextCursor: null }, 'c3', 1, 1);
    expect(ids(s)).toEqual(['4', '3', '2', '1']);
    expect(s.nextCursor).toBeNull();
    expect(toDisplayOrder(s).map((m) => m.id)).toEqual(['1', '2', '3', '4']);
  });

  it('并发/重复翻页：游标已变化时不回退', () => {
    let s = mergeLatestPage(undefined, { items: [msg('4', 4)], nextCursor: 'c4' }, 0, 0);
    s = mergeOlderPage(s, { items: [msg('3', 3)], nextCursor: 'c3' }, 'c4', 1, 1);
    s = mergeOlderPage(s, { items: [msg('3', 3)], nextCursor: 'c3-dup' }, 'c4', 1, 1);
    expect(s.nextCursor).toBe('c3');
    expect(ids(s)).toEqual(['4', '3']);
  });

  it('重拉最新页不丢已加载的更早页，保留旧游标', () => {
    let s = mergeLatestPage(undefined, { items: [msg('4', 4), msg('3', 3)], nextCursor: 'c3' }, 0, 0);
    s = mergeOlderPage(s, { items: [msg('2', 2), msg('1', 1)], nextCursor: 'c1' }, 'c3', 1, 1);
    s = mergeLatestPage(s, { items: [msg('5', 5), msg('4', 4)], nextCursor: 'c4' }, 2, 2);
    expect(ids(s)).toEqual(['5', '4', '3', '2', '1']);
    expect(s.nextCursor).toBe('c1');
  });

  it('重拉最新页：服务端已全部返回时游标置空', () => {
    let s = mergeLatestPage(undefined, { items: [msg('2', 2)], nextCursor: 'c2' }, 0, 0);
    s = mergeLatestPage(s, { items: [msg('3', 3), msg('2', 2), msg('1', 1)], nextCursor: null }, 1, 1);
    expect(s.nextCursor).toBeNull();
    expect(ids(s)).toEqual(['3', '2', '1']);
  });

  it('请求发出后才到的 WS 更新不被旧页覆盖；WS 删除的行不被旧页复活', () => {
    let s = mergeLatestPage(undefined, { items: [msg('2', 2, { isOwn: true, deliveryStatus: 'accepted' })], nextCursor: null }, 0, 0);
    const fetchStartedAt = 100;
    // 请求发出之后 WS 推来 sent 状态 和 一条删除
    s = applyMessageEvent(s, msg('2', 2, { isOwn: true, deliveryStatus: 'sent' }), 150);
    s = applyMessageEvent(s, msg('9', 3), 150);
    s = applyMessageRemoved(s, '9', 160);
    // 旧页（请求发出时的快照）
    s = mergeLatestPage(
      s,
      { items: [msg('9', 3), msg('2', 2, { isOwn: true, deliveryStatus: 'accepted' })], nextCursor: null },
      fetchStartedAt,
      200,
    );
    expect(ids(s)).toEqual(['2']);
    expect(s.items[0].deliveryStatus).toBe('sent');
  });

  it('WS 更新早于请求发出时，以新页为准', () => {
    let s = mergeLatestPage(undefined, { items: [msg('2', 2, { deliveryStatus: 'accepted', isOwn: true })], nextCursor: null }, 0, 0);
    s = applyMessageEvent(s, msg('2', 2, { deliveryStatus: 'unknown', isOwn: true }), 50);
    s = mergeLatestPage(s, { items: [msg('2', 2, { deliveryStatus: 'sent', isOwn: true })], nextCursor: null }, 100, 120);
    expect(s.items[0].deliveryStatus).toBe('sent');
  });

  it('旧页里 msgId 相同的孤儿行不会和 WS 刚合并好的出站行同时出现', () => {
    let s = mergeLatestPage(undefined, { items: [msg('20', 5, { msgId: 'M1' })], nextCursor: null }, 0, 0);
    s = applyMessageEvent(s, msg('7', 5, { msgId: 'M1', isOwn: true, deliveryStatus: 'sent' }), 150);
    expect(ids(s)).toEqual(['7']);
    s = mergeLatestPage(s, { items: [msg('20', 5, { msgId: 'M1' })], nextCursor: null }, 100, 200);
    expect(ids(s)).toEqual(['7']);
  });
});

describe('applyMessageEvent / applyMessageRemoved', () => {
  it('实时追加、重复推送不重复', () => {
    let s = mergeLatestPage(undefined, { items: [msg('1', 1)], nextCursor: null }, 0, 0);
    s = applyMessageEvent(s, msg('2', 2), 10);
    s = applyMessageEvent(s, msg('2', 2), 11);
    expect(ids(s)).toEqual(['2', '1']);
  });

  it('补投的旧消息落在正确位置', () => {
    let s = mergeLatestPage(undefined, { items: [msg('3', 30), msg('1', 10)], nextCursor: null }, 0, 0);
    s = applyMessageEvent(s, msg('8', 20), 10);
    expect(toDisplayOrder(s).map((m) => m.id)).toEqual(['1', '8', '3']);
  });

  it('message 事件删除 msgId 相同但 id 不同的旧行，message_removed 删除行', () => {
    let s = mergeLatestPage(undefined, { items: [msg('20', 5, { msgId: 'M1' }), msg('1', 1)], nextCursor: null }, 0, 0);
    s = applyMessageEvent(s, msg('7', 5, { msgId: 'M1', isOwn: true }), 10);
    expect(ids(s)).toEqual(['7', '1']);
    s = applyMessageRemoved(s, '1', 11);
    expect(ids(s)).toEqual(['7']);
    expect(s.removed['1']).toBe(11);
  });

  it('tombstone 过期后被清理', () => {
    let s = mergeLatestPage(undefined, { items: [msg('1', 1)], nextCursor: null }, 0, 0);
    s = applyMessageRemoved(s, '1', 0);
    s = mergeLatestPage(s, { items: [], nextCursor: null }, 200_000, 200_000);
    expect(s.removed).toEqual({});
  });
});
