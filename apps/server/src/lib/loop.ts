import type { Logger } from './logger.js';
import type { SignalName, Signals } from './signals.js';

/**
 * 后台循环：每 intervalMs 跑一次，收到信号时提前跑；同一时刻只跑一份。
 * fn 返回 true 表示「还有活」，会立即再跑一轮。
 */
export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = true;
  private current: Promise<void> | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<boolean | void>,
    private readonly log: Logger,
  ) {}

  start(signals?: Signals, wakeOn: SignalName[] = []): void {
    this.stopped = false;
    for (const s of wakeOn) if (signals) this.unsubscribe.push(signals.on(s, () => this.wake()));
    this.schedule(0);
  }

  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.rerun = false;
    let more = false;
    this.current = (async () => {
      try {
        more = (await this.fn()) === true;
      } catch (err) {
        this.log.warn({ err, loop: this.name }, 'background loop iteration failed');
      }
    })();
    await this.current;
    this.current = null;
    this.running = false;
    this.schedule(more || this.rerun ? 0 : this.intervalMs);
  }
}
