import { EventEmitter } from 'node:events';

export type SignalName = 'outbox' | 'resolver' | 'inbox' | 'agent' | 'sequence' | 'jobs' | 'media' | 'accounts';

/** 进程内唤醒信号：只是让后台循环提早跑一轮，正确性不依赖它（都有轮询兜底） */
export class Signals {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  wake(name: SignalName): void {
    this.emitter.emit(name);
  }

  on(name: SignalName, fn: () => void): () => void {
    this.emitter.on(name, fn);
    return () => this.emitter.off(name, fn);
  }
}
