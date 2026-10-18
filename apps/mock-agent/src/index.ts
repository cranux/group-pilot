import { fastify, type FastifyReply } from 'fastify';
import type { AddressInfo } from 'node:net';
import { applyChaos, defaultAudit, defaultBrain, parseTriggerContext } from './brain.js';
import { ApiError, bodyOf, installHttpBasics, isRecord, Scheduler, urlFor } from './http.js';
import { validateTools } from './tools.js';

export {
  analyzeHistory,
  applyChaos,
  defaultAudit,
  defaultBrain,
  parseTriggerContext,
  type AuditVerdict,
  type TurnResponse,
} from './brain.js';
export { TOOL_NAMES, TOOL_PARAMS, validateTools } from './tools.js';

export interface MockAgentHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface StartMockAgentOptions {
  /** 0 = 随机端口 */
  port?: number;
  /** 默认 127.0.0.1 */
  host?: string;
  /** 默认大脑（以及未指定 delayMs 的脚本化 turn 响应）的响应延迟，默认 0 */
  defaultDelayMs?: number;
  /** 随机坏行为，默认 false */
  chaos?: boolean;
  logger?: boolean;
}

export interface ScriptedResponse {
  /** 默认 200 */
  status?: number;
  /** 原样返回的响应体（最高优先级，用于坏 JSON / 围栏 / 夹文字） */
  body?: string;
  /** 序列化后返回 */
  json?: unknown;
  /** 便捷写法 → 合法的 tool_use 响应（id 缺省自动生成） */
  toolUse?: { name: string; input: unknown; id?: string };
  /** 便捷写法 → { stop_reason: 'end_turn', content: [{ type: 'text', text }] } */
  endTurn?: string;
  delayMs?: number;
  /** 挂起不响应 */
  noResponse?: boolean;
}

export interface AgentConfig {
  defaultDelayMs: number;
  chaos: boolean;
}

export interface AgentRequestLog {
  at: number;
  kind: 'turn' | 'audit';
  runId: string | null;
  groupId: string | null;
  body: unknown;
  /** 响应状态码；挂起不响应时为 null */
  responseStatus: number | null;
  /** 实际返回的原始响应体 */
  responseBody: string | null;
  /** 响应来源：script（脚本队列）/ default（默认大脑）/ invalid（请求校验失败） */
  source: 'script' | 'default' | 'invalid';
  /** CHAOS 注入的坏行为 */
  chaos?: string[];
  /** 客户端在响应写完前断开（例如后端超时） */
  clientAborted?: boolean;
}

const MAX_LOG = 10_000;

function parseScript(v: unknown, i: number): ScriptedResponse {
  if (!isRecord(v)) throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}] must be an object`);
  const s: ScriptedResponse = {};
  if (v.status !== undefined) {
    if (typeof v.status !== 'number' || !Number.isInteger(v.status) || v.status < 100 || v.status > 599) {
      throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].status must be an HTTP status code`);
    }
    s.status = v.status;
  }
  if (v.body !== undefined) {
    if (typeof v.body !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].body must be a string`);
    s.body = v.body;
  }
  if ('json' in v) s.json = v.json;
  if (v.toolUse !== undefined) {
    const t = v.toolUse;
    if (!isRecord(t) || typeof t.name !== 'string' || (t.id !== undefined && typeof t.id !== 'string')) {
      throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].toolUse must be { name, input, id? }`);
    }
    s.toolUse = { name: t.name, input: t.input ?? {}, ...(typeof t.id === 'string' ? { id: t.id } : {}) };
  }
  if (v.endTurn !== undefined) {
    if (typeof v.endTurn !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].endTurn must be a string`);
    s.endTurn = v.endTurn;
  }
  if (v.delayMs !== undefined) {
    if (typeof v.delayMs !== 'number' || !Number.isFinite(v.delayMs) || v.delayMs < 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].delayMs must be a non-negative number`);
    }
    s.delayMs = v.delayMs;
  }
  if (v.noResponse !== undefined) {
    if (typeof v.noResponse !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', `responses[${i}].noResponse must be a boolean`);
    s.noResponse = v.noResponse;
  }
  return s;
}

function parseScripts(body: Record<string, unknown>): ScriptedResponse[] {
  if (!Array.isArray(body.responses)) throw new ApiError(400, 'VALIDATION_ERROR', 'responses must be an array');
  return body.responses.map(parseScript);
}

function parseConfigPatch(base: AgentConfig, patch: Record<string, unknown>): AgentConfig {
  const next = { ...base };
  if (patch.defaultDelayMs !== undefined) {
    const d = patch.defaultDelayMs;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'defaultDelayMs must be a non-negative number');
    }
    next.defaultDelayMs = d;
  }
  if (patch.chaos !== undefined) {
    if (typeof patch.chaos !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', 'chaos must be a boolean');
    next.chaos = patch.chaos;
  }
  return next;
}

export async function startMockAgent(opts: StartMockAgentOptions = {}): Promise<MockAgentHandle> {
  const initialConfig = parseConfigPatch({ defaultDelayMs: 0, chaos: false }, {
    defaultDelayMs: opts.defaultDelayMs,
    chaos: opts.chaos,
  });
  let config: AgentConfig = { ...initialConfig };
  const runQueues = new Map<string, ScriptedResponse[]>();
  let globalQueue: ScriptedResponse[] = [];
  let auditQueue: ScriptedResponse[] = [];
  let requests: AgentRequestLog[] = [];
  // tool_use.id 全局自增（跨 run 唯一；reset 不归零）
  let toolUseSeq = 0;
  const newId = () => `tu_${++toolUseSeq}`;
  const timers = new Scheduler();

  const popTurn = (runId: string): ScriptedResponse | undefined => {
    const q = runQueues.get(runId);
    if (q && q.length) {
      const s = q.shift();
      if (!q.length) runQueues.delete(runId);
      return s;
    }
    return globalQueue.shift();
  };

  const log = (entry: AgentRequestLog) => {
    requests.push(entry);
    if (requests.length > MAX_LOG) requests.splice(0, requests.length - MAX_LOG);
    return entry;
  };

  const respond = (reply: FastifyReply, entry: AgentRequestLog, status: number, raw: string) => {
    entry.responseStatus = status;
    entry.responseBody = raw;
    return reply.code(status).header('content-type', 'application/json; charset=utf-8').send(raw);
  };

  const trackAbort = (reply: FastifyReply, entry: AgentRequestLog) => {
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) entry.clientAborted = true;
    });
  };

  const respondScripted = async (
    reply: FastifyReply,
    entry: AgentRequestLog,
    s: ScriptedResponse,
    fallback: () => unknown,
    defaultDelayMs: number,
  ) => {
    entry.source = 'script';
    if (s.noResponse) {
      reply.hijack();
      return;
    }
    await timers.sleep(s.delayMs ?? defaultDelayMs);
    const status = s.status ?? 200;
    let raw: string;
    if (typeof s.body === 'string') raw = s.body;
    else if (s.json !== undefined) raw = JSON.stringify(s.json);
    else if (s.toolUse) {
      raw = JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: s.toolUse.id ?? newId(), name: s.toolUse.name, input: s.toolUse.input }],
      });
    } else if (s.endTurn !== undefined) {
      raw = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: s.endTurn }] });
    } else if (status < 200 || status >= 300) {
      raw = JSON.stringify({ code: 'SCRIPTED_ERROR', message: `scripted ${status} response` });
    } else {
      // 只指定了 status / delayMs：延迟后返回默认结果
      raw = JSON.stringify(fallback());
    }
    return respond(reply, entry, status, raw);
  };

  const app = fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, forceCloseConnections: true });
  installHttpBasics(app);

  app.post('/agent/turn', async (req, reply) => {
    const body = bodyOf(req.body);
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : null;
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const entry = log({
      at: Date.now(),
      kind: 'turn',
      runId,
      groupId: messages ? parseTriggerContext(messages).groupId : null,
      body: req.body ?? null,
      responseStatus: null,
      responseBody: null,
      source: 'invalid',
    });
    trackAbort(reply, entry);

    const toolsError = validateTools(body.tools);
    if (toolsError) return respond(reply, entry, 400, JSON.stringify({ code: 'TOOLS_INVALID', message: toolsError }));
    if (!runId) return respond(reply, entry, 400, JSON.stringify({ code: 'INVALID_REQUEST', message: 'runId is required' }));
    if (!messages || messages.length === 0) {
      return respond(reply, entry, 400, JSON.stringify({ code: 'INVALID_REQUEST', message: 'messages must be a non-empty array' }));
    }

    const scripted = popTurn(runId);
    if (scripted) {
      return respondScripted(reply, entry, scripted, () => defaultBrain(messages, newId), config.defaultDelayMs);
    }

    entry.source = 'default';
    const out = defaultBrain(messages, newId);
    let raw = JSON.stringify(out);
    let delay = config.defaultDelayMs;
    if (config.chaos) {
      const c = applyChaos(out, messages, newId);
      raw = c.raw;
      delay += c.extraDelayMs;
      if (c.kinds.length) entry.chaos = c.kinds;
    }
    await timers.sleep(delay);
    return respond(reply, entry, 200, raw);
  });

  app.post('/agent/audit', async (req, reply) => {
    const body = bodyOf(req.body);
    const entry = log({
      at: Date.now(),
      kind: 'audit',
      runId: typeof body.runId === 'string' ? body.runId : null,
      groupId: typeof body.groupId === 'string' ? body.groupId : null,
      body: req.body ?? null,
      responseStatus: null,
      responseBody: null,
      source: 'invalid',
    });
    trackAbort(reply, entry);
    const text = body.text;
    if (typeof text !== 'string') {
      return respond(reply, entry, 400, JSON.stringify({ code: 'INVALID_REQUEST', message: 'text must be a string' }));
    }
    const scripted = auditQueue.shift();
    if (scripted) return respondScripted(reply, entry, scripted, () => defaultAudit(text), 0);
    entry.source = 'default';
    return respond(reply, entry, 200, JSON.stringify(defaultAudit(text)));
  });

  // ── 控制接口 ──
  app.post('/_control/turn-script', async (req) => {
    const body = bodyOf(req.body);
    const responses = parseScripts(body);
    const runId = body.runId;
    if (runId !== undefined && runId !== null && (typeof runId !== 'string' || runId.length === 0)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'runId must be a non-empty string');
    }
    if (typeof runId === 'string') {
      const q = runQueues.get(runId) ?? [];
      q.push(...responses);
      runQueues.set(runId, q);
      return { runId, queued: q.length };
    }
    globalQueue.push(...responses);
    return { runId: null, queued: globalQueue.length };
  });

  app.post('/_control/audit-script', async (req) => {
    auditQueue.push(...parseScripts(bodyOf(req.body)));
    return { queued: auditQueue.length };
  });

  app.get('/_control/scripts', async () => ({
    global: globalQueue,
    runs: Object.fromEntries(runQueues),
    audit: auditQueue,
  }));

  app.get('/_control/config', async () => config);

  app.patch('/_control/config', async (req) => {
    config = parseConfigPatch(config, bodyOf(req.body));
    return config;
  });

  app.get('/_control/requests', async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return requests.filter((r) => (!q.kind || r.kind === q.kind) && (!q.runId || r.runId === q.runId));
  });

  app.delete('/_control/requests', async () => {
    const removed = requests.length;
    requests = [];
    return { removed };
  });

  app.get('/_control/state', async () => ({
    config,
    queues: {
      global: globalQueue.length,
      runs: Object.fromEntries([...runQueues].map(([k, v]) => [k, v.length])),
      audit: auditQueue.length,
    },
    requests: requests.length,
    lastToolUseId: toolUseSeq ? `tu_${toolUseSeq}` : null,
  }));

  app.post('/_control/reset', async () => {
    runQueues.clear();
    globalQueue = [];
    auditQueue = [];
    requests = [];
    config = { ...initialConfig };
    return { ok: true };
  });

  app.addHook('onClose', async () => timers.cancelAll());

  const host = opts.host ?? '127.0.0.1';
  await app.listen({ port: opts.port ?? 0, host });
  const port = (app.server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    url: urlFor(host, port),
    port,
    close: () => (closing ??= app.close().then(() => undefined)),
  };
}
