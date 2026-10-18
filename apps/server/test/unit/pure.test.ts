import { describe, expect, it } from 'vitest';
import { TRANSITIONS, isLegalTransition } from '../../src/accounts/states.js';
import { TOOLS, parseAuditResponse, parseTurnResponse, validateToolInput } from '../../src/agent/protocol.js';
import { limitResultContent } from '../../src/agent/runner.js';
import { SseParser, frameToEvent } from '../../src/gateway/sse.js';
import { decodeCursor, encodeCursor } from '../../src/groups/service.js';
import { placeholders, resolveSequence } from '../../src/sequences/resolve.js';

describe('账号转移表（A1）', () => {
  const table: Record<string, string[]> = {
    idle: ['online', 'suspended', 'session_expired'],
    online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
    rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
    disconnected: ['idle', 'online', 'suspended', 'session_expired'],
    suspended: [],
    session_expired: [],
  };
  it('与题目表格一致，同状态到同状态非法', () => {
    expect(TRANSITIONS).toEqual(table);
    for (const s of Object.keys(table)) expect(isLegalTransition(s as any, s as any)).toBe(false);
  });
});

describe('序列占位符解析（B1）', () => {
  const steps = [
    { index: 1, accountRole: 'admin' as const, text: '{event} 将于 {time} 开始', delaySeconds: 1 },
    { index: 2, accountRole: 'member' as const, text: '{event} 资料在 {location}', delaySeconds: 1 },
    { index: 3, accountRole: 'member' as const, text: '{location} / {event}', delaySeconds: 1 },
  ];
  it('placeholders 去重保序', () => {
    expect(placeholders('{a}{b}{a} {c_1} {bad-key}')).toEqual(['a', 'b', 'c_1']);
  });
  it('stepVars 从该步起覆盖；沿用时来源标最初给出的那一步', () => {
    const r = resolveSequence(steps, { event: 'E', time: 'T' }, { '2': { location: 'L2' } });
    expect(r.ok && r.steps.map((s) => s.varSources)).toEqual([
      { event: 'default', time: 'default' },
      { event: 'default', location: 'step:2' },
      { location: 'step:2', event: 'default' },
    ]);
    expect(r.ok && r.steps[2].resolvedText).toBe('L2 / E');
  });
  it('stepVars 里的 "" 表示不改；vars 里的 "" 视为未提供', () => {
    const r = resolveSequence(steps, { event: 'E', time: 'T', location: 'L0' }, { '2': { location: '' } });
    expect(r.ok && r.steps[1].resolvedVars).toEqual({ event: 'E', location: 'L0' });
    expect(resolveSequence(steps, { event: 'E', time: '', location: 'L' }, {})).toEqual({ ok: false, stepIndex: 1, key: 'time' });
  });
  it('第一个解析不到的占位符（按步骤顺序）', () => {
    expect(resolveSequence(steps, { event: 'E', time: 'T' }, {})).toEqual({ ok: false, stepIndex: 2, key: 'location' });
  });
});

describe('Agent 协议校验', () => {
  const toolUse = JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'finish', input: { summary: 's' } }] });
  it('合法响应', () => {
    expect(parseTurnResponse(200, toolUse).kind).toBe('tool_use');
    expect(parseTurnResponse(200, JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }))).toEqual({ kind: 'end_turn', text: 'x' });
  });
  it.each([
    ['非 2xx', 500, toolUse],
    ['markdown 围栏', 200, '```json\n' + toolUse + '\n```'],
    ['前后夹文字', 200, 'Here you go: ' + toolUse],
    ['缺 stop_reason', 200, JSON.stringify({ content: [{ type: 'text', text: 'x' }] })],
    ['两个块', 200, JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })],
    ['stop_reason 与块类型不一致', 200, JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'a' }] })],
  ])('BAD_JSON：%s', (_label, status, body) => {
    expect(parseTurnResponse(status as number, body as string).kind).toBe('bad_json');
  });
  it('工具定义：恰好 4 个，required 覆盖全部入参', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['get_recent_messages', 'send_message', 'kick_user', 'finish']);
    for (const t of TOOLS) {
      const props = Object.keys((t.input_schema as any).properties);
      expect([...(t.input_schema as any).required].sort()).toEqual(props.sort());
    }
  });
  it('入参校验', () => {
    expect(validateToolInput('get_recent_messages', { limit: 100000 })).toBeNull();
    expect(validateToolInput('get_recent_messages', { limit: 'x' })).not.toBeNull();
    expect(validateToolInput('send_message', { text: 'hi' })).not.toBeNull();
    expect(validateToolInput('kick_user', { platform_user_id: 'u', reason: 'r', extra: 1 })).not.toBeNull();
  });
  it('审计：只有合法 JSON 且 verdict 恰为 pass/fail 才算结论', () => {
    expect(parseAuditResponse(200, '{"verdict":"pass"}').verdict).toBe('pass');
    expect(parseAuditResponse(200, '{"verdict":"fail","reason":"x"}').verdict).toBe('fail');
    expect(parseAuditResponse(200, '{"verdict":"PASS"}').verdict).toBeNull();
    expect(parseAuditResponse(200, '{"ok":true}').verdict).toBeNull();
    expect(parseAuditResponse(200, 'pass').verdict).toBeNull();
    expect(parseAuditResponse(500, '{"verdict":"pass"}').verdict).toBeNull();
  });
  it('tool_result content ≤ 8KB，超出截断并置 truncated', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ msgId: `m${i}`, text: 'x'.repeat(500) }));
    const out = limitResultContent({ messages, truncated: false });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8192);
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages[parsed.messages.length - 1].msgId).toBe('m49'); // 保留最新的
  });
});

describe('SSE 解析', () => {
  it('多帧、多行 data、注释、CRLF', () => {
    const frames: any[] = [];
    const p = new SseParser((f) => frames.push(f));
    p.push(': ping\r\nid: 5\r\nevent: message\r\ndata: {"eventId":5,\r\ndata: "type":"message"}\r\n\r\nid: 6\nevent: x\nda');
    p.push('ta: {"eventId":6,"type":"member_joined"}\n\n');
    expect(frames.length).toBe(2);
    expect(frameToEvent(frames[0])).toEqual({ eventId: 5, type: 'message', raw: '{"eventId":5,\n"type":"message"}' });
    expect(frameToEvent(frames[1])?.type).toBe('member_joined');
  });
});

describe('消息游标', () => {
  it('编码 / 解码往返', () => {
    const d = new Date('2026-09-26T08:00:00.123Z');
    expect(decodeCursor(encodeCursor(d, 42))).toEqual({ sentAt: d, id: 42 });
    expect(decodeCursor('garbage')).toBeNull();
  });
});
