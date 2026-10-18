import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyChaos, defaultBrain, startMockAgent, validateTools, type MockAgentHandle } from '../src/index.js';

const TOOLS = [
  {
    name: 'get_recent_messages',
    description: '读取群里最近的消息',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, required: ['limit'] },
  },
  {
    name: 'send_message',
    description: '往群里发一条消息',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: '把用户移出群',
    input_schema: {
      type: 'object',
      properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: '结束本次运行',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

type Msg = { role: 'user' | 'assistant'; content: unknown[] };

function ctxMessage(opts: { text?: string; sender?: string; autoKick?: boolean; own?: string[]; triggers?: unknown[] } = {}): Msg {
  const ctx = {
    groupId: 'g_1',
    triggerMessages: opts.triggers ?? [
      { msgId: 'm_1', senderPlatformUserId: opts.sender ?? 'ext_1', text: opts.text ?? 'hello', sentAt: '2026-01-01T00:00:00.000Z' },
    ],
    policy: { autoKickEnabled: opts.autoKick ?? false },
    ownPlatformUserIds: opts.own ?? ['pu_a1'],
  };
  return { role: 'user', content: [{ type: 'text', text: JSON.stringify(ctx) }] };
}

let agent: MockAgentHandle;

async function post(path: string, body: unknown, init: RequestInit = {}) {
  const res = await fetch(agent.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
  return { status: res.status, text: await res.text() };
}

async function turn(runId: string, messages: Msg[]) {
  const r = await post('/agent/turn', { runId, tools: TOOLS, messages });
  return { status: r.status, text: r.text, json: (() => { try { return JSON.parse(r.text); } catch { return undefined; } })() };
}

/** 模拟后端：执行一步，把 assistant 块与 tool_result 追加进历史 */
function appendStep(messages: Msg[], resp: any, result: unknown, isError = false): void {
  messages.push({ role: 'assistant', content: resp.content });
  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: resp.content[0].id, content: JSON.stringify(result), ...(isError ? { is_error: true } : {}) }],
  });
}

beforeAll(async () => {
  agent = await startMockAgent({ port: 0 });
});

afterAll(async () => {
  await agent.close();
});

beforeEach(async () => {
  await post('/_control/reset', {});
});

describe('tools 校验', () => {
  it('合法的 4 个工具通过；缺工具 / required 不全 / 类型不符 / 未知工具 → 400 TOOLS_INVALID', async () => {
    expect(validateTools(TOOLS)).toBeNull();
    const bad = [
      TOOLS.slice(0, 3),
      [...TOOLS.slice(0, 3), { ...TOOLS[3], name: 'finish_now' }],
      TOOLS.map((t) => (t.name === 'send_message' ? { ...t, input_schema: { ...t.input_schema, required: ['text'] } } : t)),
      TOOLS.map((t) =>
        t.name === 'get_recent_messages'
          ? { ...t, input_schema: { type: 'object', properties: { limit: { type: 'string' } }, required: ['limit'] } }
          : t,
      ),
      TOOLS.map((t) => (t.name === 'finish' ? { ...t, description: '' } : t)),
      TOOLS.map((t) => (t.name === 'kick_user' ? { ...t, input_schema: { ...t.input_schema, type: 'array' } } : t)),
      [...TOOLS.slice(0, 3), TOOLS[0]],
    ];
    for (const tools of bad) {
      const r = await post('/agent/turn', { runId: 'r', tools, messages: [ctxMessage()] });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text).code).toBe('TOOLS_INVALID');
    }
  });
});

describe('默认大脑', () => {
  it('get_recent_messages → send_message → finish，tool_use.id 全局自增', async () => {
    const messages: Msg[] = [ctxMessage({ text: '你好呀' })];
    const r1 = await turn('run-1', messages);
    expect(r1.status).toBe(200);
    expect(r1.json.stop_reason).toBe('tool_use');
    expect(r1.json.content).toHaveLength(1);
    expect(r1.json.content[0]).toMatchObject({ type: 'tool_use', name: 'get_recent_messages', input: { limit: 20 } });
    appendStep(messages, r1.json, { messages: [], truncated: false });

    const r2 = await turn('run-1', messages);
    expect(r2.json.content[0]).toMatchObject({
      name: 'send_message',
      input: { text: '[bot] 收到：你好呀', idempotency_key: 'reply-m_1' },
    });
    appendStep(messages, r2.json, { clientMsgId: 'c1', deliveryStatus: 'sent' });

    const r3 = await turn('run-1', messages);
    expect(r3.json.content[0].name).toBe('finish');
    expect(r3.json.content[0].input.summary).toContain('发送了回复');

    const ids = [r1, r2, r3].map((r) => Number(String(r.json.content[0].id).replace('tu_', '')));
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(ids[2]).toBeGreaterThan(ids[1]);
    const other = await turn('run-2', [ctxMessage()]);
    expect(Number(String(other.json.content[0].id).replace('tu_', ''))).toBeGreaterThan(ids[2]);
  });

  it('疑似广告 + autoKickEnabled + 非自己 → kick_user；否则回复', () => {
    const recent = (ctx: Msg): Msg[] => {
      const m: Msg[] = [ctx];
      appendStep(m, { content: [{ type: 'tool_use', id: 'tu_x', name: 'get_recent_messages', input: { limit: 20 } }] }, { messages: [] });
      return m;
    };
    let n = 0;
    const newId = () => `t${++n}`;
    const kick = defaultBrain(recent(ctxMessage({ text: '加微信看广告', sender: 'ext_spam', autoKick: true })), newId);
    expect(kick.content[0]).toMatchObject({ name: 'kick_user', input: { platform_user_id: 'ext_spam', reason: 'spam detected' } });

    const noPolicy = defaultBrain(recent(ctxMessage({ text: 'SPAM here', autoKick: false })), newId);
    expect(noPolicy.content[0]).toMatchObject({ name: 'send_message' });
    const own = defaultBrain(recent(ctxMessage({ text: 'kick', sender: 'pu_a1', autoKick: true })), newId);
    expect(own.content[0]).toMatchObject({ name: 'send_message' });

    const long = 'x'.repeat(150);
    const reply = defaultBrain(recent(ctxMessage({ text: long })), newId);
    expect((reply.content[0] as { input: { text: string } }).input.text).toBe('[bot] 收到：' + 'x'.repeat(100));
  });

  it('assistant 消息超过 10 条直接 finish；没有触发消息时也 finish', () => {
    const m: Msg[] = [ctxMessage()];
    for (let i = 0; i < 11; i++) {
      appendStep(m, { content: [{ type: 'tool_use', id: `tu_h${i}`, name: 'search', input: {} }] }, { code: 'UNKNOWN_TOOL' }, true);
    }
    const out = defaultBrain(m, () => 'tu_z');
    expect(out.content[0]).toMatchObject({ type: 'tool_use', name: 'finish' });

    const empty: Msg[] = [ctxMessage({ triggers: [] })];
    appendStep(empty, { content: [{ type: 'tool_use', id: 'tu_r', name: 'get_recent_messages', input: { limit: 20 } }] }, { messages: [] });
    expect(defaultBrain(empty, () => 'tu_y').content[0]).toMatchObject({ name: 'finish' });
  });
});

describe('脚本化响应', () => {
  it('run 队列优先于全局队列；body 原样返回；endTurn / toolUse 便捷写法；非 2xx', async () => {
    await post('/_control/turn-script', {
      responses: [{ body: '```json\n{"stop_reason":"tool_use"}\n```' }, { endTurn: '全局结束' }],
    });
    await post('/_control/turn-script', {
      runId: 'r-a',
      responses: [{ toolUse: { name: 'delete_group', input: { all: true } } }, { status: 500 }],
    });

    const a1 = await turn('r-a', [ctxMessage()]);
    expect(a1.json).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'delete_group', input: { all: true } }] });
    expect(a1.json.content[0].id).toMatch(/^tu_\d+$/);
    const a2 = await turn('r-a', [ctxMessage()]);
    expect(a2.status).toBe(500);
    // r-a 的队列用完 → 取全局队列
    const a3 = await turn('r-a', [ctxMessage()]);
    expect(a3.status).toBe(200);
    expect(a3.text).toBe('```json\n{"stop_reason":"tool_use"}\n```');
    const b1 = await turn('r-b', [ctxMessage()]);
    expect(b1.json).toEqual({ stop_reason: 'end_turn', content: [{ type: 'text', text: '全局结束' }] });
    // 队列都空了 → 默认大脑
    const b2 = await turn('r-b', [ctxMessage()]);
    expect(b2.json.content[0].name).toBe('get_recent_messages');

    const log = await (await fetch(`${agent.url}/_control/requests?kind=turn&runId=r-a`)).json();
    expect(log.map((x: { responseStatus: number }) => x.responseStatus)).toEqual([200, 500, 200]);
    expect(log[0]).toMatchObject({ kind: 'turn', runId: 'r-a', source: 'script', body: { runId: 'r-a' } });
  });

  it('delayMs 只延迟、noResponse 挂起', async () => {
    await post('/_control/turn-script', { runId: 'slow', responses: [{ delayMs: 150 }, { noResponse: true }] });
    const t0 = Date.now();
    const slow = await turn('slow', [ctxMessage()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(slow.json.content[0].name).toBe('get_recent_messages');

    await expect(
      post('/agent/turn', { runId: 'slow', tools: TOOLS, messages: [ctxMessage()] }, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
    const log = await (await fetch(`${agent.url}/_control/requests?runId=slow`)).json();
    expect(log[1].responseStatus).toBeNull();
  });

  it('audit：默认规则与脚本队列', async () => {
    const pass = await post('/agent/audit', { text: '大家好', groupId: 'g_1' });
    expect(JSON.parse(pass.text)).toEqual({ verdict: 'pass', reason: 'ok' });
    const fail = await post('/agent/audit', { text: '这是违禁内容', groupId: 'g_1' });
    expect(JSON.parse(fail.text).verdict).toBe('fail');
    expect(JSON.parse((await post('/agent/audit', { text: 'FORBIDDEN', groupId: 'g_1' })).text).verdict).toBe('fail');

    await post('/_control/audit-script', { responses: [{ status: 500 }, { body: 'not json' }, { json: { verdict: 'maybe' } }] });
    expect((await post('/agent/audit', { text: 'x', groupId: 'g_1' })).status).toBe(500);
    expect((await post('/agent/audit', { text: 'x', groupId: 'g_1' })).text).toBe('not json');
    expect(JSON.parse((await post('/agent/audit', { text: 'x', groupId: 'g_1' })).text)).toEqual({ verdict: 'maybe' });
    expect(JSON.parse((await post('/agent/audit', { text: 'x', groupId: 'g_1' })).text).verdict).toBe('pass');

    const log = await (await fetch(`${agent.url}/_control/requests?kind=audit`)).json();
    expect(log).toHaveLength(7);
    expect(log[0]).toMatchObject({ kind: 'audit', groupId: 'g_1', responseStatus: 200 });
  });

  it('reset 清空脚本、日志并恢复配置', async () => {
    await fetch(`${agent.url}/_control/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultDelayMs: 50, chaos: true }),
    });
    await post('/_control/turn-script', { responses: [{ endTurn: 'x' }] });
    await post('/_control/reset', {});
    const cfg = await (await fetch(`${agent.url}/_control/config`)).json();
    expect(cfg).toEqual({ defaultDelayMs: 0, chaos: false });
    const r = await turn('after-reset', [ctxMessage()]);
    expect(r.json.content[0].name).toBe('get_recent_messages');
    expect(await (await fetch(`${agent.url}/_control/requests`)).json()).toHaveLength(1);
  });
});

describe('CHAOS 坏行为', () => {
  const history: Msg[] = [ctxMessage()];
  appendStep(history, { content: [{ type: 'tool_use', id: 'tu_prev', name: 'send_message', input: { text: 'hi', idempotency_key: 'k-1' } }] }, {
    clientMsgId: 'c',
    deliveryStatus: 'sent',
  });
  const base = { stop_reason: 'tool_use' as const, content: [{ type: 'tool_use' as const, id: 'tu_new', name: 'finish', input: { summary: 's' } }] };
  const seq = (...xs: number[]) => () => xs.shift() ?? 0.99;
  const ids = () => 'tu_gen';

  it('按概率区间产生围栏 / 夹文字 / 未知工具 / 重复 id / 重复幂等键 / 慢响应', () => {
    const fence = applyChaos(base, history, ids, seq(0.05, 0.9));
    expect(fence.raw.startsWith('```json')).toBe(true);
    expect(() => JSON.parse(fence.raw)).toThrow();

    const prose = applyChaos(base, history, ids, seq(0.12, 0.9));
    expect(prose.kinds).toContain('surrounding_text');
    expect(() => JSON.parse(prose.raw)).toThrow();

    const unknown = JSON.parse(applyChaos(base, history, ids, seq(0.17, 0.9)).raw);
    expect(unknown.content[0].name).toBe('search_web');

    const dup = JSON.parse(applyChaos(base, history, ids, seq(0.22, 0.9)).raw);
    expect(dup.content[0].id).toBe('tu_prev');

    const resend = JSON.parse(applyChaos(base, history, ids, seq(0.26, 0.9)).raw);
    expect(resend.content[0]).toMatchObject({ name: 'send_message', input: { idempotency_key: 'k-1' } });

    const slow = applyChaos(base, history, ids, seq(0.9, 0.01));
    expect(slow.extraDelayMs).toBe(8000);
    expect(JSON.parse(slow.raw)).toEqual(base);
  });
});
