import type pg from 'pg';
import { WS_EVENTS_CHANNEL, type Db } from '../db/db.js';
import type { Logger } from '../lib/logger.js';

export interface WsFrame {
  seq: number | null;
  type: string;
  payload: unknown;
}

export interface HubClient {
  sessionId: string;
  send(frame: WsFrame): void;
  close(code: number, reason: string): void;
  /** 已经发给该客户端的最大 seq */
  lastSentSeq: number;
  ready: boolean;
}

const RECENT_LIMIT = 5_000;
const REPLAY_BATCH = 1_000;

/**
 * ws_events 分发器：LISTEN/NOTIFY 唤醒 + 短轮询兜底（多实例时其它实例写入的事件也能被拉到）。
 * 事件按 seq 顺序读取；由于写入时持有事务级 advisory lock，seq 顺序就是提交顺序，不会出现跳号后补到的情况。
 */
export class RealtimeHub {
  private lastSeq = 0;
  private readonly clients = new Set<HubClient>();
  private readonly recent: WsFrame[] = [];
  private listenClient: pg.PoolClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pumping: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly pollMs = 500,
  ) {}

  async start(): Promise<void> {
    const row = await this.db.one<{ seq: number }>('SELECT coalesce(max(seq), 0) AS seq FROM ws_events');
    this.lastSeq = row?.seq ?? 0;
    await this.listen();
    this.timer = setInterval(() => this.pump(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.close(1001, 'server shutting down');
    this.clients.clear();
    if (this.listenClient) {
      this.listenClient.removeAllListeners('notification');
      this.listenClient.removeAllListeners('error');
      this.listenClient.release(true);
      this.listenClient = null;
    }
    await this.pumping;
  }

  get latestSeq(): number {
    return this.lastSeq;
  }

  /** 认证成功后加入；带 sinceSeq 时先从数据库补发 seq > sinceSeq 的事件 */
  async attach(client: HubClient, sinceSeq: number | undefined): Promise<void> {
    client.ready = false;
    this.clients.add(client);
    if (sinceSeq === undefined || sinceSeq === null) {
      client.lastSentSeq = this.lastSeq;
    } else {
      client.lastSentSeq = Math.max(0, Math.floor(sinceSeq));
      for (;;) {
        const rows = await this.db.query<{ seq: number; type: string; payload: unknown }>(
          'SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq LIMIT $2',
          [client.lastSentSeq, REPLAY_BATCH],
        );
        for (const r of rows.rows) {
          client.send({ seq: r.seq, type: r.type, payload: r.payload });
          client.lastSentSeq = r.seq;
        }
        if (rows.rows.length < REPLAY_BATCH) break;
      }
    }
    // 补发期间分发器可能已推出更新的事件：从最近缓存里补齐
    for (const frame of this.recent) {
      if (frame.seq !== null && frame.seq > client.lastSentSeq) {
        client.send(frame);
        client.lastSentSeq = frame.seq;
      }
    }
    client.ready = true;
  }

  detach(client: HubClient): void {
    this.clients.delete(client);
  }

  closeSession(sessionId: string): void {
    for (const c of this.clients) {
      if (c.sessionId === sessionId) {
        c.close(4001, 'session revoked');
        this.clients.delete(c);
      }
    }
  }

  /** 数据库不可用时的兜底通知：不入库、不占 seq */
  broadcastTransient(type: string, payload: unknown): void {
    for (const c of this.clients) if (c.ready) c.send({ seq: null, type, payload });
  }

  pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.again = false;
          await this.drain();
        } while (this.again && !this.stopped);
      } catch (err) {
        this.log.warn({ err }, 'ws_events dispatch failed');
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const rows = await this.db.query<{ seq: number; type: string; payload: unknown }>(
        'SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq LIMIT 500',
        [this.lastSeq],
      );
      for (const r of rows.rows) {
        const frame: WsFrame = { seq: r.seq, type: r.type, payload: r.payload };
        this.lastSeq = r.seq;
        this.recent.push(frame);
        for (const c of this.clients) {
          if (c.ready && r.seq > c.lastSentSeq) {
            c.send(frame);
            c.lastSentSeq = r.seq;
          }
        }
      }
      if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
      if (rows.rows.length < 500) return;
    }
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    try {
      const client = await this.db.pool.connect();
      client.on('notification', () => void this.pump());
      client.on('error', () => {
        client.release(true);
        if (this.listenClient === client) this.listenClient = null;
        setTimeout(() => void this.listen(), 1_000);
      });
      await client.query(`LISTEN ${WS_EVENTS_CHANNEL}`);
      this.listenClient = client;
    } catch (err) {
      this.log.warn({ err }, 'LISTEN failed, relying on polling');
      setTimeout(() => void this.listen(), 2_000);
    }
  }
}
