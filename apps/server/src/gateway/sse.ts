import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { sleep } from '../lib/time.js';

export interface RawGatewayEvent {
  eventId: number;
  type: string;
  raw: string;
}

/** 解析 SSE 文本流（标准格式：id / event / data，空行分帧，data 可多行） */
export class SseParser {
  private buffer = '';
  private id: string | null = null;
  private event: string | null = null;
  private data: string[] = [];

  constructor(private readonly onFrame: (frame: { id: string | null; event: string | null; data: string }) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sepLen);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length) this.onFrame({ id: this.id, event: this.event, data: this.data.join('\n') });
      this.id = null;
      this.event = null;
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') this.id = value;
    else if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** 从一帧里提取 eventId / type，原文保持不动（落库后再解析业务字段） */
export function frameToEvent(frame: { id: string | null; event: string | null; data: string }): RawGatewayEvent | null {
  let parsed: any = null;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    parsed = null;
  }
  const eventId = Number(parsed?.eventId ?? frame.id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const type = String(parsed?.type ?? frame.event ?? 'unknown');
  return { eventId, type, raw: frame.data };
}

/**
 * 网关事件流消费者：每个事件先写进 gateway_inbox（eventId 主键去重），由处理器异步处理。
 * 重连游标：取「最后收到时刻往前 2 秒之前收到的最大 eventId」——回退超过 1 秒乱序窗口，
 * 保证乱序中还没到的小 eventId 会被重新拉到；重复的由主键去重。
 * inbox 写不进去时原文追加到本地 spool 文件，并直接广播 inconsistency；后台定期回灌。
 */
export class GatewayEventStream {
  private abort: AbortController | null = null;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private spoolTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.stopped = false;
    this.loopPromise = this.loop();
    this.spoolTimer = setInterval(() => void this.flushSpool(), 2_000);
    void this.flushSpool();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    await this.loopPromise;
  }

  /** 测试用：主动断开当前连接，触发重连 */
  dropConnection(): void {
    this.abort?.abort();
  }

  async cursor(): Promise<number> {
    const row = await this.ctx.db.one<{ since: number }>(
      `SELECT coalesce(max(event_id), 0) AS since FROM gateway_inbox
        WHERE received_at < (SELECT max(received_at) FROM gateway_inbox) - interval '2 seconds'`,
    );
    return Number(row?.since ?? 0);
  }

  private async loop(): Promise<void> {
    let backoff = 200;
    while (!this.stopped) {
      try {
        const since = await this.cursor();
        await this.consume(since);
        backoff = 200;
      } catch (err) {
        if (!this.stopped) this.ctx.log.warn({ err: String(err) }, 'gateway event stream error');
      }
      this.connected = false;
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 2_000);
    }
  }

  private async consume(since: number): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    const res = await fetch(`${this.ctx.config.gatewayUrl}/events?since=${since}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
    this.connected = true;
    const decoder = new TextDecoder();
    const queue: RawGatewayEvent[] = [];
    let writing: Promise<void> | null = null;
    const drain = async () => {
      while (queue.length) await this.store(queue.shift()!);
      writing = null;
    };
    const parser = new SseParser((frame) => {
      const evt = frameToEvent(frame);
      if (!evt) {
        this.ctx.log.warn({ frame: frame.data.slice(0, 200) }, 'gateway event without eventId');
        return;
      }
      queue.push(evt);
      if (!writing) writing = drain();
    });
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        parser.push(decoder.decode(chunk, { stream: true }));
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      await writing;
    }
  }

  private async store(evt: RawGatewayEvent): Promise<void> {
    try {
      await this.insert(evt);
      this.ctx.signals.wake('inbox');
    } catch (err) {
      this.spool(evt, err);
    }
  }

  private async insert(evt: RawGatewayEvent): Promise<void> {
    await this.ctx.db.query(
      `INSERT INTO gateway_inbox (event_id, type, raw) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
      [evt.eventId, evt.type, evt.raw.replace(/\u0000/g, '\\u0000')],
    );
  }

  private spool(evt: RawGatewayEvent, err: unknown): void {
    try {
      fs.mkdirSync(path.dirname(this.ctx.config.spoolFile), { recursive: true });
      fs.appendFileSync(this.ctx.config.spoolFile, JSON.stringify(evt) + '\n');
    } catch (spoolErr) {
      this.ctx.log.error({ err: spoolErr }, 'failed to spool gateway event');
    }
    this.ctx.hub.broadcastTransient('inconsistency', {
      kind: 'inbox_write_failed',
      ref: `event:${evt.eventId}`,
      message: `网关事件 ${evt.eventId}（${evt.type}）写入收件箱失败，已暂存到本地并将重试：${String((err as Error)?.message ?? err)}`,
    });
  }

  /** 把 spool 里的事件回灌到 inbox；全部成功才清空文件 */
  async flushSpool(): Promise<void> {
    const file = this.ctx.config.spoolFile;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (!content.trim()) return;
    const lines = content.split('\n').filter(Boolean);
    const remaining: string[] = [];
    for (const line of lines) {
      try {
        await this.insert(JSON.parse(line) as RawGatewayEvent);
      } catch {
        remaining.push(line);
      }
    }
    fs.writeFileSync(file, remaining.length ? remaining.join('\n') + '\n' : '');
    if (remaining.length < lines.length) this.ctx.signals.wake('inbox');
  }
}
