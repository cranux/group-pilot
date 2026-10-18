// 通知区（toast）与页头保留的最近不一致事件。外部 store，供 useSyncExternalStore 订阅。

export type NoticeLevel = 'info' | 'success' | 'warning' | 'error';

export interface Notice {
  id: number;
  level: NoticeLevel;
  title: string;
  message?: string;
  /** 醒目通知：不自动消失，需要手动关闭。 */
  sticky: boolean;
  at: number;
}

export interface InconsistencyRecord {
  id: number;
  kind: string;
  ref: string;
  message: string;
  at: number;
}

export interface NotificationSnapshot {
  notices: Notice[];
  inconsistencies: InconsistencyRecord[];
  unreadInconsistencies: number;
}

export interface PushInput {
  level: NoticeLevel;
  title: string;
  message?: string;
  sticky?: boolean;
}

export interface NotificationStore {
  getSnapshot(): NotificationSnapshot;
  subscribe(listener: () => void): () => void;
  push(input: PushInput): number;
  dismiss(id: number): void;
  recordInconsistency(input: { kind: string; ref: string; message: string }): void;
  markInconsistenciesRead(): void;
  clearInconsistencies(): void;
}

export interface NotificationStoreOptions {
  autoDismissMs?: number;
  maxNotices?: number;
  maxInconsistencies?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

export function createNotificationStore(opts: NotificationStoreOptions = {}): NotificationStore {
  const autoDismissMs = opts.autoDismissMs ?? 6000;
  const maxNotices = opts.maxNotices ?? 6;
  const maxInconsistencies = opts.maxInconsistencies ?? 20;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));

  let seq = 0;
  let snapshot: NotificationSnapshot = { notices: [], inconsistencies: [], unreadInconsistencies: 0 };
  const listeners = new Set<() => void>();

  const set = (next: NotificationSnapshot) => {
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const store: NotificationStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(input) {
      seq += 1;
      const notice: Notice = {
        id: seq,
        level: input.level,
        title: input.title,
        message: input.message,
        sticky: input.sticky ?? false,
        at: now(),
      };
      let notices = [...snapshot.notices, notice];
      // 超出上限时优先挤掉非醒目的旧通知
      while (notices.length > maxNotices) {
        const idx = notices.findIndex((n) => !n.sticky);
        notices = notices.filter((_, i) => i !== (idx >= 0 ? idx : 0));
      }
      set({ ...snapshot, notices });
      if (!notice.sticky) setTimer(() => store.dismiss(notice.id), autoDismissMs);
      return notice.id;
    },
    dismiss(id) {
      if (!snapshot.notices.some((n) => n.id === id)) return;
      set({ ...snapshot, notices: snapshot.notices.filter((n) => n.id !== id) });
    },
    recordInconsistency(input) {
      seq += 1;
      const rec: InconsistencyRecord = { id: seq, ...input, at: now() };
      set({
        ...snapshot,
        inconsistencies: [rec, ...snapshot.inconsistencies].slice(0, maxInconsistencies),
        unreadInconsistencies: snapshot.unreadInconsistencies + 1,
      });
    },
    markInconsistenciesRead() {
      if (snapshot.unreadInconsistencies === 0) return;
      set({ ...snapshot, unreadInconsistencies: 0 });
    },
    clearInconsistencies() {
      set({ ...snapshot, inconsistencies: [], unreadInconsistencies: 0 });
    },
  };
  return store;
}

export const notifications = createNotificationStore();
