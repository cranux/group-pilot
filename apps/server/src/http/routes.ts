import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../accounts/service.js';
import type { AgentRunService } from '../agent/service.js';
import type { AuthService, AuthUser } from '../auth/service.js';
import type { AppContext } from '../context.js';
import type { GroupService } from '../groups/service.js';
import { jobDto, type JobRow } from '../jobs/runner.js';
import { AppError, Errors } from '../lib/errors.js';
import type { SequenceService } from '../sequences/service.js';
import { parseBody } from './validate.js';

export const REFRESH_COOKIE = 'gp_refresh';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface Services {
  auth: AuthService;
  accounts: AccountService;
  groups: GroupService;
  agentRuns: AgentRunService;
  sequences: SequenceService;
}

const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, requestId: req.id, ...err.extra } });
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      return reply.status(status).send({ error: { code, message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.url} 不存在`, requestId: req.id } }),
  );
}

export function registerAuthHook(app: FastifyInstance, auth: AuthService): void {
  app.addHook('onRequest', async (req) => {
    // 按路由器实际命中的路由模式判断，不能看原始 req.url：路由器会先解码 %XX、去掉绝对 URL 的
    // scheme+host 再匹配，/%61pi/... 或 http://host/api/... 在原始字符串上不以 /api/ 开头却照样命中 /api 路由。
    // 没命中任何路由（404）时同样要求登录，不向未登录者暴露哪些路径存在
    const route = req.routeOptions.url;
    if (route !== undefined && (!route.startsWith('/api/') || PUBLIC_ROUTES.has(route))) return;
    req.user = await auth.verifyAccess(bearer(req));
    // viewer 对所有写操作得到 403
    if (!READ_METHODS.has(req.method) && req.user.role !== 'admin') throw Errors.forbidden();
  });
}

function setRefreshCookie(reply: FastifyReply, ctx: AppContext, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    path: '/api/auth',
    maxAge: ctx.config.refreshTokenTtlSec,
  });
}

function clearRefreshCookie(reply: FastifyReply, ctx: AppContext): void {
  reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure });
}

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const transitionSchema = z.object({ to: z.unknown(), expectedFrom: z.unknown() });

type IdParams = { Params: { id: string } };

export function registerRoutes(app: FastifyInstance, ctx: AppContext, s: Services, schemaVersion: () => Promise<number | null>): void {
  // ---------- 健康检查 ----------
  app.get('/api/health', async (_req, reply) => {
    try {
      const v = await schemaVersion();
      return { ok: true, schemaVersion: v };
    } catch {
      return reply.status(503).send({ ok: false, schemaVersion: null });
    }
  });

  // ---------- 认证 ----------
  app.post('/api/auth/login', async (req, reply) => {
    const body = parseBody(loginSchema, req.body);
    const issued = await s.auth.login(body.username, body.password);
    setRefreshCookie(reply, ctx, issued.refreshToken);
    return { accessToken: issued.accessToken, user: issued.user };
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    try {
      const issued = await s.auth.refresh(req.cookies[REFRESH_COOKIE]);
      setRefreshCookie(reply, ctx, issued.refreshToken);
      return { accessToken: issued.accessToken, user: issued.user };
    } catch (err) {
      clearRefreshCookie(reply, ctx);
      throw err;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await s.auth.logout({ accessToken: bearer(req), refreshToken: req.cookies[REFRESH_COOKIE] });
    clearRefreshCookie(reply, ctx);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => ({ username: req.user!.username, role: req.user!.role }));

  // ---------- 账号 ----------
  app.get('/api/accounts', async () => s.accounts.list());
  app.post<IdParams>('/api/accounts/:id/connect', async (req) => s.accounts.connect(req.params.id));
  app.post<IdParams>('/api/accounts/:id/transition', async (req) => {
    const body = parseBody(transitionSchema, req.body);
    return s.accounts.transition(req.params.id, body.to, body.expectedFrom);
  });

  // ---------- 群 ----------
  app.post('/api/groups', async (req, reply) => reply.status(202).send(await s.groups.create(req.body)));
  app.get('/api/groups', async () => s.groups.list());
  app.get<IdParams>('/api/groups/:id', async (req) => s.groups.get(req.params.id));
  app.patch<IdParams>('/api/groups/:id', async (req) => s.groups.patch(req.params.id, req.body));
  app.post<IdParams>('/api/groups/:id/send', async (req, reply) => reply.status(202).send(await s.groups.send(req.params.id, req.body)));
  app.post<IdParams>('/api/groups/:id/leave-all', async (req, reply) => reply.status(202).send(await s.groups.leaveAll(req.params.id)));
  app.get<IdParams & { Querystring: { before?: string; limit?: string } }>('/api/groups/:id/messages', async (req) =>
    s.groups.messages(req.params.id, req.query),
  );
  app.get<IdParams>('/api/groups/:id/agent-runs', async (req) => s.agentRuns.listForGroup(req.params.id));

  // ---------- 序列 ----------
  app.post('/api/sequences', async (req, reply) => reply.status(201).send(await s.sequences.create(req.body)));
  app.get('/api/sequences', async () => s.sequences.list());
  app.get<IdParams>('/api/sequences/:id', async (req) => s.sequences.get(req.params.id));
  app.post<IdParams>('/api/groups/:id/sequence-runs/preflight', async (req) => {
    const { steps } = await s.sequences.preflight(req.params.id, req.body);
    return {
      steps: steps.map((st) => ({
        index: st.index,
        accountRole: st.accountRole,
        text: st.text,
        delaySeconds: st.delaySeconds,
        resolvedText: st.resolvedText,
        resolvedVars: st.resolvedVars,
        varSources: st.varSources,
      })),
    };
  });
  app.post<IdParams>('/api/groups/:id/sequence-runs', async (req, reply) =>
    reply.status(201).send(await s.sequences.start(req.params.id, req.body)),
  );
  app.get<IdParams>('/api/groups/:id/sequence-runs', async (req) => {
    await s.groups.get(req.params.id);
    return s.sequences.listRuns(req.params.id);
  });
  app.get<IdParams>('/api/sequence-runs/:id', async (req) => s.sequences.getRun(req.params.id));

  // ---------- job / agent run ----------
  app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (req) => {
    if (!z.string().uuid().safeParse(req.params.jobId).success) throw Errors.notFound('JOB_NOT_FOUND', 'job 不存在');
    const row = await ctx.db.one<JobRow>('SELECT * FROM jobs WHERE id = $1', [req.params.jobId]);
    if (!row) throw Errors.notFound('JOB_NOT_FOUND', 'job 不存在');
    return jobDto(row);
  });
  app.get<IdParams>('/api/agent-runs/:id', async (req) => s.agentRuns.get(req.params.id));

  // ---------- 媒体文件（C1） ----------
  app.get<IdParams>('/api/messages/:id/media', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) throw Errors.notFound('MEDIA_NOT_FOUND', '文件不存在');
    const row = await ctx.db.one<{ local_file_path: string | null }>('SELECT local_file_path FROM messages WHERE id = $1', [id]);
    if (!row?.local_file_path || !fs.existsSync(row.local_file_path)) throw Errors.notFound('MEDIA_NOT_FOUND', '文件不存在');
    reply.header('content-disposition', `inline; filename="${path.basename(row.local_file_path)}"`);
    return reply.send(fs.createReadStream(row.local_file_path));
  });
}
