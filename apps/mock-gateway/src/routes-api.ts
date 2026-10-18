import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApplyMode, EndpointName, FaultRule, Gateway, RequestContext, RequestLogEntry } from './gateway.js';
import { bodyOf, reqString } from './http.js';
import { ApiError, randInt, type Reply } from './util.js';

/**
 * 路由元数据，经 fastify 路由选项的 `config` 传入。
 * 不做 `declare module 'fastify'` 全局增强，以免影响直接 import 本包源码的后端类型。
 */
interface RouteMeta {
  /** 业务端点名（与故障规则 / 请求日志的 endpoint 一致） */
  endpoint?: EndpointName;
  /** SSE 事件流 */
  sse?: boolean;
}

interface Tracked {
  ctx: RequestContext;
  entry: RequestLogEntry;
}

type Params = Record<string, string>;

/** 公开端点（题目 2.1） */
export function registerApiRoutes(app: FastifyInstance, gw: Gateway): void {
  const tracked = new WeakMap<FastifyRequest, Tracked>();

  // 请求日志 + 整体不可用 + chaos 随机 503。均在路由匹配与 body 解析之后、处理之前。
  app.addHook('preHandler', async (req, reply) => {
    const cfg = req.routeOptions.config as RouteMeta;
    const endpoint = cfg.endpoint;
    if (endpoint) {
      const params = (req.params ?? {}) as Params;
      const body = bodyOf(req.body);
      const accountIds = [params.accountId, body.accountId, body.byAccountId, body.creatorAccountId].filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      );
      const groupId = params.groupId ?? (endpoint === 'media' && params.id ? gw.mediaGroupId(params.id) : undefined);
      const clientMsgId =
        params.clientMsgId ?? (typeof body.clientMsgId === 'string' ? body.clientMsgId : undefined);
      const ctx: RequestContext = { endpoint, accountIds, groupId, clientMsgId };
      const entry: RequestLogEntry = {
        at: Date.now(),
        endpoint,
        method: req.method,
        path: req.url,
        body: req.body ?? null,
        status: null,
        accountId: accountIds[0] ?? null,
        accountIds,
        groupId: groupId ?? null,
        clientMsgId: clientMsgId ?? null,
      };
      gw.logRequest(entry);
      tracked.set(req, { ctx, entry });
    }
    if (endpoint || cfg.sse) {
      if (gw.config.unavailable) {
        return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE', message: 'gateway is unavailable' });
      }
      if (gw.config.chaos && Math.random() < 0.02) {
        return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE', message: 'gateway is unavailable (chaos)' });
      }
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const t = tracked.get(req);
    if (t) t.entry.status = reply.statusCode;
  });

  const sendReply = (reply: FastifyReply, r: Reply) => {
    reply.code(r.status);
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.send(r.body);
  };

  /** 故障规则匹配 → 假响应（可 apply 真实操作 / 延迟 / 挂起）；否则正常处理 */
  const pipeline = async (
    req: FastifyRequest,
    reply: FastifyReply,
    run: (mode: ApplyMode) => Reply | Promise<Reply>,
    opts: { chaosSend?: boolean } = {},
  ) => {
    const t = tracked.get(req);
    let rule: FaultRule | null = t ? gw.takeFault(t.ctx) : null;
    if (!rule && opts.chaosSend && gw.config.chaos && Math.random() < 0.05) {
      // chaos：5% 的 send 返回 504，其中一半实际落地（2 秒内）
      rule = {
        id: 'chaos',
        endpoint: 'send',
        times: 1,
        hits: 1,
        status: 504,
        body: { code: 'NETWORK_TIMEOUT', message: 'gateway timeout (chaos)' },
        delayMs: randInt(0, 1500),
        apply: Math.random() < 0.5,
        applyDelayMs: randInt(100, 1800),
      };
    }
    if (rule) {
      if (rule.apply) {
        try {
          const p = run({ applied: true, applyDelayMs: rule.applyDelayMs });
          if (p instanceof Promise) p.catch(() => undefined);
        } catch {
          // apply 时真实操作失败（例如不在群里）：照样返回注入的响应
        }
      }
      if (rule.noResponse) {
        // 挂起：不写任何响应，直到客户端断开（或服务关闭）
        reply.hijack();
        return;
      }
      if (rule.delayMs) await gw.req.sleep(rule.delayMs);
      return reply.code(rule.status).send(gw.faultBody(rule));
    }
    return sendReply(reply, await run({ applied: false }));
  };

  app.post('/accounts/:accountId/connect', { config: { endpoint: 'connect' } }, async (req, reply) => {
    const { accountId } = req.params as Params;
    gw.assertNotTerminal(accountId);
    return pipeline(req, reply, () => gw.connect(accountId));
  });

  app.post('/accounts/:accountId/disconnect', { config: { endpoint: 'disconnect' } }, async (req, reply) => {
    const { accountId } = req.params as Params;
    gw.assertNotTerminal(accountId);
    return pipeline(req, reply, () => gw.disconnect(accountId));
  });

  app.post('/groups', { config: { endpoint: 'createGroup' } }, async (req, reply) => {
    const creatorAccountId = reqString(bodyOf(req.body), 'creatorAccountId');
    gw.assertUsable(creatorAccountId);
    return pipeline(req, reply, () => gw.createGroup(creatorAccountId));
  });

  app.post('/groups/:groupId/invite', { config: { endpoint: 'invite' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    gw.requireGroup(groupId);
    return pipeline(req, reply, () => gw.invite(groupId));
  });

  app.post('/groups/:groupId/join', { config: { endpoint: 'join' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    const body = bodyOf(req.body);
    const accountId = reqString(body, 'accountId');
    const inviteLink = reqString(body, 'inviteLink');
    gw.assertUsable(accountId);
    gw.requireGroup(groupId);
    return pipeline(req, reply, () => gw.join(groupId, accountId, inviteLink));
  });

  app.post('/groups/:groupId/promote', { config: { endpoint: 'promote' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    const body = bodyOf(req.body);
    const byAccountId = reqString(body, 'byAccountId');
    const accountId = reqString(body, 'accountId');
    gw.assertUsable(byAccountId);
    gw.requireGroup(groupId);
    return pipeline(req, reply, () => gw.promote(groupId, byAccountId, accountId));
  });

  app.post('/groups/:groupId/kick', { config: { endpoint: 'kick' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    const body = bodyOf(req.body);
    const byAccountId = reqString(body, 'byAccountId');
    const target = reqString(body, 'targetPlatformUserId');
    gw.assertUsable(byAccountId);
    gw.requireGroup(groupId);
    return pipeline(req, reply, (mode) => gw.kick(groupId, byAccountId, target, mode));
  });

  app.post('/groups/:groupId/leave', { config: { endpoint: 'leave' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    const accountId = reqString(bodyOf(req.body), 'accountId');
    gw.assertUsable(accountId);
    gw.requireGroup(groupId);
    return pipeline(req, reply, () => gw.leave(groupId, accountId));
  });

  app.get('/groups/:groupId/members', { config: { endpoint: 'members' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    gw.requireGroup(groupId);
    return pipeline(req, reply, () => gw.members(groupId));
  });

  app.post('/groups/:groupId/send', { config: { endpoint: 'send' } }, async (req, reply) => {
    const { groupId } = req.params as Params;
    const body = bodyOf(req.body);
    const accountId = reqString(body, 'accountId');
    const clientMsgId = reqString(body, 'clientMsgId');
    const text = reqString(body, 'text', { allowEmpty: true });
    gw.assertUsable(accountId);
    gw.requireGroup(groupId);
    return pipeline(req, reply, (mode) => gw.send(groupId, accountId, clientMsgId, text, mode), { chaosSend: true });
  });

  app.get(
    '/groups/:groupId/messages/by-client-id/:clientMsgId',
    { config: { endpoint: 'byClientId' } },
    async (req, reply) => {
      const { groupId, clientMsgId } = req.params as Params;
      gw.requireGroup(groupId);
      return pipeline(req, reply, () => gw.byClientId(groupId, clientMsgId));
    },
  );

  app.get('/media/:id', { config: { endpoint: 'media' } }, async (req, reply) => {
    const { id } = req.params as Params;
    return pipeline(req, reply, () => {
      const f = gw.getMedia(id);
      return {
        status: 200,
        body: f.bytes,
        headers: { 'content-type': f.contentType, 'cache-control': 'no-store' },
      };
    });
  });

  app.get('/events', { config: { sse: true } }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const header = req.headers['last-event-id'];
    const raw = q.since ?? (Array.isArray(header) ? header[0] : header);
    let since: number | null = null;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'since must be a non-negative integer');
      }
      since = n;
    }
    reply.hijack();
    const res = reply.raw;
    req.raw.socket.setNoDelay(true);
    req.raw.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    gw.hub.attach(res, since);
  });
}
