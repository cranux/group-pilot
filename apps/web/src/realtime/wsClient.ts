import { SeqTracker, toSeq } from './seq';

/**
 * WebSocket 实时通道（不依赖 React / DOM 全局，WebSocket 实现与定时器均可注入）。
 *
 * 协议：连接后发 { type:'auth', accessToken, sinceSeq? } → 服务端 { type:'auth', success, latestSeq }；
 * 之后的事件帧 { seq, type, payload }。
 * - 认证失败（success:false，随后服务端关闭）→ 先 refresh token 再重连；
 * - 断线后指数退避重连（300ms 起，上限 2s），重连带 sinceSeq = lastSeq；
 * - 重连认证成功后调用 onResync（上层用来失效 React Query 查询兜底）。
 */

export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface RealtimeEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeClientOptions {
  url: string | (() => string);
  createSocket: (url: string) => WebSocketLike;
  getAccessToken: () => string | null;
  /** 刷新 access token，成功返回 true。 */
  refreshToken: () => Promise<boolean>;
  onEvent: (event: RealtimeEvent) => void;
  onStatusChange?: (status: WsStatus) => void;
  /** 断线重连并认证成功后调用。 */
  onResync?: () => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** 打开连接后等待 auth 回复的超时。 */
  authTimeoutMs?: number;
  timers?: TimerApi;
}

export interface RealtimeClient {
  start(): void;
  stop(): void;
  /** 立即重连（例如浏览器 online 事件）。 */
  reconnectNow(): void;
  readonly status: WsStatus;
  readonly lastSeq: number | null;
}

export function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
}

export function createRealtimeClient(opts: RealtimeClientOptions): RealtimeClient {
  const timers: TimerApi = opts.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const initialMs = opts.initialBackoffMs ?? 300;
  const maxMs = opts.maxBackoffMs ?? 2000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5000;

  const tracker = new SeqTracker();
  let status: WsStatus = 'stopped';
  let socket: WebSocketLike | null = null;
  let authed = false;
  let everAuthed = false;
  let attempt = 0;
  let needRefresh = false;
  let running = false;
  let reconnectTimer: unknown = null;
  let authTimer: unknown = null;

  const setStatus = (s: WsStatus) => {
    if (status === s) return;
    status = s;
    opts.onStatusChange?.(s);
  };

  const clearTimer = (h: unknown) => {
    if (h !== null) timers.clearTimeout(h);
  };

  function detach(sock: WebSocketLike) {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
  }

  function scheduleReconnect() {
    if (!running) return;
    clearTimer(reconnectTimer);
    const delay = backoffDelay(attempt, initialMs, maxMs);
    attempt += 1;
    setStatus('reconnecting');
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      void openWithFreshToken();
    }, delay);
  }

  async function openWithFreshToken() {
    if (!running) return;
    if (needRefresh || !opts.getAccessToken()) {
      needRefresh = false;
      let ok = false;
      try {
        ok = await opts.refreshToken();
      } catch {
        ok = false;
      }
      if (!running) return;
      if (!ok) {
        scheduleReconnect();
        return;
      }
    }
    open();
  }

  function handleFrame(raw: unknown) {
    let msg: unknown;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    if (m.type === 'auth' && m.seq === undefined) {
      clearTimer(authTimer);
      authTimer = null;
      if (m.success === true) {
        const resumed = everAuthed;
        tracker.onAuthenticated(m.latestSeq, resumed);
        authed = true;
        everAuthed = true;
        attempt = 0;
        setStatus('connected');
        if (resumed) opts.onResync?.();
      } else {
        // 认证失败：服务端随后会关闭连接；关闭后先 refresh 再重连。
        needRefresh = true;
        socket?.close(4001, 'auth failed');
      }
      return;
    }

    if (!authed) return;
    const seq = toSeq(m.seq);
    if (seq === null || typeof m.type !== 'string') return;
    if (!tracker.accept(seq)) return;
    const payload = (m.payload && typeof m.payload === 'object' ? m.payload : {}) as Record<string, unknown>;
    try {
      opts.onEvent({ seq, type: m.type, payload });
    } catch (e) {
      // 单个事件处理失败不能拖垮连接
      console.error('[ws] 处理事件失败', m.type, e);
    }
  }

  function open() {
    if (!running) return;
    const token = opts.getAccessToken();
    if (!token) {
      needRefresh = true;
      scheduleReconnect();
      return;
    }
    setStatus(everAuthed ? 'reconnecting' : 'connecting');
    const url = typeof opts.url === 'function' ? opts.url() : opts.url;
    let sock: WebSocketLike;
    try {
      sock = opts.createSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = sock;
    authed = false;

    sock.onopen = () => {
      if (socket !== sock) return;
      const since = everAuthed ? tracker.sinceSeqForReconnect() : undefined;
      const authMsg: Record<string, unknown> = { type: 'auth', accessToken: opts.getAccessToken() ?? token };
      if (since !== undefined) authMsg.sinceSeq = since;
      try {
        sock.send(JSON.stringify(authMsg));
      } catch {
        sock.close();
        return;
      }
      clearTimer(authTimer);
      authTimer = timers.setTimeout(() => {
        authTimer = null;
        if (socket === sock && !authed) sock.close(4000, 'auth timeout');
      }, authTimeoutMs);
    };
    sock.onmessage = (ev) => {
      if (socket !== sock) return;
      handleFrame(ev.data);
    };
    sock.onerror = () => {
      // close 事件会随后到达，在那里统一处理
    };
    sock.onclose = () => {
      if (socket !== sock) return;
      detach(sock);
      socket = null;
      authed = false;
      clearTimer(authTimer);
      authTimer = null;
      if (!running) return;
      scheduleReconnect();
    };
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      void openWithFreshToken();
    },
    stop() {
      running = false;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      clearTimer(authTimer);
      authTimer = null;
      if (socket) {
        const s = socket;
        socket = null;
        detach(s);
        try {
          s.close(1000, 'stopped');
        } catch {
          /* ignore */
        }
      }
      authed = false;
      setStatus('stopped');
    },
    reconnectNow() {
      if (!running || (socket && authed)) return;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      attempt = 0;
      if (socket) {
        const s = socket;
        socket = null;
        detach(s);
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
      void openWithFreshToken();
    },
    get status() {
      return status;
    },
    get lastSeq() {
      return tracker.lastSeq;
    },
  };
}
