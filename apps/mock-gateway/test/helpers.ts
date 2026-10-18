export interface SseEvent {
  eventId: number;
  type: string;
  [k: string]: unknown;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function client(base: string) {
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON（例如媒体字节）原样返回 */
    }
    return { status: res.status, body: parsed as T };
  };
  return {
    get: <T = any>(p: string) => call<T>('GET', p),
    post: <T = any>(p: string, b: unknown = {}) => call<T>('POST', p, b),
    patch: <T = any>(p: string, b: unknown) => call<T>('PATCH', p, b),
    del: <T = any>(p: string) => call<T>('DELETE', p),
  };
}

type Falsy = undefined | null | false;

export async function waitFor<T>(
  fn: () => T | Falsy | Promise<T | Falsy>,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 极简 SSE 客户端：收集所有 data 帧 */
export async function openSse(base: string, since?: number) {
  const ac = new AbortController();
  const res = await fetch(base + '/events' + (since === undefined ? '' : `?since=${since}`), { signal: ac.signal });
  const events: SseEvent[] = [];
  const frames: { id: string | null; event: string | null }[] = [];
  let ended = false;
  const done = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null;
          let event: string | null = null;
          let data: string | null = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (data !== null) {
            frames.push({ id, event });
            events.push(JSON.parse(data) as SseEvent);
          }
        }
      }
    } catch {
      /* aborted */
    } finally {
      ended = true;
    }
  })();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    events,
    frames,
    get ended() {
      return ended;
    },
    done,
    close: () => ac.abort(),
    waitFor: (pred: (e: SseEvent) => boolean, timeoutMs = 3000) => waitFor(() => events.find(pred), timeoutMs),
  };
}
