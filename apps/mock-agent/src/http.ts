import type { FastifyError, FastifyInstance } from 'fastify';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function bodyOf(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

/** 宽松 JSON 解析（空 body 视为 {}）+ 扁平错误体 `{ code, message }` */
export function installHttpBasics(app: FastifyInstance): void {
  const parse = (body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
    const s = typeof body === 'string' ? body : body.toString('utf8');
    if (s.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch {
      done(new ApiError(400, 'INVALID_REQUEST', 'request body is not valid JSON'));
    }
  };
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => parse(body, done));
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => parse(body, done));

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: `route ${req.method} ${req.url} not found` });
  });

  app.setErrorHandler((err: FastifyError | ApiError, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).send({ code: err.code, message: err.message });
      return;
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error('[mock-agent] unhandled error', err);
    reply.code(status).send({ code: status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: err.message });
  });
}

export function urlFor(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/** 可整体取消的定时器集合（close 时清空） */
export class Scheduler {
  private readonly timers = new Set<NodeJS.Timeout>();

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }

  cancelAll(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
