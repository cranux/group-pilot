import type { MessageItem, MessagesPage } from '../api/types';

/**
 * 群消息时间线的客户端状态与合并规则（纯函数）。
 *
 * - `items` 按 sentAt **倒序**存放（与接口一致），展示时再反转为「最早在上」。
 * - 以 `id`（稳定行 id）去重；自己的消息 sentAt 可能在发出后变化，所以每次合并后重新排序。
 * - msgId 合并：同一个 msgId 只保留一行，新到的行替换掉 msgId 相同但 id 不同的旧行（孤儿回流行被合并）。
 * - 竞态保护：HTTP 页可能比 WS 推送更旧。WS 推送/删除会在 `touched` / `removed` 里记下本地时间，
 *   之后合并「在这之前就已发出的请求」返回的页时，不让旧页覆盖较新的 WS 数据、也不让已删除的行复活。
 */

export interface TimelineState {
  items: MessageItem[];
  /** 继续向更早翻页用的游标；null = 已经到头。 */
  nextCursor: string | null;
  /** id → 最后一次由 WS 更新的本地时间（ms）。 */
  touched: Record<string, number>;
  /** id → 由 WS 删除的本地时间（ms）。 */
  removed: Record<string, number>;
}

/** touched / removed 的保留时长：远大于任何一次请求的耗时即可。 */
export const TOMBSTONE_TTL_MS = 120_000;

export function emptyTimeline(): TimelineState {
  return { items: [], nextCursor: null, touched: {}, removed: {} };
}

function sentAtMs(item: MessageItem): number {
  const t = Date.parse(item.sentAt);
  return Number.isNaN(t) ? 0 : t;
}

/** id 比较：纯数字串按数值，其它按字符串。 */
export function compareIds(a: string, b: string): number {
  const sa = String(a);
  const sb = String(b);
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    if (sa.length !== sb.length) return sa.length - sb.length;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 倒序比较器：sentAt 新的在前；同一毫秒按 id 倒序，保证稳定。 */
export function compareDesc(a: MessageItem, b: MessageItem): number {
  const d = sentAtMs(b) - sentAtMs(a);
  if (d !== 0) return d;
  return compareIds(b.id, a.id);
}

function prune(record: Record<string, number>, now: number): Record<string, number> {
  let changed = false;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (now - v <= TOMBSTONE_TTL_MS) out[k] = v;
    else changed = true;
  }
  return changed ? out : record;
}

interface UpsertOptions {
  /** 合并 HTTP 页时：该请求发出的本地时间。WS 推送合并时不传。 */
  fetchStartedAt?: number;
}

/** 把若干行合并进列表：按 id upsert，并删除 msgId 相同但 id 不同的旧行。返回新数组（已排序）。 */
export function upsertItems(
  existing: MessageItem[],
  incoming: MessageItem[],
  state: Pick<TimelineState, 'touched' | 'removed'>,
  opts: UpsertOptions = {},
): MessageItem[] {
  const byId = new Map<string, MessageItem>();
  for (const it of existing) byId.set(it.id, it);

  for (const it of incoming) {
    if (!it || it.id === undefined || it.id === null) continue;
    const id = String(it.id);
    if (state.removed[id] !== undefined) continue; // 已被合并删除的行不复活
    if (opts.fetchStartedAt !== undefined) {
      const t = state.touched[id];
      if (t !== undefined && t >= opts.fetchStartedAt) continue; // WS 数据更新，旧页不覆盖
    }
    const item = id === it.id ? it : { ...it, id };
    if (item.msgId) {
      const conflicting = [...byId.values()].filter((o) => o.id !== id && o.msgId === item.msgId);
      if (opts.fetchStartedAt !== undefined) {
        const startedAt = opts.fetchStartedAt;
        const fresherViaWs = conflicting.some((o) => (state.touched[o.id] ?? -Infinity) >= startedAt);
        // 同一 msgId 的另一行刚由 WS 更新过（比这一页新）：保留 WS 那行，丢弃这条旧页数据
        if (fresherViaWs) continue;
      }
      for (const o of conflicting) byId.delete(o.id);
    }
    byId.set(id, item);
  }

  return [...byId.values()].sort(compareDesc);
}

function oldestMs(items: MessageItem[]): number | null {
  if (items.length === 0) return null;
  return sentAtMs(items[items.length - 1]);
}

/** 合并「最新一页」（首次加载、失效重拉、重连兜底）。不会丢掉已加载的更早页。 */
export function mergeLatestPage(
  prev: TimelineState | undefined,
  page: MessagesPage,
  fetchStartedAt: number,
  now: number,
): TimelineState {
  if (!prev || prev.items.length === 0) {
    const base = prev ?? emptyTimeline();
    const items = upsertItems([], page.items, base, prev ? { fetchStartedAt } : {});
    return {
      items,
      nextCursor: page.nextCursor,
      touched: prune(base.touched, now),
      removed: prune(base.removed, now),
    };
  }
  const items = upsertItems(prev.items, page.items, prev, { fetchStartedAt });
  let nextCursor = prev.nextCursor;
  if (page.nextCursor === null) {
    // 服务端全部消息都在这一页里
    nextCursor = null;
  } else {
    const pageOldest = oldestMs(page.items.slice().sort(compareDesc));
    const prevOldest = oldestMs(prev.items);
    if (pageOldest !== null && prevOldest !== null && pageOldest <= prevOldest) {
      // 新页覆盖到了比已加载的更早的位置，沿用新页的游标
      nextCursor = page.nextCursor;
    }
  }
  return { items, nextCursor, touched: prune(prev.touched, now), removed: prune(prev.removed, now) };
}

/** 合并「加载更早」得到的页。`cursorUsed` 用来防止重复点击/并发翻页导致游标倒退。 */
export function mergeOlderPage(
  prev: TimelineState | undefined,
  page: MessagesPage,
  cursorUsed: string,
  fetchStartedAt: number,
  now: number,
): TimelineState {
  const base = prev ?? emptyTimeline();
  const items = upsertItems(base.items, page.items, base, { fetchStartedAt });
  const nextCursor = base.nextCursor === cursorUsed ? page.nextCursor : base.nextCursor;
  return { items, nextCursor, touched: prune(base.touched, now), removed: prune(base.removed, now) };
}

/** WS `message` 事件：按 item.id upsert（同时删除 msgId 相同但 id 不同的旧行）。 */
export function applyMessageEvent(prev: TimelineState, item: MessageItem, now: number): TimelineState {
  const id = String(item.id);
  const touched = { ...prune(prev.touched, now), [id]: now };
  const removed = prev.removed[id] !== undefined ? omit(prev.removed, id) : prev.removed;
  // 被合并删掉的旧行也记为删除，防止旧页让它复活
  const removedIds = item.msgId
    ? prev.items.filter((x) => x.id !== id && x.msgId === item.msgId).map((x) => x.id)
    : [];
  const removedNext = removedIds.length
    ? { ...removed, ...Object.fromEntries(removedIds.map((r) => [r, now])) }
    : removed;
  const items = upsertItems(prev.items, [item], { touched: {}, removed: removedNext });
  return { ...prev, items, touched, removed: prune(removedNext, now) };
}

/** WS `message_removed` 事件。 */
export function applyMessageRemoved(prev: TimelineState, id: string, now: number): TimelineState {
  const key = String(id);
  return {
    ...prev,
    items: prev.items.filter((x) => x.id !== key),
    touched: omit(prev.touched, key),
    removed: { ...prune(prev.removed, now), [key]: now },
  };
}

function omit(record: Record<string, number>, key: string): Record<string, number> {
  if (record[key] === undefined) return record;
  const out = { ...record };
  delete out[key];
  return out;
}

/** 展示顺序：最早在上、最新在下。 */
export function toDisplayOrder(state: TimelineState): MessageItem[] {
  return state.items.slice().reverse();
}
