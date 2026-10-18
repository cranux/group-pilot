import type { FastifyError, FastifyInstance } from 'fastify';
import { ApiError, isRecord } from './util.js';

/** 两个通用设置：宽松的 JSON 解析（空 body 视为 {}）+ 扁平错误体 */
export function installHttpBasics(app: FastifyInstance, name: string): void {
  const parse = (body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
    const s = typeof body === 'string' ? body : body.toString('utf8');
    if (s.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch {
      done(new ApiError(400, 'VALIDATION_ERROR', 'request body is not valid JSON'));
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
      reply.code(err.status).send(err.toBody());
      return;
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error(`[${name}] unhandled error`, err);
    const code =
      status === 400
        ? 'VALIDATION_ERROR'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : status >= 500
              ? 'INTERNAL_ERROR'
              : (err.code ?? 'ERROR');
    reply.code(status).send({ code, message: err.message });
  });
}

export function bodyOf(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

export function reqString(body: Record<string, unknown>, key: string, opts: { allowEmpty?: boolean } = {}): string {
  const v = body[key];
  if (typeof v !== 'string' || (!opts.allowEmpty && v.length === 0)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${key} must be a ${opts.allowEmpty ? '' : 'non-empty '}string`);
  }
  return v;
}

export function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${key} must be a string`);
  return v;
}

export function optNumber(body: Record<string, unknown>, key: string, min = 0): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${key} must be a number >= ${min}`);
  }
  return v;
}

export function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', `${key} must be a boolean`);
  return v;
}

/** 把监听地址转换为可访问的 URL */
export function urlFor(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}
