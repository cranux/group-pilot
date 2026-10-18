import type { FastifyInstance } from 'fastify';
import { ConfigError, mergeConfig } from './config.js';
import { ENDPOINTS, type EndpointName, type FaultMatch, type ForbidMode, type Gateway } from './gateway.js';
import { bodyOf, optBool, optNumber, optString, reqString } from './http.js';
import { renderPanel } from './panel.js';
import { ApiError, isRecord } from './util.js';

type Params = Record<string, string>;
type Query = Record<string, string | undefined>;

/** /_control/*：故障注入、状态查看与演示面板。不受 unavailable / chaos 影响。 */
export function registerControlRoutes(app: FastifyInstance, gw: Gateway): void {
  app.get('/_control', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderPanel()));
  app.get('/_control/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderPanel()));

  // ── 故障规则 ──
  app.get('/_control/faults', async () => gw.faults);

  app.delete('/_control/faults', async () => {
    const removed = gw.faults.length;
    gw.faults = [];
    return { removed };
  });

  app.post('/_control/faults', async (req) => {
    const b = bodyOf(req.body);
    const endpoint = b.endpoint;
    if (typeof endpoint !== 'string' || !(ENDPOINTS as readonly string[]).includes(endpoint)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `endpoint must be one of ${ENDPOINTS.join(', ')}`);
    }
    const status = b.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status must be an HTTP status code');
    }
    const times = b.times === undefined || b.times === null ? 1 : b.times;
    if (typeof times !== 'number' || !Number.isInteger(times) || (times !== -1 && times < 1)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'times must be a positive integer or -1');
    }
    let match: FaultMatch | undefined;
    if (b.match !== undefined && b.match !== null) {
      if (!isRecord(b.match)) throw new ApiError(400, 'VALIDATION_ERROR', 'match must be an object');
      match = {};
      for (const k of ['accountId', 'groupId', 'clientMsgId'] as const) {
        const v = optString(b.match, k);
        if (v !== undefined) match[k] = v;
      }
    }
    if (b.body !== undefined && b.body !== null && !isRecord(b.body)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'body must be an object');
    }
    return gw.addFault({
      endpoint: endpoint as EndpointName,
      match,
      times,
      status,
      body: isRecord(b.body) ? b.body : undefined,
      delayMs: optNumber(b, 'delayMs'),
      noResponse: optBool(b, 'noResponse'),
      apply: optBool(b, 'apply'),
      applyDelayMs: optNumber(b, 'applyDelayMs'),
    });
  });

  // ── 配置 ──
  app.get('/_control/config', async () => gw.config);

  app.patch('/_control/config', async (req) => {
    const before = gw.config;
    try {
      gw.config = mergeConfig(before, req.body);
    } catch (err) {
      if (err instanceof ConfigError) throw new ApiError(400, 'VALIDATION_ERROR', err.message);
      throw err;
    }
    // 切换为不可用时断开现有 SSE，重连会拿到 503
    if (gw.config.unavailable && !before.unavailable) gw.hub.dropAll();
    return gw.config;
  });

  // ── 账号 ──
  app.post('/_control/accounts/:accountId/status', async (req) => {
    const { accountId } = req.params as Params;
    const b = bodyOf(req.body);
    const status = b.status;
    if (status !== 'suspended' && status !== 'session_expired') {
      throw new ApiError(400, 'VALIDATION_ERROR', "status must be 'suspended' or 'session_expired'");
    }
    const push = optBool(b, 'push') ?? true;
    return { accountId, status, ...gw.setTerminal(accountId, status, push) };
  });

  app.post('/_control/accounts/:accountId/rate-limit', async (req) => {
    const { accountId } = req.params as Params;
    const retryAfterSeconds = optNumber(bodyOf(req.body), 'retryAfterSeconds') ?? 3;
    return { accountId, retryAfterSeconds, ...gw.setRateLimit(accountId, retryAfterSeconds) };
  });

  app.post('/_control/accounts/:accountId/redeliver', async (req) => {
    const { accountId } = req.params as Params;
    return gw.redeliver(accountId);
  });

  // ── 群 ──
  app.post('/_control/groups/:groupId/forbid', async (req) => {
    const { groupId } = req.params as Params;
    const mode = bodyOf(req.body).mode ?? null;
    if (mode !== 'sync' && mode !== 'async' && mode !== null) {
      throw new ApiError(400, 'VALIDATION_ERROR', "mode must be 'sync', 'async' or null");
    }
    gw.setForbid(groupId, mode as ForbidMode);
    return { groupId, forbid: mode };
  });

  app.post('/_control/groups/:groupId/external-join', async (req) => {
    const { groupId } = req.params as Params;
    const platformUserId = reqString(bodyOf(req.body), 'platformUserId');
    // 已是成员时 joined=false，不推事件
    return { groupId, platformUserId, joined: gw.externalJoin(groupId, platformUserId) };
  });

  app.post('/_control/groups/:groupId/external-leave', async (req) => {
    const { groupId } = req.params as Params;
    const platformUserId = reqString(bodyOf(req.body), 'platformUserId');
    // 不是成员时 left=false，不推事件
    return { groupId, platformUserId, left: gw.externalLeave(groupId, platformUserId) };
  });

  app.post('/_control/groups/:groupId/external-message', async (req) => {
    const { groupId } = req.params as Params;
    const b = bodyOf(req.body);
    const sentAt = optString(b, 'sentAt');
    if (sentAt !== undefined && Number.isNaN(Date.parse(sentAt))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sentAt must be an ISO date string');
    }
    return gw.externalMessage({
      groupId,
      platformUserId: reqString(b, 'platformUserId'),
      text: reqString(b, 'text', { allowEmpty: true }),
      withMedia: optBool(b, 'withMedia'),
      mediaTtlMs: optNumber(b, 'mediaTtlMs'),
      sentAt: sentAt === undefined ? undefined : new Date(sentAt).toISOString(),
    });
  });

  app.post('/_control/groups/:groupId/expire-invites', async (req) => {
    const { groupId } = req.params as Params;
    return { expired: gw.expireInvites(groupId) };
  });

  // ── 事件 ──
  app.post('/_control/events', async (req) => {
    const b = bodyOf(req.body);
    const type = reqString(b, 'type');
    const data = b.data === undefined || b.data === null ? {} : b.data;
    if (!isRecord(data)) throw new ApiError(400, 'VALIDATION_ERROR', 'data must be an object');
    return { eventId: gw.emit(type, data).eventId };
  });

  app.get('/_control/events', async (req) => {
    const q = (req.query ?? {}) as Query;
    const since = q.since ? Number(q.since) : 0;
    let list = gw.hub.since(Number.isFinite(since) ? since : 0);
    if (q.type) list = list.filter((e) => e.type === q.type);
    const limit = q.limit ? Number(q.limit) : 0;
    if (limit > 0) list = list.slice(-limit);
    return list;
  });

  app.post('/_control/sse/drop', async () => ({ dropped: gw.hub.dropAll() }));

  // ── 请求日志 / 消息 / 全局状态 ──
  app.get('/_control/requests', async (req) => {
    const q = (req.query ?? {}) as Query;
    return gw.requests.filter(
      (r) =>
        (!q.endpoint || r.endpoint === q.endpoint) &&
        (!q.accountId || r.accountIds.includes(q.accountId)) &&
        (!q.groupId || r.groupId === q.groupId) &&
        (!q.clientMsgId || r.clientMsgId === q.clientMsgId),
    );
  });

  app.delete('/_control/requests', async () => {
    const removed = gw.requests.length;
    gw.requests = [];
    return { removed };
  });

  app.get('/_control/messages', async (req) => {
    const q = (req.query ?? {}) as Query;
    return gw.messages.filter((m) => !q.groupId || m.groupId === q.groupId);
  });

  app.get('/_control/state', async () => gw.snapshot());

  app.post('/_control/reset', async () => {
    gw.reset();
    return { ok: true, lastEventId: gw.hub.lastEventId };
  });
}
