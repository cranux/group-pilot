import type { ToolDefinition } from './protocol.js';

export interface RawHttpResult {
  /** 0 = 没拿到响应（超时 / 网络错误） */
  status: number;
  body: string;
  timedOut: boolean;
  error?: string;
}

/** 调用 Agent 服务；只负责拿到原始响应体，协议校验在 protocol.ts */
export class AgentClient {
  constructor(readonly baseUrl: string) {}

  turn(
    payload: { runId: string; tools: ToolDefinition[]; messages: unknown[] },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RawHttpResult> {
    return this.post('/agent/turn', payload, timeoutMs, signal);
  }

  audit(payload: { text: string; groupId: string }, timeoutMs: number, signal?: AbortSignal): Promise<RawHttpResult> {
    return this.post('/agent/audit', payload, timeoutMs, signal);
  }

  private async post(path: string, payload: unknown, timeoutMs: number, outer?: AbortSignal): Promise<RawHttpResult> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, Math.max(1, timeoutMs));
    const onOuterAbort = () => ac.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      // 超时后才到的响应体直接丢弃（读取同样受 signal 约束）
      const body = await res.text();
      return { status: res.status, body, timedOut: false };
    } catch (err) {
      return { status: 0, body: '', timedOut, error: timedOut ? 'timeout' : String((err as Error)?.message ?? err) };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }
}
