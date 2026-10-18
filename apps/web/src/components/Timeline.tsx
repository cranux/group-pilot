import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import type { MessageItem } from '../api/types';
import { mergeLatestPage, mergeOlderPage, toDisplayOrder, type TimelineState } from '../lib/timeline';
import { DELIVERY_STATUS, MESSAGE_SOURCE, ERROR_HINTS } from '../lib/labels';
import { formatDateTime, formatTimeMs } from '../lib/format';
import { Badge, StatusBadge } from './Badge';
import { ErrorBox } from './ErrorBox';
import { Loading } from './Loading';

const PAGE_SIZE = 50;

/** 时间线数据：首屏/失效重拉合并最新一页；「加载更早」按 nextCursor 翻页；WS 事件直接改缓存。 */
export function useTimeline(groupId: string) {
  const qc = useQueryClient();
  const key = qk.timeline(groupId);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const startedAt = Date.now();
      const page = await api.getMessages(groupId, { limit: PAGE_SIZE });
      // 合并时读取「此刻」的缓存，保留期间到达的 WS 更新与已加载的更早页
      const prev = qc.getQueryData<TimelineState>(key);
      return mergeLatestPage(prev, page, startedAt, Date.now());
    },
    staleTime: 30_000,
  });

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);

  /** 返回是否加载到了更早的消息（最早一条发生了变化）。 */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const k = qk.timeline(groupId);
    const s = qc.getQueryData<TimelineState>(k);
    const cursor = s?.nextCursor;
    if (!cursor || loadingOlder) return false;
    const oldestBefore = s.items.length ? s.items[s.items.length - 1].id : null;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const startedAt = Date.now();
      const page = await api.getMessages(groupId, { before: cursor, limit: PAGE_SIZE });
      const next = mergeOlderPage(qc.getQueryData<TimelineState>(k), page, cursor, startedAt, Date.now());
      qc.setQueryData<TimelineState>(k, next);
      const oldestAfter = next.items.length ? next.items[next.items.length - 1].id : null;
      return oldestAfter !== oldestBefore;
    } catch (e) {
      setOlderError(e);
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, [qc, groupId, loadingOlder]);

  return { query, loadOlder, loadingOlder, olderError };
}

function Sender({ m, accountByPlatformId }: { m: MessageItem; accountByPlatformId: Map<string, string> }) {
  const acc = m.senderAccountId ?? (m.senderPlatformUserId ? accountByPlatformId.get(m.senderPlatformUserId) : undefined);
  return (
    <span className="tl-sender">
      {m.isOwn ? <Badge tone="blue">我方</Badge> : null}
      {acc ? <span className="mono">{acc}</span> : null}
      {m.senderPlatformUserId ? <span className="mono muted small">{acc ? ` · ${m.senderPlatformUserId}` : m.senderPlatformUserId}</span> : null}
      {!acc && !m.senderPlatformUserId ? <span className="muted">未知发送者</span> : null}
    </span>
  );
}

function MessageRow({ m, accountByPlatformId }: { m: MessageItem; accountByPlatformId: Map<string, string> }) {
  const showFail = (m.deliveryStatus === 'failed' || m.deliveryStatus === 'cancelled') && m.failCode;
  return (
    <div className={`tl-item${m.isOwn ? ' tl-own' : ''}`} data-id={m.id}>
      <div className="tl-meta">
        <span className="tl-time mono" title={`${formatDateTime(m.sentAt)}（${m.sentAt}）`}>
          {formatTimeMs(m.sentAt)}
        </span>
        <Sender m={m} accountByPlatformId={accountByPlatformId} />
        <StatusBadge table={MESSAGE_SOURCE} value={m.source} />
        {m.isOwn && m.deliveryStatus ? <StatusBadge table={DELIVERY_STATUS} value={m.deliveryStatus} showRaw={false} /> : null}
        {showFail ? (
          <span className="tl-fail" title={ERROR_HINTS[m.failCode!] ?? undefined}>
            <code className="err-code">{m.failCode}</code>
          </span>
        ) : null}
        {m.mediaUrl || m.localFilePath ? (
          <span className="tl-attach">
            <Badge tone="purple" title={m.localFilePath ? `本地文件：${m.localFilePath}` : '尚未下载到本地'}>
              附件
            </Badge>
            {m.mediaUrl ? (
              <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="small">
                原始链接
              </a>
            ) : null}
            {m.localFilePath ? <span className="mono small muted"> {m.localFilePath}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="tl-text">{m.text}</div>
      <div className="tl-ids mono">
        id {m.id}
        {m.msgId ? ` · msgId ${m.msgId}` : ''}
        {m.clientMsgId ? ` · clientMsgId ${m.clientMsgId}` : ''}
      </div>
    </div>
  );
}

/** 消息时间线：最早在上、最新在下；顶部「加载更早」；新消息到达时若停在底部则自动滚到底。 */
export function Timeline({ groupId, accountByPlatformId }: { groupId: string; accountByPlatformId: Map<string, string> }) {
  const { query, loadOlder, loadingOlder, olderError } = useTimeline(groupId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const lastNewestId = useRef<string | null>(null);
  const lastOldestId = useRef<string | null>(null);

  const state = query.data;
  const items = state ? toDisplayOrder(state) : [];
  const newestId = items.length ? items[items.length - 1].id : null;
  const oldestId = items.length ? items[0].id : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderAnchor.current && oldestId !== lastOldestId.current) {
      // 更早的消息插到了顶部：保持视口里原来的内容不跳动
      el.scrollTop = el.scrollHeight - olderAnchor.current.height + olderAnchor.current.top;
      olderAnchor.current = null;
    } else if (newestId !== lastNewestId.current && nearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    lastNewestId.current = newestId;
    lastOldestId.current = oldestId;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const onLoadOlder = () => {
    const el = scrollRef.current;
    if (el) olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder().then((added) => {
      if (!added) olderAnchor.current = null;
    });
  };

  return (
    <div className="timeline">
      <div className="timeline-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="timeline-top">
          {state?.nextCursor ? (
            <button type="button" className="btn btn-sm" onClick={onLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? '加载中…' : '加载更早'}
            </button>
          ) : state ? (
            <span className="muted small">已到最早的消息</span>
          ) : null}
          {olderError ? <ErrorBox error={olderError} compact title="加载更早失败" /> : null}
        </div>
        {query.isLoading ? <Loading /> : null}
        {query.error && !state ? <ErrorBox error={query.error} title="加载消息失败" /> : null}
        {state && items.length === 0 ? <div className="empty">暂无消息</div> : null}
        {items.map((m) => (
          <MessageRow key={m.id} m={m} accountByPlatformId={accountByPlatformId} />
        ))}
      </div>
      <div className="timeline-foot muted small">
        共 {items.length} 条（已加载）{query.isFetching ? ' · 同步中…' : ''}
        {query.error && state ? <span className="text-error"> · 刷新失败</span> : null}
      </div>
    </div>
  );
}
