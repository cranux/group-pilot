import { describe, expect, it } from 'vitest';
import { createLlmAgent, type ClaudeClient } from '../src/index.js';
import { echoable } from '../src/translate.js';

const TOOLS = [
  { name: 'get_recent_messages', description: 'd', input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: ['limit'] } },
  { name: 'send_message', description: 'd', input_schema: { type: 'object', properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['text', 'idempotency_key'] } },
  { name: 'kick_user', description: 'd', input_schema: { type: 'object', properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } }, required: ['platform_user_id', 'reason'] } },
  { name: 'finish', description: 'd', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

function fakeClient(responses: any[], parsed: any[] = []) {
  const calls: any[] = [];
  const client = {
    beta: { messages: { create: async (params: any) => (calls.push(params), responses.shift()) } },
    messages: { parse: async (params: any) => (calls.push(params), parsed.shift()) },
  } as unknown as ClaudeClient;
  return { client, calls };
}

const ctx = { role: 'user', content: [{ type: 'text', text: '{"groupId":"g","triggerMessages":[]}' }] };

describe('llm-agent', () => {
  it('每轮恰好返回一个块；下一轮把上一轮的完整内容（含 thinking）按 tool_use.id 换回去', async () => {
    const first = {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_recent_messages', input: { limit: 10 } },
      ],
    };
    const second = { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'tool_use', id: 'toolu_2', name: 'finish', input: { summary: 'ok' } }] };
    const { client, calls } = fakeClient([first, second]);
    const app = createLlmAgent({ client });

    const r1 = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'run-1', tools: TOOLS, messages: [ctx] } });
    expect(r1.json()).toEqual({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_recent_messages', input: { limit: 10 } }] });

    const history = [
      ctx,
      { role: 'assistant', content: r1.json().content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"messages":[]}' }] },
    ];
    const r2 = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'run-1', tools: TOOLS, messages: history } });
    expect(r2.json().content[0].name).toBe('finish');
    expect(calls[1].messages[1]).toEqual({ role: 'assistant', content: first.content });
    expect(calls[1].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(calls[1].model).toBe('claude-opus-5-5');
    expect(calls[1].fallbacks).toBe('default');
    // system 与 tools 每轮相同（追加式历史）
    expect(calls[1].system).toBe(calls[0].system);
    await app.close();
  });

  it('end_turn 返回 text；refusal 转成 end_turn 文本', async () => {
    const { client } = fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'done' }] },
      { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] },
    ]);
    const app = createLlmAgent({ client });
    const a = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS, messages: [ctx] } });
    expect(a.json()).toEqual({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
    const b = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r2', tools: TOOLS, messages: [ctx] } });
    expect(b.json().stop_reason).toBe('end_turn');
    expect(b.json().content[0].text).toContain('cyber');
    await app.close();
  });

  it('工具不是恰好 4 个 → 400 TOOLS_INVALID', async () => {
    const app = createLlmAgent({ client: fakeClient([]).client });
    const r = await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r', tools: TOOLS.slice(0, 3), messages: [ctx] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('TOOLS_INVALID');
    await app.close();
  });

  it('audit：结构化输出给出 verdict；refusal 视为 fail', async () => {
    const { client } = fakeClient([], [
      { stop_reason: 'end_turn', parsed_output: { verdict: 'pass', reason: 'fine' } },
      { stop_reason: 'refusal', parsed_output: null },
    ]);
    const app = createLlmAgent({ client });
    expect((await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'hi', groupId: 'g' } })).json()).toEqual({ verdict: 'pass', reason: 'fine' });
    expect((await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'x', groupId: 'g' } })).json().verdict).toBe('fail');
    await app.close();
  });

  it('fallback 之后回放：最后一个 fallback 块之前的非 text 块省略', () => {
    const out = echoable([
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'text', text: 'partial' },
      { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } },
      { type: 'tool_use', id: 't', name: 'finish', input: {} },
    ] as any);
    expect(out.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
  });
});
