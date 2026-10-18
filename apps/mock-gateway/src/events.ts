import type { ServerResponse } from 'node:http';
import type { GatewayConfig } from './config.js';

export interface GatewayEvent {
  eventId: number;
  type: string;
  /** 推送给客户端的 data（已包含 eventId 与 type） */
  data: Record<string, unknown>;
  /** 产生时刻（ms） */
  at: number;
}

/**
 * 事件流：全局单调递增的 eventId（从 1 开始），保留全部历史。
 * 重复 / 乱序只作用在每个 SSE 连接的输出侧，历史本身是有序且唯一的。
 */
export class EventHub {
  private lastId = 0;
  private readonly history: GatewayEvent[] = [];
  private readonly clients = new Set<SseClient>();

  constructor(private readonly getConfig: () => GatewayConfig) {}

  get lastEventId(): number {
    return this.lastId;
  }

  get size(): number {
    return this.history.length;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  emit(type: string, payload: Record<string, unknown>): GatewayEvent {
    const eventId = ++this.lastId;
    const ev: GatewayEvent = { eventId, type, data: { ...payload, eventId, type }, at: Date.now() };
    this.history.push(ev);
    for (const c of this.clients) c.deliver(ev);
    return ev;
  }

  /** eventId > since 的历史事件（since 独占） */
  since(since: number): GatewayEvent[] {
    // eventId 从 1 连续递增，history[i].eventId === i + 1
    const start = Math.max(0, Math.min(this.history.length, Math.floor(since)));
    return this.history.slice(start);
  }

  /** 挂一个 SSE 连接。since 为 null 时只推之后的新事件。 */
  attach(raw: ServerResponse, since: number | null): SseClient {
    const client = new SseClient(raw, this.getConfig, () => this.clients.delete(client));
    // 同步完成「补发历史 + 注册实时」，中间不会有事件插入，保证无缺口
    if (since !== null) for (const ev of this.since(since)) client.deliver(ev);
    this.clients.add(client);
    return client;
  }

  pingAll(): void {
    for (const c of this.clients) c.ping();
  }

  /** 断开所有 SSE 连接，返回断开的数量 */
  dropAll(): number {
    const n = this.clients.size;
    for (const c of [...this.clients]) c.close();
    this.clients.clear();
    return n;
  }
}

export class SseClient {
  private held: { ev: GatewayEvent; timer: NodeJS.Timeout } | null = null;
  private closed = false;

  constructor(
    private readonly raw: ServerResponse,
    private readonly getConfig: () => GatewayConfig,
    private readonly onClose: () => void,
  ) {
    raw.on('close', () => this.cleanup());
  }

  deliver(ev: GatewayEvent): void {
    if (this.closed) return;
    const window = Math.min(1000, this.getConfig().reorderWindowMs);
    if (this.held) {
      // 新事件先写、被扣住的旧事件后写 → 相邻两条交换顺序
      const held = this.held;
      this.held = null;
      clearTimeout(held.timer);
      this.write(ev);
      this.write(held.ev);
      return;
    }
    if (window > 0 && Math.random() < 0.5) {
      const holdMs = Math.max(1, Math.floor(window * (0.3 + 0.7 * Math.random())));
      const timer = setTimeout(() => {
        if (this.held?.ev === ev) {
          this.held = null;
          this.write(ev);
        }
      }, holdMs);
      this.held = { ev, timer };
      return;
    }
    this.write(ev);
  }

  ping(): void {
    if (!this.closed) this.raw.write(': ping\n\n');
  }

  close(): void {
    if (this.closed) return;
    this.flushHeld();
    this.cleanup();
    this.raw.end();
  }

  private flushHeld(): void {
    if (!this.held) return;
    const held = this.held;
    this.held = null;
    clearTimeout(held.timer);
    this.write(held.ev);
  }

  private write(ev: GatewayEvent): void {
    if (this.closed || this.raw.writableEnded || this.raw.destroyed) return;
    const frame = `id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    this.raw.write(frame);
    const p = this.getConfig().duplicateEvents;
    if (p > 0 && Math.random() < p) this.raw.write(frame);
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.held) {
      clearTimeout(this.held.timer);
      this.held = null;
    }
    this.onClose();
  }
}
