import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createRealtimeClient, type RealtimeEvent, type WebSocketLike } from './wsClient';
import { SeqTracker } from './seq';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  // 测试辅助
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverDrop() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe('SeqTracker', () => {
  it('首次连接以 latestSeq 为起点，丢弃 seq <= lastSeq', () => {
    const t = new SeqTracker();
    t.onAuthenticated(10, false);
    expect(t.accept(9)).toBe(false);
    expect(t.accept(10)).toBe(false);
    expect(t.accept(11)).toBe(true);
    expect(t.accept(11)).toBe(false);
    expect(t.accept(13)).toBe(true);
    expect(t.accept(12)).toBe(false);
    expect(t.lastSeq).toBe(13);
  });

  it('续传时保持 lastSeq，不被 latestSeq 跳过补发', () => {
    const t = new SeqTracker();
    t.onAuthenticated(5, false);
    t.accept(6);
    expect(t.sinceSeqForReconnect()).toBe(6);
    t.onAuthenticated(20, true);
    expect(t.lastSeq).toBe(6);
    expect(t.accept(7)).toBe(true);
  });

  it('服务端 seq 回退（数据重置）时以服务端为准；接受字符串 seq', () => {
    const t = new SeqTracker();
    t.onAuthenticated(100, false);
    t.onAuthenticated(3, true);
    expect(t.lastSeq).toBe(3);
    expect(t.accept('4')).toBe(true);
    expect(t.accept('x')).toBe(false);
  });

  it('auth 回复没有 latestSeq 时接受第一帧', () => {
    const t = new SeqTracker();
    t.onAuthenticated(undefined, false);
    expect(t.accept(1)).toBe(true);
    expect(t.accept(1)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('300ms 起翻倍，上限 2s', () => {
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffDelay(a, 300, 2000))).toEqual([300, 600, 1200, 2000, 2000, 2000]);
  });
});

describe('createRealtimeClient', () => {
  let sockets: FakeSocket[];
  let events: RealtimeEvent[];
  let token: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    events = [];
    token = 'tok1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides: Partial<Parameters<typeof createRealtimeClient>[0]> = {}) {
    const onResync = vi.fn();
    const statuses: string[] = [];
    const refreshToken = vi.fn(async () => {
      token = 'tok2';
      return true;
    });
    const client = createRealtimeClient({
      url: 'ws://host/ws',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      getAccessToken: () => token,
      refreshToken,
      onEvent: (e) => events.push(e),
      onStatusChange: (s) => statuses.push(s),
      onResync,
      ...overrides,
    });
    return { client, onResync, statuses, refreshToken };
  }

  it('首次连接不带 sinceSeq；断线重连带 sinceSeq = lastSeq，补发帧去重且只处理一次', async () => {
    const { client, onResync, statuses } = make();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    const s1 = sockets[0];
    s1.serverOpen();
    expect(s1.sent).toEqual([{ type: 'auth', accessToken: 'tok1' }]);
    s1.serverSend({ type: 'auth', success: true, latestSeq: 100 });
    expect(client.status).toBe('connected');

    s1.serverSend({ seq: 100, type: 'group_updated', payload: { groupId: 'g' } }); // <= latestSeq，丢弃
    s1.serverSend({ seq: 101, type: 'group_updated', payload: { groupId: 'g1' } });
    s1.serverSend({ seq: 101, type: 'group_updated', payload: { groupId: 'g1' } }); // 重复
    s1.serverSend({ seq: 102, type: 'job', payload: { jobId: 'j' } });
    expect(events.map((e) => e.seq)).toEqual([101, 102]);

    s1.serverDrop();
    expect(client.status).toBe('reconnecting');
    // 300ms 后第一次重连
    await vi.advanceTimersByTimeAsync(299);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    const s2 = sockets[1];
    s2.serverOpen();
    expect(s2.sent).toEqual([{ type: 'auth', accessToken: 'tok1', sinceSeq: 102 }]);
    s2.serverSend({ type: 'auth', success: true, latestSeq: 105 });
    expect(onResync).toHaveBeenCalledTimes(1);
    // 服务端补发 seq > 102（含一条重复）
    s2.serverSend({ seq: 102, type: 'job', payload: {} });
    s2.serverSend({ seq: 103, type: 'message', payload: { groupId: 'g1' } });
    s2.serverSend({ seq: 104, type: 'message', payload: { groupId: 'g1' } });
    s2.serverSend({ seq: 105, type: 'agent_run', payload: { runId: 'r' } });
    s2.serverSend({ seq: 104, type: 'message', payload: { groupId: 'g1' } });
    expect(events.map((e) => e.seq)).toEqual([101, 102, 103, 104, 105]);
    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    client.stop();
    expect(client.status).toBe('stopped');
  });

  it('连接失败时退避 300 → 600 → 1200 → 2000 → 2000，认证成功后重置', async () => {
    const { client } = make();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].serverDrop();
    const delays = [300, 600, 1200, 2000, 2000];
    for (let i = 0; i < delays.length; i++) {
      await vi.advanceTimersByTimeAsync(delays[i] - 1);
      expect(sockets).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(i + 2);
      if (i < delays.length - 1) sockets[i + 1].serverDrop();
    }
    const last = sockets[sockets.length - 1];
    last.serverOpen();
    last.serverSend({ type: 'auth', success: true, latestSeq: 1 });
    last.serverDrop();
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(delays.length + 2);
    client.stop();
  });

  it('认证失败时先 refresh token 再重连', async () => {
    const { client, refreshToken } = make();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const s1 = sockets[0];
    s1.serverOpen();
    s1.serverSend({ type: 'auth', success: false });
    expect(s1.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    sockets[1].serverOpen();
    expect(sockets[1].sent[0]).toEqual({ type: 'auth', accessToken: 'tok2' });
    client.stop();
  });

  it('auth 回复超时会关闭并重连；认证前收到的事件帧被忽略', async () => {
    const { client } = make({ authTimeoutMs: 1000 });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const s1 = sockets[0];
    s1.serverOpen();
    s1.serverSend({ seq: 1, type: 'job', payload: {} });
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s1.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('stop 之后不再重连', async () => {
    const { client } = make();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });

  it('事件处理抛错不影响后续事件', async () => {
    const seen: number[] = [];
    const { client } = make({
      onEvent: (e) => {
        seen.push(e.seq);
        if (e.seq === 2) throw new Error('boom');
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const s = sockets[0];
    s.serverOpen();
    s.serverSend({ type: 'auth', success: true, latestSeq: 1 });
    s.serverSend({ seq: 2, type: 'x', payload: {} });
    s.serverSend({ seq: 3, type: 'y', payload: {} });
    expect(seen).toEqual([2, 3]);
    err.mockRestore();
    client.stop();
  });
});
